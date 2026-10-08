// Page driver for the index page: the composer where a logged-in user shares a
// file or a message, and the list of their shares
// (docs/frontend-test-strategy.md §7a). Uploads go to the protocol fake; the
// DOM layer runs the page with the stub crypto, the JS-integration layer with
// the real crypto.js. The shared-files status refresh is not one of the
// fake's routes, so the driver answers it itself.
import { isInaccessible, within } from '@testing-library/dom';
import { computeAccessibleName } from 'dom-accessibility-api';
import { expect, vi } from 'vitest';
import { initHeroFlow } from '../../../../static/js/hero-flow-page.js';
import { initIndex } from '../../../../static/js/index-page.js';
import { makeProtocolFake } from '../protocol-fake.js';
import { DEFAULT_PASSWORD, cryptoFor, openPage, replaceInFixture, typeable, waitUntil } from './page.js';

export { screen } from './page.js';

/**
 * @typedef {import('../../../../static/js/crypto.js').Bytes} Bytes
 * @typedef {ReturnType<typeof makeProtocolFake>} Fake
 * @typedef {import('./page.js').Page} Page
 */

/** The rows of the with-shares fixture, by name, newest upload first. */
const SHARE_IDS = {
    'Text note · 21:35': '00000000-0000-4000-8000-000000000006',
    'report.pdf': '00000000-0000-4000-8000-000000000001',
    'For the auditor': '00000000-0000-4000-8000-000000000002',
    'photo.png': '00000000-0000-4000-8000-000000000003',
    'old.txt': '00000000-0000-4000-8000-000000000004',
    'locked.zip': '00000000-0000-4000-8000-000000000007',
};

/** When the page is looked at: the day after the fixture's newest upload. */
export const NOW = '2025-01-07T12:00:00+01:00';

/** @typedef {keyof typeof SHARE_IDS} ShareName */

/** Which fixture renders the page for each kind of account. */
const ACCOUNTS = {
    'with-shares': { fixture: 'index--files', user: 'testuser' },
    'no-shares': { fixture: 'index--empty', user: 'testuser' },
    // An account with an email configured, so it may ask to be notified.
    'with-email': { fixture: 'index--notification-email', user: 'notifyuser' },
};

/** Passwords of each strength, as the meter rates them. */
export const PASSWORDS = {
    weak: 'password',
    fair: DEFAULT_PASSWORD,
    // Six EFF words: ~77.5 bits. Distinctive enough that a leak of it into a
    // request can't be a coincidence.
    strong: 'abacus-abdomen-abdominal-abide-abiding-ability',
};

/**
 * How the server meets the next upload, as the protocol fake records app.py
 * answering: busy (rate limit on /upload/begin), failing (a 500 with an HTML
 * body from /upload), too-large (413) and rate-limited (429 on /upload).
 * @typedef {'ok' | 'busy' | 'failing' | 'too-large' | 'rate-limited'} UploadServer
 */

/**
 * @typedef {object} UploadOptions
 * @property {keyof typeof ACCOUNTS} [account]
 * @property {string} [path] - the address, e.g. '/?shared_search=cet'
 * @property {number} [sharesPerPage] - the list's page size (5 as rendered)
 * @property {Array<{ name: ShareName, openedAt: string, openedFrom: string }>} [openedMeanwhile] -
 *   shares opened since the page was rendered, at an ISO time with an offset
 *   (Warsaw's, as the server sends): the status refresh reports them
 * @property {string} [now] - the time the page is looked at (NOW unless given)
 * @property {import('./page.js').ClipboardKind} [clipboard]
 * @property {import('./page.js').CryptoKind} [crypto] - real in the JS-integration layer
 * @property {Fake} [backend] - the server uploads go to, when a test needs one it made
 */

/**
 * @typedef {object} UploadFile
 * @property {string} name
 * @property {Bytes} [bytes]
 */

/**
 * The page's dependencies, recording what it navigates to and alerts.
 * @param {typeof globalThis.fetch} fetch
 * @param {import('../../../../static/js/index-page.js').IndexDeps['crypto']} crypto
 * @param {typeof XMLHttpRequest} xhr
 * @param {number} [now] - epoch milliseconds the page takes for now
 */
function indexDeps(fetch, crypto, xhr, now = Date.parse(NOW)) {
    /** @type {string[]} */
    const navigations = [];
    /** @type {string[]} */
    const alerts = [];
    return {
        navigations,
        alerts,
        deps: {
            fetch,
            XMLHttpRequest: xhr,
            navigate: (/** @type {string} */ url) => { navigations.push(url); },
            alert: (/** @type {string} */ message) => { alerts.push(message); },
            crypto,
            now: () => now,
        },
    };
}

/**
 * Open the landing page an anonymous visitor sees, with both its scripts.
 * @param {{ path?: string, reducedMotion?: boolean }} [options]
 */
export function openLandingPage({ path = '/', reducedMotion = false } = {}) {
    const page = openPage('index--anonymous', { path, reducedMotion });
    const { deps } = indexDeps(async (input) => {
        throw new Error(`the landing page sent ${input}`);
    }, cryptoFor('stub').service, page.window.XMLHttpRequest);
    initIndex(page.window.document, deps);
    initHeroFlow(page.window.document, {});
    const { screen, user } = page;
    const walkthrough = () => screen.getByRole('region', { name: 'How a drop works' });
    return {
        url: page.url,
        historyLength: page.historyLength,
        pauseWalkthrough: () => user.click(screen.getByRole('button', { name: 'Pause walkthrough' })),
        playWalkthrough: () => user.click(screen.getByRole('button', { name: 'Play walkthrough' })),
        pointAtWalkthrough: () => user.hover(walkthrough()),
        moveAwayFromWalkthrough: () => user.unhover(walkthrough()),
    };
}

/**
 * Open the index page as a logged-in user.
 * @param {UploadOptions} [options]
 */
export function openUploadPage({
    account = 'with-shares',
    path = '/',
    sharesPerPage,
    openedMeanwhile = [],
    now = NOW,
    clipboard = 'ok',
    crypto = 'stub',
    backend,
} = {}) {
    const { fixture, user: owner } = ACCOUNTS[account];
    const server = backend ?? makeProtocolFake({ owner });
    const page = openPage(fixture, {
        path,
        clipboard,
        edit: (html) => (sharesPerPage
            ? replaceInFixture(html, 'data-page-size="5"', `data-page-size="${sharesPerPage}"`) : html),
    });
    const { window, screen, user } = page;
    const { service: cryptoService, timeout } = cryptoFor(crypto);

    /** @type {Array<{ file_id: string, h: string }>} */
    const issued = [];
    /** @type {string[][]} */
    const statusChecks = [];
    /** @type {typeof globalThis.fetch} */
    const fetch = async (input, init) => {
        const url = String(input);
        if (url.startsWith('/api/user/files/status?')) {
            const ids = new URLSearchParams(url.split('?')[1]).getAll('id');
            statusChecks.push(ids.map(shareName));
            const files = openedMeanwhile.map(({ name, openedAt, openedFrom }) => ({
                id: SHARE_IDS[name],
                status: 'active',
                status_key: 'downloaded',
                status_display: 'Downloaded',
                downloaded_at: displayTime(openedAt),
                downloaded_at_iso: openedAt,
                downloaded_by_ip: openedFrom,
            }));
            return new window.Response(JSON.stringify({ files }));
        }
        const response = await server.fetch(input, init);
        if (response.ok && url.endsWith('/upload/begin')) issued.push(await response.clone().json());
        return response;
    };
    const { deps, navigations, alerts } = indexDeps(
        fetch, cryptoService, server.XMLHttpRequest, Date.parse(now));
    initIndex(window.document, deps);
    initHeroFlow(window.document, {});

    // Every value the progress bar shows, in order, and whether it was on
    // screen when it did.
    /** @type {Array<{ shown: string, visible: boolean }>} */
    const progress = [];
    const progressBar = screen.queryByRole('progressbar', { hidden: true });
    if (progressBar) {
        new window.MutationObserver((records) => {
            for (const record of records) {
                record.addedNodes.forEach((node) => {
                    progress.push({ shown: node.textContent ?? '', visible: !isInaccessible(progressBar) });
                });
            }
        }).observe(screen.getByText(/^\d+%$/), { childList: true });
    }

    const passwordField = () => screen.getByLabelText('Password');
    const fileField = () => screen.getByLabelText('Drop a file here, or browse');
    /** @param {ShareName} name */
    const shareRow = (name) => screen.getByRole('article', { name });
    /** @param {string} name */
    const toFile = (name, bytes = new Uint8Array([120])) => new window.File([bytes], name);

    /** @param {UploadServer} situation */
    const arrange = (situation) => {
        if (situation === 'busy') server.failNext('/upload/begin', 429);
        if (situation === 'failing') {
            server.failNext('/upload', { status: 500, body: '<!doctype html><title>500 Internal Server Error</title>' });
        }
        if (situation === 'too-large') server.failNext('/upload', 413);
        if (situation === 'rate-limited') server.failNext('/upload', 429);
    };

    const driver = {
        url: page.url,
        historyLength: page.historyLength,
        clipboardText: page.clipboardText,
        backend: server,
        /** What the page sent to the server, in order. */
        requestsSent: () => [...server.log],

        switchToNote: () => user.click(screen.getByRole('tab', { name: 'Text note' })),
        switchToFile: () => user.click(screen.getByRole('tab', { name: 'File' })),
        /** @param {string} text */
        async writeMessage(text) {
            const field = screen.getByLabelText('Secret text');
            await user.clear(field);
            if (text) await user.type(field, typeable(text));
        },
        /** @param {string | UploadFile} file */
        selectFile: (file) => user.upload(fileField(),
            typeof file === 'string' ? toFile(file) : toFile(file.name, file.bytes)),
        /** The names of the files the form would upload. */
        filesChosen: () => Array.from(/** @type {HTMLInputElement} */ (fileField()).files ?? []).map((file) => file.name),
        /**
         * Drag a file onto the dropzone. user-event has no file drag and drop,
         * so this is the drop event a browser fires.
         * @param {string} name
         */
        dropFile(name) {
            const transfer = new window.DataTransfer();
            transfer.items.add(toFile(name));
            // happy-dom's DragEvent ignores a dataTransfer passed to its constructor.
            const drop = new window.DragEvent('drop', { bubbles: true, cancelable: true });
            Object.defineProperty(drop, 'dataTransfer', { value: transfer });
            screen.getByText(/^Drop a file here/).dispatchEvent(drop);
        },
        /** @param {string | { strength: keyof typeof PASSWORDS }} password */
        async enterPassword(password) {
            const text = typeof password === 'string' ? password : PASSWORDS[password.strength];
            await user.clear(passwordField());
            if (text) await user.type(passwordField(), typeable(text));
        },
        clearPassword: () => user.clear(passwordField()),
        generatePassword: () => user.click(screen.getByRole('button', { name: 'Generate' })),
        copyPassword: () => user.click(screen.getByRole('button', { name: 'Copy password' })),
        showPassword: () => user.click(screen.getByRole('button', { name: 'Show password' })),
        hidePassword: () => user.click(screen.getByRole('button', { name: 'Hide password' })),
        /**
         * How full the strength meter's bar is drawn, e.g. '68%'. The width is
         * visual, so it is read from the meter that carries it for the bar
         * (jest-dom's toHaveStyle can't check a custom property).
         */
        strengthBarFill: () => window.getComputedStyle(screen.getByRole('meter', { name: 'Password strength' }))
            .getPropertyValue('--strength-fill'),
        /**
         * The optional share settings.
         * @param {{ expiry?: string, privateNote?: string, notify?: boolean }} options
         */
        async setShareOptions({ expiry, privateNote, notify }) {
            if (expiry !== undefined) await user.type(screen.getByLabelText(/^Expiry date/), expiry);
            if (privateNote !== undefined) await user.type(screen.getByLabelText(/^Private note/), typeable(privateNote));
            if (notify) await user.click(screen.getByRole('checkbox', { name: /^Notify me when this is opened/ }));
        },
        /**
         * Press the share button and wait for the outcome: the page leaves for
         * the success page, alerts, or refuses the input inline (a missing
         * file, note or password, or a weak password).
         * @param {{ server?: UploadServer }} [options]
         */
        async share({ server: situation = 'ok' } = {}) {
            arrange(situation);
            const outcomes = navigations.length + alerts.length;
            await user.click(screen.getByRole('button', { name: /^Share (file|note)$/ }));
            await waitUntil(() => expect(navigations.length + alerts.length > outcomes
                || screen.queryAllByRole('alert').some((region) => region.textContent?.trim())).toBe(true), timeout);
        },
        /**
         * Choose a file, enter the password and share it.
         * @param {string | UploadFile} file
         * @param {string} [password]
         * @param {{ server?: UploadServer }} [options]
         */
        async shareFile(file, password = PASSWORDS.strong, options) {
            await driver.switchToFile();
            await driver.selectFile(file);
            await driver.enterPassword(password);
            await driver.share(options);
        },
        /**
         * Write a message, enter the password and share it.
         * @param {string} text
         * @param {string} [password]
         * @param {{ server?: UploadServer }} [options]
         */
        async shareMessage(text, password = PASSWORDS.strong, options) {
            await driver.switchToNote();
            await driver.writeMessage(text);
            await driver.enterPassword(password);
            await driver.share(options);
        },
        /**
         * Press a key where the focus is. 'handled' when the page took the
         * key over (cancelling what the browser would do with it, such as
         * scrolling), 'ignored' otherwise.
         * @param {string} key - a key name such as 'ArrowRight', or a character
         * @returns {Promise<'handled' | 'ignored'>}
         */
        async press(key) {
            let handled = false;
            // On the window, this runs after the page's own listeners.
            const listener = (/** @type {Event} */ event) => { handled = event.defaultPrevented; };
            window.addEventListener('keydown', listener);
            await user.keyboard(key.length === 1 ? key : `{${key}}`);
            window.removeEventListener('keydown', listener);
            return handled ? 'handled' : 'ignored';
        },

        /** @param {string} text */
        async searchShares(text) {
            const field = screen.getByRole('searchbox', { name: 'Quick search' });
            await user.clear(field);
            await user.type(field, typeable(text));
        },
        /** @param {string} order - the option as the menu shows it */
        sortSharesBy: (order) => user.selectOptions(screen.getByRole('combobox', { name: 'Sort by' }), order),
        nextSharesPage: () => user.click(screen.getByRole('button', { name: 'Next' })),
        previousSharesPage: () => user.click(screen.getByRole('button', { name: 'Previous' })),
        /** The names of the shares on screen, in order. */
        sharesShown: () => screen.queryAllByRole('article').map((/** @type {HTMLElement} */ row) => computeAccessibleName(row)),
        /** @param {ShareName} name */
        copyShareLink: (name) => user.click(
            within(shareRow(name)).getByRole('button', { name: `Copy link for ${name}` })),

        /**
         * Press Delete on a share and answer the confirmation.
         * @param {ShareName} name
         * @param {{ confirm: boolean }} answer
         * @returns {Promise<{ asked: string[], deleted: boolean }>}
         */
        async deleteShare(name, { confirm }) {
            /** @type {string[]} */
            const asked = [];
            window.confirm = (message) => {
                asked.push(String(message));
                return confirm;
            };
            const before = page.formsSubmitted().length;
            await user.click(within(shareRow(name)).getByRole('button', { name: 'Delete' }));
            return { asked, deleted: page.formsSubmitted().length > before };
        },
        /** The shares each status refresh asked about, by name. */
        statusChecks: () => statusChecks.map((names) => [...names]),

        /** Where the page went after an upload. */
        navigatedTo: () => [...navigations],
        alerts: () => [...alerts],
        /** The shares /upload/begin issued, in order. */
        sharesIssued: () => [...issued],
        progressShown: () => [...progress],
        storage: page.storage,
    };
    return driver;
}

/**
 * @param {string} id
 * @returns {string}
 */
function shareName(id) {
    const entry = Object.entries(SHARE_IDS).find(([, shareId]) => shareId === id);
    return entry ? entry[0] : id;
}

/**
 * An ISO time with Warsaw's offset as the server displays it, e.g.
 * '2025-01-07T10:00:00+01:00' -> '2025-01-07 10:00:00 CET'.
 * @param {string} iso
 */
function displayTime(iso) {
    return `${iso.slice(0, 19).replace('T', ' ')} ${iso.endsWith('+02:00') ? 'CEST' : 'CET'}`;
}
