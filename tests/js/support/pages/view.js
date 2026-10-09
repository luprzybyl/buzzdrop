// Page driver for the view page: the recipient's password step
// (docs/frontend-test-strategy.md §7a). The share sits on the protocol fake,
// which answers every request the page sends, so each server situation is
// produced by the fake's own state. The DOM layer runs it with the stub
// crypto, the JS-integration layer with the real crypto.js.
import { expect, vi } from 'vitest';
import { bytesToHex } from '../../../../static/js/lib/hex.js';
import { initView } from '../../../../static/js/pages/view/view-page.js';
import { makeProtocolFake } from '../protocol-fake.js';
import { DEFAULT_PASSWORD, addressOf, cryptoFor, openPage, replaceInFixture, typeable, waitUntil } from './page.js';

export { DEFAULT_PASSWORD, screen } from './page.js';

/**
 * @typedef {import('../../../../static/js/lib/crypto.js').Bytes} Bytes
 * @typedef {ReturnType<typeof makeProtocolFake>} Fake
 * @typedef {Fake['log'][number]} LoggedRequest
 * @typedef {import('./page.js').Page} Page
 */

/** The share each fixture was rendered for. */
const FIXTURES = {
    file: { fixture: 'view--file', fileId: '00000000-0000-4000-8000-0000000000f1' },
    message: { fixture: 'view--text', fileId: '00000000-0000-4000-8000-0000000000f2' },
};

/** What a share holds when a test doesn't say. */
export const DEFAULT_MESSAGE = 'meet at the hive at noon';

/** A verifier no password derives, for someone else's wrong guesses. */
const WRONG_VERIFIER = 'f'.repeat(64);

/**
 * @typedef {object} ShareOptions
 * @property {'file' | 'message'} [type]
 * @property {import('./page.js').LinkKind} [link]
 * @property {string} [query] - a query string the link carries, e.g. 'x=1'
 * @property {string} [password] - the share's password
 * @property {string | Bytes} [content] - what was shared
 * @property {'done' | 'in-progress'} [download] - in-progress holds the
 *   download until finishDownload()
 * @property {'ok' | 'unsupported-format' | 'corrupted'} [share] - DOM layer only
 * @property {'ok' | 'claimed' | 'burned' | 'error' | 'unreachable'} [server] -
 *   claimed: someone already decrypted it; burned: someone's wrong guesses
 *   locked it and the server destroyed its key share; error: the server
 *   fails the release; unreachable: the release never arrives
 * @property {number} [maxAttempts] - wrong passwords allowed before the share
 *   locks (KEY_RELEASE_MAX_ATTEMPTS, 1 like the server's default)
 * @property {import('./page.js').CryptoKind} [crypto] - real in the JS-integration layer
 * @property {import('./page.js').ClipboardKind} [clipboard]
 * @property {{ backend: Fake, fileId: string }} [uploaded] - open a share
 *   already uploaded to this server, instead of a new one
 */

/**
 * @typedef {object} SavedFile
 * @property {string} name
 * @property {Bytes} bytes
 */

/**
 * @typedef {object} ShareView
 * @property {Page['url']} url
 * @property {Page['historyLength']} historyLength
 * @property {Page['clipboardText']} clipboardText
 * @property {Page['formsSubmitted']} formsSubmitted
 * @property {Page['storage']} storage
 * @property {(password: string) => Promise<void>} decryptWithPassword - type it, press Decrypt, wait for the outcome
 * @property {(password: string) => Promise<void>} decryptWithEnter - type it, press Enter, wait for the outcome
 * @property {() => Promise<void>} copyMessage
 * @property {() => Promise<void>} finishDownload - let a held download arrive
 * @property {() => Promise<SavedFile>} savedFile - the one file the page saved
 * @property {() => Array<{ success: boolean, receipt: string | null }>} reportsSent - decryption reports, as sent
 * @property {() => Promise<boolean | null>} decryptionRecorded - what the server recorded, once the report lands
 * @property {() => LoggedRequest[]} requestsSent - what the page sent, in order
 * @property {Fake} backend - the server, for checks on its state
 * @property {string} fileId
 */

/**
 * Open a share's view page, the way the confirm page lands on it, and wait
 * until it is ready for a password (or, with download: 'in-progress', until
 * it is waiting for the share).
 * @param {ShareOptions} [options]
 * @returns {Promise<ShareView>}
 */
export async function openShare({
    type = 'message',
    link = 'plain',
    query,
    password = DEFAULT_PASSWORD,
    content = DEFAULT_MESSAGE,
    download = 'done',
    share = 'ok',
    server = 'ok',
    maxAttempts = 1,
    crypto = 'stub',
    clipboard = 'ok',
    uploaded,
} = {}) {
    const { service: cryptoService, timeout } = cryptoFor(crypto,
        { unsupportedFormat: share === 'unsupported-format', corrupted: share === 'corrupted' });
    const backend = uploaded?.backend ?? makeProtocolFake({ maxAttempts });
    const fileId = uploaded?.fileId ?? await backend.seedShare({ password, plaintext: content }, cryptoService);
    await arrange(backend, fileId, server, cryptoService, password, maxAttempts);
    // Only what the page sends from here on is its own.
    const logStart = backend.log.length;

    const { fixture, fileId: fixtureId } = FIXTURES[type];
    const page = openPage(fixture, {
        path: addressOf(`/view/${fileId}/confirm`, { link, password, query }),
        clipboard,
        // As the server renders it for this share.
        edit: (html) => replaceInFixture(replaceInFixture(html, fixtureId, fileId),
            'You have one attempt', maxAttempts === 1 ? 'You have one attempt' : `You have ${maxAttempts} attempts`),
    });
    const { window, screen, user } = page;

    /** @type {() => void} */
    let finishDownload = () => {};
    const downloaded = new Promise((resolve) => { finishDownload = () => resolve(undefined); });
    if (download === 'done') finishDownload();
    /** @type {typeof globalThis.fetch} */
    const fetch = async (input, init) => {
        if (String(input).startsWith('/download/')) await downloaded;
        return backend.fetch(input, init);
    };

    // A file reaches the visitor as a Blob URL on a link the page clicks.
    /** @type {Map<string, Blob>} */
    const blobs = new Map();
    const createObjectURL = URL.createObjectURL.bind(URL);
    vi.spyOn(URL, 'createObjectURL').mockImplementation((object) => {
        const url = createObjectURL(object);
        if (object instanceof Blob) blobs.set(url, object);
        return url;
    });
    /** @type {Array<{ name: string, blob: Blob | undefined }>} */
    const saved = [];
    vi.spyOn(window.HTMLAnchorElement.prototype, 'click').mockImplementation(/** @this {HTMLAnchorElement} */ function () {
        saved.push({ name: this.download, blob: blobs.get(this.href) });
    });

    const ready = initView(window.document, { fetch, crypto: cryptoService });
    if (download === 'done') await ready;

    const status = () => screen.getByRole('status');
    const passwordField = () => screen.getByLabelText('Password');
    const decryptButton = () => screen.getByRole('button', { name: /^Decrypt and / });

    /**
     * Try a password and wait until the status line reports the outcome. It
     * waits for the page to write the line, not for different text, so an
     * outcome worded like the one before still counts.
     * @param {(field: HTMLElement) => Promise<void>} submit
     */
    const attempt = async (submit) => {
        let reported = false;
        const observer = new window.MutationObserver(() => { reported = true; });
        observer.observe(status(), { childList: true, characterData: true, subtree: true });
        try {
            const field = passwordField();
            await user.clear(field);
            await submit(field);
            await waitUntil(() => expect(reported).toBe(true), timeout);
        } finally {
            observer.disconnect();
        }
    };

    return {
        url: page.url,
        historyLength: page.historyLength,
        clipboardText: page.clipboardText,
        formsSubmitted: page.formsSubmitted,
        storage: page.storage,
        decryptWithPassword: (password) => attempt(async (field) => {
            await user.type(field, typeable(password));
            await user.click(decryptButton());
        }),
        decryptWithEnter: (password) => attempt(async (field) => {
            await user.type(field, `${typeable(password)}{Enter}`);
        }),
        copyMessage: () => user.click(screen.getByRole('button', { name: 'Copy text' })),
        async finishDownload() {
            finishDownload();
            await ready;
        },
        async savedFile() {
            if (saved.length !== 1) throw new Error(`the page saved ${saved.length} files, not one`);
            const [{ name, blob }] = saved;
            if (!blob) throw new Error('the page saved a link that is not one of its Blobs');
            return { name, bytes: new Uint8Array(await blob.arrayBuffer()) };
        },
        reportsSent: () => backend.log.slice(logStart)
            .filter((request) => new URL(request.url).pathname.startsWith('/report_decryption/'))
            .map((request) => JSON.parse(String(request.body))),
        async decryptionRecorded() {
            await waitUntil(() => expect(backend.state.files.get(fileId)?.decryptionSuccess).not.toBeNull(), timeout);
            return backend.state.files.get(fileId)?.decryptionSuccess ?? null;
        },
        requestsSent: () => backend.log.slice(logStart),
        backend,
        fileId,
    };
}

/**
 * Put the share into the situation the test names, through the fake's own
 * routes, as other visitors or a failing server would.
 * @param {Fake} backend
 * @param {string} fileId
 * @param {NonNullable<ShareOptions['server']>} server
 * @param {Pick<import('../../../../static/js/lib/crypto.js').ShareCrypto, 'open'>} cryptoService
 * @param {string} password
 * @param {number} maxAttempts
 */
async function arrange(backend, fileId, server, cryptoService, password, maxAttempts) {
    /** @param {string} v */
    const release = (v) => backend.handle({
        method: 'POST',
        url: `/release/${fileId}`,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ v }),
    });
    if (server === 'claimed') {
        const blob = /** @type {Bytes} */ (backend.state.files.get(fileId)?.blob);
        const { verifier } = await cryptoService.open(blob).unlock(password);
        await release(bytesToHex(verifier));
    } else if (server === 'burned') {
        for (let i = 0; i < maxAttempts; i += 1) await release(WRONG_VERIFIER);
    } else if (server === 'error') {
        backend.failNext('/release', { status: 500, body: { error: 'Internal error' } });
    } else if (server === 'unreachable') {
        backend.failNext('/release', 'network');
    }
}
