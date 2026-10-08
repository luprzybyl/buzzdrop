// Page driver for the view page: the recipient's password step
// (docs/frontend-test-strategy.md §7a). The share sits on the protocol fake,
// which answers every request the page sends, so each server situation is
// produced by the fake's own state. The DOM layer runs it with the stub
// crypto, the JS-integration layer with the real crypto.js.
import { expect, vi } from 'vitest';
import { bytesToHex } from '../../../../static/js/crypto.js';
import { initView } from '../../../../static/js/view-page.js';
import { makeProtocolFake } from '../protocol-fake.js';
import { DEFAULT_PASSWORD, addressOf, cryptoFor, openPage, replaceInFixture, typeable, waitUntil } from './page.js';

export { DEFAULT_PASSWORD, screen } from './page.js';

/**
 * @typedef {import('../../../../static/js/crypto.js').Bytes} Bytes
 * @typedef {import('../../../../static/js/crypto.js').CryptoService} CryptoService
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

// Status lines a still-running attempt writes; the driver's attempt waits
// for anything else.
const PROGRESS_STATUS = /^(Checking password|Downloading encrypted file|Decrypting)…/;

/**
 * @typedef {object} ShareOptions
 * @property {'file' | 'message'} [type]
 * @property {import('./page.js').LinkKind} [link]
 * @property {string} [query] - a query string the link carries, e.g. 'x=1'
 * @property {string} [password] - the share's password
 * @property {string | Bytes} [content] - what was shared
 * @property {'done' | 'in-progress' | 'unreachable' | 'interrupted'} [download] -
 *   in-progress holds the /download fetch (which runs inside the decrypt
 *   attempt) until finishDownload(); unreachable: the first download never
 *   reaches the server; interrupted: the connection drops partway through it
 * @property {'ok' | 'unsupported-format' | 'corrupted'} [share] - DOM layer only
 * @property {'ok' | 'claimed' | 'burned' | 'error' | 'unreachable'} [server] -
 *   claimed: someone already decrypted it; burned: someone's wrong guesses
 *   locked it and the server destroyed its key share; error: the server
 *   fails the release; unreachable: the release never arrives
 * @property {number} [maxAttempts] - wrong passwords allowed before the share
 *   locks (KEY_RELEASE_MAX_ATTEMPTS, 1 like the server's default)
 * @property {import('./page.js').CryptoKind} [crypto] - real in the JS-integration layer
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
 * @property {() => Promise<void>} pressDecryptAgain - press Decrypt without typing, wait for the outcome
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
 * The salt the page derives the verifier with: it comes from the rendered
 * view-config, so the fixture must carry the seeded share's own salt — the
 * same value the server reads from the blob's BKV3 prefix.
 * @param {string} html
 * @param {string} saltHex
 */
function replaceSalt(html, saltHex) {
    const edited = html.replace(/"salt": "[0-9a-f]{32}"/, `"salt": "${saltHex}"`);
    if (edited === html) throw new Error('fixture edit: no "salt" in the fixture');
    return edited;
}

/**
 * Open a share's view page, the way the confirm page lands on it, and wait
 * until it is ready for a password.
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
    uploaded,
} = {}) {
    const { service: cryptoService, timeout } = cryptoFor(crypto,
        { unsupportedFormat: share === 'unsupported-format', corrupted: share === 'corrupted' });
    const backend = uploaded?.backend ?? makeProtocolFake({ maxAttempts });
    const fileId = uploaded?.fileId ?? await backend.seedShare({ password, plaintext: content }, cryptoService);
    await arrange(backend, fileId, server, cryptoService, password, maxAttempts);
    if (download === 'unreachable') backend.failNext('/download', 'network');
    if (download === 'interrupted') backend.failNext('/download', 'cut-off');
    // Only what the page sends from here on is its own.
    const logStart = backend.log.length;

    /** @type {string} */
    let saltHex;
    try {
        const blob = /** @type {Bytes} */ (backend.state.files.get(fileId)?.blob);
        saltHex = bytesToHex(cryptoService.parseBlob(blob).salt);
    } catch {
        // A share that can't be parsed has no honest salt; the page only
        // needs a well-formed hex string to reach the decrypt stage.
        saltHex = '00'.repeat(16);
    }

    const { fixture, fileId: fixtureId } = FIXTURES[type];
    const page = openPage(fixture, {
        path: addressOf(`/view/${fileId}/confirm`, { link, password, query }),
        // As the server renders it for this share.
        edit: (html) => replaceSalt(
            replaceInFixture(replaceInFixture(html, fixtureId, fileId),
                'You have one attempt', maxAttempts === 1 ? 'You have one attempt' : `You have ${maxAttempts} attempts`),
            saltHex),
    });
    const { window, screen, user } = page;

    /** @type {() => void} */
    let finishDownload = () => {};
    const downloaded = new Promise((resolve) => { finishDownload = () => resolve(undefined); });
    if (download !== 'in-progress') finishDownload();
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

    await initView(window.document, { fetch, crypto: cryptoService });

    const status = () => screen.getByRole('status');
    const passwordField = () => screen.getByLabelText('Password');
    const decryptButton = () => screen.getByRole('button', { name: /^Decrypt and / });

    /**
     * Try a password and wait until the status line reports the outcome. The
     * attempt writes progress lines first (checking, downloading, decrypting),
     * so the wait ends on the first status that is none of those — and only
     * after the status has moved at all, or the prompt itself would count.
     * @param {() => Promise<void>} submit
     */
    const attempt = async (submit) => {
        let reported = false;
        const observer = new window.MutationObserver(() => { reported = true; });
        observer.observe(status(), { childList: true, characterData: true, subtree: true });
        try {
            await submit();
            await waitUntil(() => {
                expect(reported).toBe(true);
                expect(PROGRESS_STATUS.test(status().textContent)).toBe(false);
            }, timeout);
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
        decryptWithPassword: (password) => attempt(async () => {
            await user.clear(passwordField());
            await user.type(passwordField(), typeable(password));
            await user.click(decryptButton());
        }),
        decryptWithEnter: (password) => attempt(async () => {
            await user.clear(passwordField());
            await user.type(passwordField(), `${typeable(password)}{Enter}`);
        }),
        pressDecryptAgain: () => attempt(() => user.click(decryptButton())),
        copyMessage: () => user.click(screen.getByRole('button', { name: 'Copy text' })),
        async finishDownload() {
            finishDownload();
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
 * @param {Pick<CryptoService, 'parseBlob' | 'deriveVerifier'>} cryptoService
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
        const v = await cryptoService.deriveVerifier(password, cryptoService.parseBlob(blob).salt);
        await release(bytesToHex(v));
    } else if (server === 'burned') {
        for (let i = 0; i < maxAttempts; i += 1) await release(WRONG_VERIFIER);
    } else if (server === 'error') {
        backend.failNext('/release', { status: 500, body: { error: 'Internal error' } });
    } else if (server === 'unreachable') {
        backend.failNext('/release', 'network');
    }
}
