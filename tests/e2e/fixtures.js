// The always-on security invariants (docs/frontend-test-strategy.md §7).
// Every E2E test imports `test` from here, so every test in every browser
// runs under the guard:
// - no request URL, header or body, and no cookie, may contain a password
//   the test drew from `sharePassword`;
// - after the test, no page may hold anything in localStorage or
//   sessionStorage (H, or anything else, persisted client-side).
// The guard covers the default context and every context the test opens
// with browser.newContext() or browser.newPage().
import { randomBytes } from 'node:crypto';
import { test as base, expect } from '@playwright/test';

/** @typedef {import('@playwright/test').BrowserContext} BrowserContext */
/** @typedef {import('@playwright/test').Request} Request */

/**
 * @typedef {object} GuardFixtures
 * @property {() => string} sharePassword - a fresh share password the guard
 *   watches for; draw every password a test types from here, wrong ones too
 * @property {string[]} drawnPasswords - every password sharePassword handed out
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
 * The headers are the ones the page set: the raw ones the browser added
 * (allHeaders) only arrive with a response, which a stalled request never
 * gets. The one browser-added header a page can steer, Cookie, is covered by
 * the cookie check at the end of the test.
 * @param {Request} request
 * @returns {SentRequest}
 */
function record(request) {
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
 * What the context's open pages hold in Web Storage, as "page: storage key"
 * lines.
 * @param {BrowserContext} context
 * @returns {Promise<string[]>}
 */
async function storedItems(context) {
    const items = [];
    for (const page of context.pages()) {
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
        items.push(...held.map((item) => `${page.url()}: ${item}`));
    }
    return items;
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

    invariantGuard: [async ({ browser, context, drawnPasswords }, use) => {
        /** @type {SentRequest[]} */
        const sent = [];
        /** @type {string[]} */
        const stored = [];
        /** @type {string[]} */
        const cookies = [];
        /** @type {Set<BrowserContext>} */
        const open = new Set();

        /** @param {BrowserContext} watched */
        const inspect = async (watched) => {
            stored.push(...await storedItems(watched));
            cookies.push(...(await watched.cookies()).map(({ name, value }) => `${name}=${value}`));
        };

        // A context the test closes itself is inspected first, while its
        // pages and cookies are still there.
        /** @param {BrowserContext} watched */
        const watch = (watched) => {
            open.add(watched);
            watched.on('request', (request) => {
                sent.push(record(request));
            });
            const close = watched.close.bind(watched);
            watched.close = async (options) => {
                if (open.delete(watched)) await inspect(watched);
                return close(options);
            };
        };

        watch(context);
        // browser.newPage() goes through newContext() too.
        const newContext = browser.newContext;
        /** @param {import('@playwright/test').BrowserContextOptions} [options] */
        browser.newContext = async (options) => {
            const created = await newContext.call(browser, options);
            watch(created);
            return created;
        };

        try {
            await use();
        } finally {
            browser.newContext = newContext;
        }

        for (const watched of open) await inspect(watched);
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
