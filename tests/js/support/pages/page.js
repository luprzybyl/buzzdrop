// The core every page driver builds on (docs/frontend-test-strategy.md §7a):
// one rendered fixture in its own happy-dom window, Testing Library queries
// bound to it, a user-event session acting in it, and the effects a test
// can't see on screen (the address, the clipboard, forms that would have
// navigated). Drivers find elements the way tests do — by role, label or
// text — never by id, class or selector.
import { within } from '@testing-library/dom';
import { userEvent } from '@testing-library/user-event';
import { vi } from 'vitest';
import * as shareCrypto from '../../../../static/js/lib/crypto.js';
import { browserView, loadFixture } from '../dom-fixture.js';
import { makeStubCrypto } from '../stub-crypto.js';

/** The origin every fixture is served from. */
export const ORIGIN = 'http://localhost';

/** The share password when a test doesn't name one. */
export const DEFAULT_PASSWORD = 'correct horse';

/**
 * How long a driver waits for a step that runs the real lib/crypto.js, whose
 * 600k-iteration PBKDF2 runs on every seal and every password attempt.
 */
export const REAL_CRYPTO_TIMEOUT = 15_000;

/**
 * Which crypto a page runs: the stub in the DOM layer, the real lib/crypto.js in
 * the JS-integration layer.
 * @typedef {'stub' | 'real'} CryptoKind
 */

/**
 * The crypto service for `kind`, and how long a driver waits for a step that
 * runs it.
 * @param {CryptoKind} kind
 * @param {import('../stub-crypto.js').StubCryptoOptions} [stubOptions]
 * @returns {{ service: import('../../../../static/js/lib/crypto.js').ShareCrypto, timeout: number }}
 */
export function cryptoFor(kind, stubOptions) {
    return kind === 'real'
        ? { service: shareCrypto, timeout: REAL_CRYPTO_TIMEOUT }
        : { service: makeStubCrypto(stubOptions), timeout: 1000 };
}

/**
 * What an address carries after its path: a one-click link has the password
 * in its fragment; a mangled one has a fragment that isn't valid
 * percent-encoding.
 * @typedef {'plain' | 'one-click' | 'mangled'} LinkKind
 */

/**
 * @typedef {object} AddressOptions
 * @property {LinkKind} [link]
 * @property {string} [password] - the password a one-click link carries
 * @property {string} [query] - a query string the address carries, e.g. 'x=1'
 */

/**
 * The address a page is opened at.
 * @param {string} path
 * @param {AddressOptions} [options]
 */
export function addressOf(path, { link = 'plain', password = DEFAULT_PASSWORD, query } = {}) {
    const fragment = { plain: '', 'one-click': `#${encodeURIComponent(password)}`, mangled: '#%ZZ' }[link];
    return `${path}${query ? `?${query}` : ''}${fragment}`;
}

/**
 * Testing Library's queries, bound to one page's body.
 * @typedef {import('@testing-library/dom').BoundFunctions<typeof import('@testing-library/dom').queries>} Screen
 */

/**
 * A form submission the page let through: in a browser it would navigate.
 * @typedef {object} FormSubmission
 * @property {string} action
 * @property {string} method
 */

/**
 * @typedef {object} Page
 * @property {Window & typeof globalThis} window
 * @property {Screen} screen
 * @property {import('@testing-library/user-event').UserEvent} user
 * @property {() => string} url - the address bar
 * @property {() => number} historyLength
 * @property {() => Promise<string>} clipboardText
 * @property {() => FormSubmission[]} formsSubmitted
 * @property {() => StorageUse} storage
 */

/**
 * What the page put in the browser's storage.
 * @typedef {object} StorageUse
 * @property {number} writes - setItem calls, on either storage
 * @property {number} localStorage - items held
 * @property {number} sessionStorage - items held
 */

/**
 * @typedef {object} PageOptions
 * @property {string} [path] - the address, relative to ORIGIN
 * @property {boolean} [reducedMotion] - the visitor prefers reduced motion
 * @property {(html: string) => string} [edit] - what the server would render differently
 * @property {ClipboardKind} [clipboard]
 */

/**
 * The Clipboard API the page finds. blocked: the browser refuses clipboard
 * access; unavailable: no Clipboard API at all (a non-secure context).
 * @typedef {'ok' | 'blocked' | 'unavailable'} ClipboardKind
 */

/** @type {import('happy-dom').Window[]} */
let openWindows = [];
/** @type {Page | undefined} */
let currentPage;

/**
 * Close every page opened since the last call (the setup file runs this
 * after each test).
 */
export async function closePages() {
    const windows = openWindows;
    openWindows = [];
    currentPage = undefined;
    await Promise.all(windows.map((window) => window.happyDOM.close()));
}

/**
 * Open a rendered template fixture as a fresh page. The page's own script is
 * the driver's to start.
 * @param {string} fixture - a tests/js/fixtures/html/<fixture>.html name
 * @param {PageOptions} [options]
 * @returns {Page}
 */
export function openPage(fixture, { path = '/', reducedMotion = false, edit, clipboard = 'ok' } = {}) {
    const happyWindow = loadFixture(
        fixture,
        reducedMotion ? { device: { prefersReducedMotion: 'reduce' } } : {},
        new URL(path, ORIGIN).href,
        edit,
    );
    openWindows.push(happyWindow);
    const window = browserView(happyWindow);
    const { document } = window;

    // A submission the page didn't cancel would navigate. It is recorded, then
    // stopped, as there is no server to navigate to; listening on the window
    // runs after every listener the page put on the form.
    /** @type {FormSubmission[]} */
    const submitted = [];
    window.addEventListener('submit', (event) => {
        const form = /** @type {HTMLFormElement} */ (event.target);
        if (!event.defaultPrevented) submitted.push({ action: form.action, method: form.method });
        event.preventDefault();
    });

    // No delay between keystrokes, so typing works under fake timers too.
    // Setup also gives the page a clipboard the test can read, so it comes
    // before anything below that holds or changes the clipboard.
    const user = userEvent.setup({ document, delay: null });

    // The system clipboard, held before the page's view of it is changed
    // below: a copy by selection reaches it either way, and tests read it.
    const systemClipboard = window.navigator.clipboard;
    const writeToSystemClipboard = systemClipboard.writeText.bind(systemClipboard);

    // happy-dom has no copy command. This one copies the selection of the
    // input selected last into the clipboard, which is all the pages use it
    // for (happy-dom's select() doesn't focus, so the selection is tracked).
    /** @type {HTMLInputElement | null} */
    let selected = null;
    const select = window.HTMLInputElement.prototype.select;
    window.HTMLInputElement.prototype.select = function () {
        selected = this;
        return select.call(this);
    };
    document.execCommand = (command) => {
        if (command !== 'copy' || !selected) return false;
        const { value, selectionStart, selectionEnd } = selected;
        void writeToSystemClipboard(value.substring(selectionStart ?? 0, selectionEnd ?? value.length));
        return true;
    };

    if (clipboard === 'blocked') {
        vi.spyOn(systemClipboard, 'writeText').mockRejectedValue(new Error('denied'));
    } else if (clipboard === 'unavailable') {
        // lib.dom types navigator.clipboard as always present; a non-secure context lacks it.
        vi.spyOn(window.navigator, 'clipboard', 'get').mockReturnValue(/** @type {any} */ (undefined));
    }

    const setItem = vi.spyOn(window.Storage.prototype, 'setItem');

    /** @type {Page} */
    const page = {
        window,
        screen: within(document.body),
        user,
        url: () => window.location.href,
        historyLength: () => window.history.length,
        clipboardText: () => systemClipboard.readText(),
        formsSubmitted: () => [...submitted],
        storage: () => ({
            writes: setItem.mock.calls.length,
            localStorage: window.localStorage.length,
            sessionStorage: window.sessionStorage.length,
        }),
    };
    currentPage = page;
    return page;
}

/**
 * Testing Library's queries on the page opened last, like its own `screen`
 * (which is bound to the global document, not to a fixture's window).
 * @type {Screen}
 */
export const screen = /** @type {Screen} */ (new Proxy({}, {
    get(_, name) {
        if (!currentPage) throw new Error('no page is open; open one with a page driver first');
        return Reflect.get(currentPage.screen, name);
    },
}));

/**
 * Wait until `check` stops throwing. Long timeouts are for the real PBKDF2 of
 * the integration layer.
 * @param {() => void} check
 * @param {number} [timeout]
 */
export function waitUntil(check, timeout = 1000) {
    return vi.waitFor(check, { timeout, interval: 20 });
}

/**
 * Text as user-event types it literally: `{` and `[` start key names there.
 * @param {string} text
 */
export function typeable(text) {
    return text.replace(/[{[]/g, (bracket) => bracket + bracket);
}

/**
 * Replace every occurrence of `search` in a fixture's HTML. Throws when there
 * is none, so a template change can't turn a fixture edit into a no-op.
 * @param {string} html
 * @param {string} search
 * @param {string} replacement
 */
export function replaceInFixture(html, search, replacement) {
    if (!html.includes(search)) throw new Error(`fixture edit: "${search}" is not in the fixture`);
    return html.replaceAll(search, replacement);
}
