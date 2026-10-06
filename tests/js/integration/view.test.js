// The view page's protocol flow against the protocol fake, with the real
// crypto.js and real PBKDF2 (docs/frontend-test-strategy.md §7, JS integration
// and the view-side security invariants).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CryptoService } from '../../../static/js/crypto.js';
import { initIndex } from '../../../static/js/index-page.js';
import { required } from '../../../static/js/required.js';
import { initView } from '../../../static/js/view-page.js';
import { browserView, loadFixture } from '../support/dom-fixture.js';
import { makeProtocolFake } from '../support/protocol-fake.js';

/**
 * @typedef {ReturnType<typeof makeProtocolFake>} Fake
 * @typedef {Fake['log'][number]} LoggedRequest
 */

// Six EFF words: strong enough for the index page's gate, and distinctive
// enough that a leak of it into a request can't be a coincidence.
const PASSWORD = 'abacus-abdomen-abdominal-abide-abiding-ability';
const WRONG_PASSWORD = 'zebra-zesty-zigzag-zipfile-zipping-zone';
const FILE_NAME = 'contract.pdf';
const FILE_BYTES = new TextEncoder().encode('%PDF-1.7 signed contract');
const NOTE = 'the gate code is 4711';
// PBKDF2 at 600k iterations runs on every encryption, verifier and
// decryption; a page that never settles fails at SETTLE_TIMEOUT.
const TEST_TIMEOUT = 30_000;
const SETTLE_TIMEOUT = 15_000;

describe('view page decryption', { timeout: TEST_TIMEOUT }, () => {
    /** @type {import('happy-dom').Window[]} */
    let pages = [];

    afterEach(async () => {
        vi.restoreAllMocks();
        await Promise.all(pages.map((page) => page.happyDOM.close()));
        pages = [];
    });

    /** @param {LoggedRequest} request */
    const pathOf = (request) => new URL(request.url).pathname;

    /**
     * Open the view page for `fileId` on `fake`, as app.py renders it for that
     * share, and wait until the blob is downloaded and the form is ready.
     * @param {Fake} fake
     * @param {string} fileId
     * @param {'file' | 'text'} fileType
     */
    const openView = async (fake, fileId, fileType) => {
        const page = loadFixture(`view--${fileType}`, {}, `http://localhost/view/${fileId}/confirm`);
        pages.push(page);
        const window = browserView(page);
        const { document } = window;
        required(document, '#view-config-json', 'script').text = JSON.stringify({
            downloadUrl: `/download/${fileId}`,
            releaseUrl: `/release/${fileId}`,
            reportDecryptionUrl: `/report_decryption/${fileId}`,
            originalName: FILE_NAME,
            fileType,
        });
        // The file path hands the plaintext to the browser as an object URL.
        /** @type {Blob[]} */
        const downloads = [];
        const createObjectURL = URL.createObjectURL.bind(URL);
        vi.spyOn(URL, 'createObjectURL').mockImplementation((object) => {
            if (object instanceof Blob) downloads.push(object);
            return createObjectURL(object);
        });
        await initView(document, { fetch: fake.fetch, crypto: new CryptoService() });

        const status = required(document, '#status', 'p');
        return {
            window,
            status,
            downloads,
            noteText: required(document, '#text-content', 'pre'),
            /**
             * Type the password, click Decrypt and wait for the status to change.
             * @param {string} password
             */
            async decrypt(password) {
                const before = status.textContent;
                required(document, '#password-input', 'input').value = password;
                required(document, '#decrypt-btn', 'button').click();
                await vi.waitFor(() => expect(status.textContent).not.toBe(before),
                    { timeout: SETTLE_TIMEOUT, interval: 20 });
            },
        };
    };

    /**
     * Wait for the page's fire-and-forget receipt report to land.
     * @param {Fake} fake
     * @param {string} fileId
     */
    const receiptReported = (fake, fileId) => vi.waitFor(() => {
        expect(fake.state.files.get(fileId)?.decryptionSuccess).not.toBeNull();
    }, { timeout: SETTLE_TIMEOUT, interval: 20 });

    /**
     * Upload a note through the index page on `fake` and return its file_id.
     * @param {Fake} fake
     */
    const uploadNote = async (fake) => {
        const page = loadFixture('index--empty');
        pages.push(page);
        const { document } = browserView(page);
        const navigate = vi.fn();
        const alert = vi.fn();
        initIndex(document, {
            fetch: fake.fetch,
            XMLHttpRequest: fake.XMLHttpRequest,
            navigate,
            alert,
            crypto: new CryptoService(),
        });
        required(document, '#text-tab', 'button').click();
        required(document, '#note-text', 'textarea').value = NOTE;
        required(document, '#shared-password', 'input').value = PASSWORD;
        required(document, '#share-action-btn', 'button').click();
        await vi.waitFor(() => expect(navigate.mock.calls.length + alert.mock.calls.length).toBe(1),
            { timeout: SETTLE_TIMEOUT, interval: 20 });
        expect(alert).not.toHaveBeenCalled();
        const [[successUrl]] = navigate.mock.calls;
        const fileId = /^\/success\/([^#]+)#/.exec(successUrl)?.[1];
        if (!fileId) throw new Error(`unexpected success URL ${successUrl}`);
        return fileId;
    };

    /**
     * Everything a view request carried, as text: URL, header names and
     * values, and the body (the view page sends only JSON strings).
     * @param {LoggedRequest} request
     */
    const requestText = (request) => {
        if (request.body !== null && typeof request.body !== 'string') {
            throw new Error(`unexpected non-string body to ${request.url}`);
        }
        return [request.url, ...Object.entries(request.headers).flat(), request.body ?? ''].join('\n');
    };

    it('fetches the blob, releases H, decrypts the file and reports the receipt', async () => {
        const fake = makeProtocolFake();
        const fileId = await fake.seedShare({ password: PASSWORD, plaintext: FILE_BYTES, name: FILE_NAME });
        const view = await openView(fake, fileId, 'file');

        await view.decrypt(PASSWORD);
        await receiptReported(fake, fileId);

        expect(view.downloads).toHaveLength(1);
        expect(new Uint8Array(await view.downloads[0].arrayBuffer())).toEqual(FILE_BYTES);
        expect(fake.log.map((request) => `${request.method} ${pathOf(request)}`)).toEqual([
            `GET /download/${fileId}`,
            `POST /release/${fileId}`,
            `POST /report_decryption/${fileId}`,
        ]);
        expect(fake.state.keys.get(fileId)?.releasedAt).not.toBeNull();
        expect(fake.state.files.get(fileId)?.decryptionSuccess).toBe(true);
    });

    it('opens a note the index page uploaded to the same server', async () => {
        const fake = makeProtocolFake();
        const fileId = await uploadNote(fake);
        const view = await openView(fake, fileId, 'text');

        await view.decrypt(PASSWORD);
        await receiptReported(fake, fileId);

        expect(view.noteText.textContent).toBe(NOTE);
        expect(fake.log.map(pathOf)).toEqual([
            '/upload/begin', '/upload',
            `/download/${fileId}`, `/release/${fileId}`, `/report_decryption/${fileId}`,
        ]);
        expect(fake.state.files.get(fileId)?.decryptionSuccess).toBe(true);
    });

    it('a wrong password shows the attempts left, and the right one still decrypts', async () => {
        const fake = makeProtocolFake({ maxAttempts: 3 });
        const fileId = await fake.seedShare({ password: PASSWORD, plaintext: NOTE });
        const view = await openView(fake, fileId, 'text');

        await view.decrypt(WRONG_PASSWORD);

        // The exact wording is DOM-tested; here, the fake's count reaches the page.
        expect(view.status.textContent).toMatch(/\b2 attempts\b/);
        expect(fake.state.keys.get(fileId)?.attempts).toBe(1);

        await view.decrypt(PASSWORD);
        await receiptReported(fake, fileId);

        expect(view.noteText.textContent).toBe(NOTE);
        expect(fake.state.files.get(fileId)?.decryptionSuccess).toBe(true);
    });

    describe('security invariants', () => {
        it('the password never reaches the server, right or wrong', async () => {
            const fake = makeProtocolFake({ maxAttempts: 3 });
            const fileId = await fake.seedShare({ password: PASSWORD, plaintext: NOTE });
            // Checked after each attempt, so a leak fails at the attempt that
            // made it rather than as a stalled flow later on.
            const expectNoPassword = () => {
                for (const request of fake.log) {
                    const text = requestText(request);
                    expect(text).not.toContain(PASSWORD);
                    expect(text).not.toContain(encodeURIComponent(PASSWORD));
                    expect(text).not.toContain(WRONG_PASSWORD);
                }
            };
            const view = await openView(fake, fileId, 'text');

            await view.decrypt(WRONG_PASSWORD);
            expectNoPassword();
            await view.decrypt(PASSWORD);
            await receiptReported(fake, fileId);
            expectNoPassword();

            expect(fake.log.filter((request) => pathOf(request) === `/release/${fileId}`)).toHaveLength(2);
        });

        it('H is never persisted in the browser', async () => {
            const fake = makeProtocolFake();
            const fileId = await fake.seedShare({ password: PASSWORD, plaintext: NOTE });
            const view = await openView(fake, fileId, 'text');

            await view.decrypt(PASSWORD);
            await receiptReported(fake, fileId);

            // The page's own window, and the test environment's global one a
            // bare `localStorage` in the module would reach.
            for (const window of [view.window, globalThis]) {
                expect(window.localStorage.length).toBe(0);
                expect(window.sessionStorage.length).toBe(0);
            }
        });
    });
});
