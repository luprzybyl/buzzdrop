// The always-on security invariants (docs/frontend-test-strategy.md §7).
// Every E2E test imports `test` from here, so every test in every browser
// runs under the guard:
// - no request URL, header or body, and no cookie, may contain a password
//   the test drew from `sharePassword`;
// - no page may hold anything in localStorage or sessionStorage (H, or
//   anything else, persisted client-side) when it closes or the test ends.
// The guard covers the default context and every context the test opens
// with browser.newContext() or browser.newPage(). Calls a test makes itself
// through page.request are not browser traffic and are not watched.
import { randomBytes } from 'node:crypto';
import { test as base, expect } from '@playwright/test';

/** @typedef {import('@playwright/test').BrowserContext} BrowserContext */
/** @typedef {import('@playwright/test').Page} Page */
/** @typedef {import('@playwright/test').Request} Request */

/**
 * @typedef {object} GuardFixtures
 * @property {() => string} sharePassword - a fresh share password the guard
 *   watches for; draw every password a test types from here, wrong ones too
 * @property {string[]} drawnPasswords - every password sharePassword handed out
 * @property {Page} recipient - a page in a fresh context with no session, as
 *   a recipient opening a share link
 * @property {void} invariantGuard
 */

/**
 * A request as it went on the wire, kept for the check at the end of the test.
 * @typedef {object} SentRequest
 * @property {string} label
 * @property {string} url
 * @property {string[]} headers
 * @property {Buffer | null} body
 */

/**
 * The URL as it goes on the wire: browsers never send the fragment, and a
 * one-click link carries the password there by design.
 * @param {string} url
 * @returns {string}
 */
function wireUrl(url) {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.href;
}

/**
 * The headers are the ones the page set. The one browser-added header a page
 * can steer, Cookie, is covered by the cookie check at the end of the test.
 * @param {Request} request
 * @returns {SentRequest}
 */
function recordRequest(request) {
    const url = wireUrl(request.url());
    return {
        label: `${request.method()} ${url}`,
        url,
        headers: Object.entries(request.headers()).map(([name, value]) => `${name}: ${value}`),
        body: request.postDataBuffer(),
    };
}

/**
 * Where in the request a password shows up, if anywhere.
 * @param {SentRequest} request
 * @param {string[]} passwords
 * @returns {string[]}
 */
function findPasswords(request, passwords) {
    const leaks = [];
    for (const password of passwords) {
        if (request.url.includes(password)) leaks.push(`${request.label}: password in the URL`);
        for (const header of request.headers) {
            if (header.includes(password)) leaks.push(`${request.label}: password in header ${header.split(':')[0]}`);
        }
        if (request.body?.includes(password)) leaks.push(`${request.label}: password in the body`);
    }
    return leaks;
}

/**
 * What the page holds in Web Storage, as "page: storage key" lines.
 * @param {Page} page
 * @returns {Promise<string[]>}
 */
async function storedItems(page) {
    const held = await page.evaluate(() => {
        /** @param {Storage} storage */
        const keys = (storage) => Array.from({ length: storage.length }, (_, i) => storage.key(i));
        try {
            return [
                ...keys(window.localStorage).map((key) => `localStorage ${key}`),
                ...keys(window.sessionStorage).map((key) => `sessionStorage ${key}`),
            ];
        } catch {
            // An opaque origin (about:blank) has no storage to hold anything.
            return [];
        }
    });
    return held.map((item) => `${page.url()}: ${item}`);
}

/**
 * @typedef {import('@playwright/test').PlaywrightTestArgs & import('@playwright/test').PlaywrightTestOptions} TestArgs
 * @typedef {import('@playwright/test').PlaywrightWorkerArgs & import('@playwright/test').PlaywrightWorkerOptions} WorkerArgs
 */

/** @type {import('@playwright/test').Fixtures<GuardFixtures, {}, TestArgs, WorkerArgs>} */
const guardFixtures = {
    drawnPasswords: async ({}, use) => {
        await use([]);
    },

    // Passwords are lowercase letters, digits and dashes, which URL, form and
    // JSON encoding all leave as they are, so a plain substring search finds
    // them wherever the browser puts them.
    sharePassword: async ({ drawnPasswords }, use) => {
        await use(() => {
            const password = `amber-orchard-${randomBytes(6).toString('hex')}-velvet-comet`;
            drawnPasswords.push(password);
            return password;
        });
    },

    // Set up after the guard, so it closes first, through the guard's checks.
    recipient: async ({ browser }, use) => {
        const context = await browser.newContext();
        // Downloads live until their context closes.
        await use(await context.newPage());
        await context.close();
    },

    invariantGuard: [async ({ browser, browserName, context, drawnPasswords }, use) => {
        /** @type {SentRequest[]} */
        const sent = [];
        /** @type {string[]} */
        const stored = [];
        /** @type {string[]} */
        const cookies = [];
        /** @type {Set<BrowserContext>} */
        const openContexts = new Set();
        /** @type {Set<Page>} */
        const openPages = new Set();

        /** @param {Page} page */
        const inspectPage = async (page) => {
            if (openPages.delete(page)) stored.push(...await storedItems(page));
        };

        /** @param {BrowserContext} watched */
        const inspectContext = async (watched) => {
            if (!openContexts.delete(watched)) return;
            for (const page of watched.pages()) await inspectPage(page);
            cookies.push(...(await watched.cookies()).map(({ name, value }) => `${name}=${value}`));
        };

        // A page or context the test closes itself is inspected first, while
        // its storage and cookies are still there.
        /** @param {Page} page */
        const watchPage = (page) => {
            openPages.add(page);
            const close = page.close.bind(page);
            page.close = async (options) => {
                await inspectPage(page);
                return close(options);
            };
        };

        /** @param {BrowserContext} watched */
        const watchContext = async (watched) => {
            openContexts.add(watched);
            watched.pages().forEach(watchPage);
            watched.on('page', watchPage);
            // Each browser shows the guard a multipart body with a file part
            // differently. Chromium's request event leaves the body out, so
            // Chromium requests are intercepted, and fallback() hands them on
            // untouched to a test's own page.route() mocks or the network.
            // WebKit sometimes sends such a body truncated when intercepted;
            // its request event carries the form fields, as Firefox's does.
            if (browserName === 'chromium') {
                await watched.route('**/*', async (route) => {
                    sent.push(recordRequest(route.request()));
                    await route.fallback();
                });
            } else {
                watched.on('request', (request) => {
                    sent.push(recordRequest(request));
                });
            }
            const close = watched.close.bind(watched);
            watched.close = async (options) => {
                await inspectContext(watched);
                return close(options);
            };
        };

        await watchContext(context);
        // browser.newPage() goes through newContext() too.
        const newContext = browser.newContext;
        /** @param {import('@playwright/test').BrowserContextOptions} [options] */
        browser.newContext = async (options) => {
            const created = await newContext.call(browser, options);
            await watchContext(created);
            return created;
        };

        try {
            await use();
        } finally {
            browser.newContext = newContext;
        }

        for (const watched of [...openContexts]) await inspectContext(watched);
        const leaks = sent.flatMap((request) => findPasswords(request, drawnPasswords));
        for (const cookie of cookies) {
            if (drawnPasswords.some((password) => cookie.includes(password))) {
                leaks.push(`cookie ${cookie.split('=')[0]}: password in a cookie`);
            }
        }
        expect(leaks, 'the password must never reach the server').toEqual([]);
        expect(stored, 'nothing may be left in localStorage or sessionStorage').toEqual([]);
    }, { auto: true }],
};

// tsc can't infer extend's type arguments from JSDoc, so name the result.
/** @type {import('@playwright/test').TestType<TestArgs & GuardFixtures, WorkerArgs>} */
export const test = base.extend(/** @type {any} */ (guardFixtures));

export { expect };
