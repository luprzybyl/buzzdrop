// The index page's upload flows against the protocol fake, with the real
// crypto.js and real PBKDF2 (docs/frontend-test-strategy.md §7, JS integration
// and the upload-side security invariants).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CryptoService, bytesToHex, hexToBytes } from '../../../static/js/crypto.js';
import { initIndex } from '../../../static/js/index-page.js';
import { required } from '../../../static/js/required.js';
import { browserView, loadFixture } from '../support/dom-fixture.js';
import { makeProtocolFake } from '../support/protocol-fake.js';

/**
 * @typedef {'file' | 'text'} Mode
 * @typedef {ReturnType<typeof makeProtocolFake>} Fake
 * @typedef {Fake['log'][number]} LoggedRequest
 * @typedef {{ file_id: string, h: string }} IssuedShare
 * @typedef {object} StartOptions
 * @property {'index--empty' | 'index--notification-email'} [fixture]
 * @property {import('../support/protocol-fake.js').FakeOptions} [fakeOptions]
 * @property {(fake: Fake, count: number) => void} [onBegin] - runs on each /upload/begin answer (count from 1), before the page sees it
 */

// Six EFF words: strong enough for the gate, and distinctive enough that a
// leak of it into a request can't be a coincidence.
const PASSWORD = 'abacus-abdomen-abdominal-abide-abiding-ability';
const CSRF_TOKEN = 'fixture-csrf-token';
const FILE_NAME = 'report.pdf';
const FILE_BYTES = new TextEncoder().encode('%PDF-1.7 quarterly numbers');
const NOTE = 'the gate code is 4711';
// PBKDF2 at 600k iterations runs once per encryption and once per check; a
// page that never settles fails at SETTLE_TIMEOUT.
const TEST_TIMEOUT = 20_000;
const SETTLE_TIMEOUT = 10_000;

/** @type {Mode[]} */
const MODES = ['file', 'text'];

/**
 * Where a finished upload sends the page: the success page, with the password
 * in the fragment.
 * @param {string} fileId
 */
const successUrl = (fileId) => `/success/${fileId}#${encodeURIComponent(PASSWORD)}`;

describe('index page uploads', { timeout: TEST_TIMEOUT }, () => {
    /** @type {import('happy-dom').Window | undefined} */
    let page;

    afterEach(async () => {
        await page?.happyDOM.close();
        page = undefined;
    });

    /** @param {StartOptions} [options] */
    const start = ({ fixture = 'index--empty', fakeOptions = {}, onBegin } = {}) => {
        page = loadFixture(fixture);
        const window = browserView(page);
        const { document } = window;
        const fake = makeProtocolFake(fakeOptions);
        /** @type {IssuedShare[]} */
        const issued = [];
        /** @type {typeof globalThis.fetch} */
        const fetchAndRecord = async (input, init) => {
            const response = await fake.fetch(input, init);
            if (response.ok && String(input).endsWith('/upload/begin')) {
                /** @type {IssuedShare} */
                const share = await response.clone().json();
                issued.push(share);
                onBegin?.(fake, issued.length);
            }
            return response;
        };
        const navigate = vi.fn();
        const alert = vi.fn();
        initIndex(document, {
            fetch: fetchAndRecord,
            XMLHttpRequest: fake.XMLHttpRequest,
            navigate,
            alert,
            crypto: new CryptoService(),
        });

        // Every value #share-progress-text shows, in order.
        /** @type {string[]} */
        const progress = [];
        const progressText = required(document, '#share-progress-text', 'span');
        new window.MutationObserver((records) => {
            for (const record of records) {
                record.addedNodes.forEach((node) => progress.push(node.textContent ?? ''));
            }
        }).observe(progressText, { childList: true });

        /** @param {string} selector */
        const input = (selector) => required(document, selector, 'input');

        /**
         * Fill the composer for `mode` and press the share button.
         * @param {Mode} mode
         * @param {string} [password]
         */
        const share = (mode, password = PASSWORD) => {
            if (mode === 'text') {
                required(document, '#text-tab', 'button').click();
                required(document, '#note-text', 'textarea').value = NOTE;
            } else {
                const transfer = new window.DataTransfer();
                transfer.items.add(new window.File([FILE_BYTES], FILE_NAME));
                input('#file').files = transfer.files;
                input('#file').dispatchEvent(new window.Event('change'));
            }
            input('#shared-password').value = password;
            required(document, '#share-action-btn', 'button').click();
        };

        /** Wait until the page has navigated or alerted, `count` times in all. */
        const settled = (count = 1) => vi.waitFor(() => {
            expect(navigate.mock.calls.length + alert.mock.calls.length).toBeGreaterThanOrEqual(count);
        }, { timeout: SETTLE_TIMEOUT, interval: 20 });

        /** @param {LoggedRequest} request */
        const pathOf = (request) => new URL(request.url).pathname;

        /** Fill in every share option (the notification-email fixture prefills the email). */
        const setShareOptions = () => {
            required(document, '#shared-expiry', 'input').value = '2099-01-31T12:00';
            required(document, '#shared-private-note', 'textarea').value = '  for the Q3 audit  ';
            required(document, '#notify-on-open', 'input').checked = true;
        };

        /** @param {string} path */
        const requestsTo = (path) => fake.log.filter((request) => pathOf(request) === path);

        return {
            window, document, fake, issued, navigate, alert, progress,
            share, setShareOptions, settled, pathOf, requestsTo,
        };
    };

    /**
     * A field of a logged /upload request's multipart body.
     * @param {LoggedRequest} request
     * @param {string} name
     */
    const field = (request, name) => {
        if (!(request.body instanceof FormData)) throw new Error('not a multipart request');
        return request.body.get(name);
    };

    /**
     * Everything a request carried, as text: URL, header names and values, and
     * the body, with file parts read byte for byte.
     * @param {LoggedRequest} request
     */
    const requestText = async (request) => {
        const parts = [request.url];
        for (const [name, value] of Object.entries(request.headers)) parts.push(name, value);
        if (typeof request.body === 'string') {
            parts.push(request.body);
        } else if (request.body instanceof FormData) {
            for (const [name, value] of request.body.entries()) {
                parts.push(name);
                parts.push(typeof value === 'string'
                    ? value
                    : value.name + new TextDecoder('latin1').decode(await value.arrayBuffer()));
            }
        }
        return parts.join('\n');
    };

    /**
     * The encrypted payload a logged /upload carried, as the server stores it.
     * @param {LoggedRequest} request
     */
    const uploadedBlob = async (request) => {
        const note = field(request, 'note_text');
        if (typeof note === 'string') {
            return Uint8Array.from(atob(note), (c) => c.charCodeAt(0));
        }
        const file = field(request, 'file');
        if (!(file instanceof Blob)) throw new Error('upload carried neither a file nor a note');
        return new Uint8Array(await file.arrayBuffer());
    };

    describe.each(MODES)('two-phase upload (%s)', (mode) => {
        it('begins, encrypts under the issued H, uploads with progress and goes to success', async () => {
            const { fake, issued, navigate, alert, progress, share, settled, pathOf, requestsTo } = start();

            share(mode);
            await settled();

            expect(alert).not.toHaveBeenCalled();
            expect(fake.log.map(pathOf)).toEqual(['/upload/begin', '/upload']);
            expect(issued).toHaveLength(1);
            const [{ file_id: fileId, h }] = issued;
            const [upload] = requestsTo('/upload');

            expect(field(upload, 'file_id')).toBe(fileId);
            if (mode === 'text') {
                expect(field(upload, 'type')).toBe('text');
                expect(field(upload, 'file')).toBeNull();
            } else {
                const file = field(upload, 'file');
                expect(file instanceof File && file.name).toBe(FILE_NAME);
                expect(field(upload, 'note_text')).toBeNull();
            }
            // Options left unset are left out.
            for (const name of ['expiry', 'private_note', 'notify_on_open', 'notification_email']) {
                expect(field(upload, name)).toBeNull();
            }

            // The blob opens under the password and the H the fake issued, and
            // the verifier and receipt hash bound to it are the blob's own.
            const blob = await uploadedBlob(upload);
            const cryptoService = new CryptoService();
            const { data, receipt } = await cryptoService.decrypt(blob, PASSWORD, hexToBytes(h));
            expect(data).toEqual(mode === 'text' ? new TextEncoder().encode(NOTE) : FILE_BYTES);
            expect(field(upload, 'receipt_hash')).toBe(await cryptoService.receiptHash(receipt));
            const verifier = await cryptoService.deriveVerifier(PASSWORD, cryptoService.parseBlob(blob).salt);
            expect(field(upload, 'key_verifier')).toBe(bytesToHex(verifier));
            expect(fake.state.keys.get(fileId)?.v).toBe(bytesToHex(verifier));

            expect(progress).toEqual(['0%', '50%', '100%']);
            expect(navigate).toHaveBeenCalledExactlyOnceWith(successUrl(fileId));
        });

        it('sends the share options', async () => {
            const { fake, alert, share, setShareOptions, settled, requestsTo } = start({
                fixture: 'index--notification-email',
                fakeOptions: { owner: 'notifyuser' },
            });
            setShareOptions();

            share(mode);
            await settled();

            expect(alert).not.toHaveBeenCalled();
            const [upload] = requestsTo('/upload');
            expect(field(upload, 'expiry')).toBe('2099-01-31T12:00');
            expect(field(upload, 'private_note')).toBe('for the Q3 audit');
            expect(field(upload, 'notify_on_open')).toBe('true');
            expect(field(upload, 'notification_email')).toBe('notify@example.test');
            expect(fake.state.files.size).toBe(1);
        });
    });

    /**
     * @typedef {object} ErrorCase
     * @property {string} name
     * @property {string} message - what the page alerts
     * @property {boolean} reachesUpload - whether the failed attempt sends /upload
     * @property {(fake: Fake) => void} [arrange]
     * @property {StartOptions['onBegin']} [onBegin]
     */
    /** @type {ErrorCase[]} */
    const ERROR_CASES = [
        {
            name: 'begin is rate-limited (429)',
            message: 'The server refused the upload handshake.',
            reachesUpload: false,
            arrange: (fake) => fake.failNext('/upload/begin', 429),
        },
        {
            name: 'begin errors (500)',
            message: 'The server refused the upload handshake.',
            reachesUpload: false,
            arrange: (fake) => fake.failNext('/upload/begin', {
                status: 500, body: '<!doctype html><title>500 Internal Server Error</title>',
            }),
        },
        {
            name: 'begin fails on the network',
            message: 'Failed to fetch',
            reachesUpload: false,
            arrange: (fake) => fake.failNext('/upload/begin', 'network'),
        },
        {
            // The session changed hands between begin and finish; the retry
            // runs as the new account.
            name: 'the share belongs to another account (403)',
            message: 'Key-release share belongs to another user',
            reachesUpload: true,
            onBegin: (fake, count) => {
                if (count === 1) fake.state.user = 'adminuser';
            },
        },
        {
            name: 'the upload is too large (413)',
            message: 'File too large',
            reachesUpload: true,
            arrange: (fake) => fake.failNext('/upload', 413),
        },
        {
            name: 'the upload is rate-limited (429)',
            message: 'Too many requests. Please try again later.',
            reachesUpload: true,
            arrange: (fake) => fake.failNext('/upload', 429),
        },
        {
            name: 'the upload errors (500, HTML body)',
            message: 'Upload failed',
            reachesUpload: true,
            arrange: (fake) => fake.failNext('/upload', {
                status: 500, body: '<!doctype html><title>500 Internal Server Error</title>',
            }),
        },
        {
            name: 'the upload fails on the network',
            message: 'Network error during upload',
            reachesUpload: true,
            arrange: (fake) => fake.failNext('/upload', 'network'),
        },
    ];

    describe.each(MODES)('upload errors (%s)', (mode) => {
        it.each(ERROR_CASES)('$name: alerts, recovers and retries with a fresh share', async (errorCase) => {
            const { document, fake, issued, navigate, alert, share, settled, requestsTo } = start({
                onBegin: errorCase.onBegin,
            });
            errorCase.arrange?.(fake);

            share(mode);
            await settled();

            expect(alert).toHaveBeenCalledExactlyOnceWith(errorCase.message);
            expect(navigate).not.toHaveBeenCalled();
            const failed = requestsTo('/upload');
            expect(failed).toHaveLength(errorCase.reachesUpload ? 1 : 0);
            const button = required(document, '#share-action-btn', 'button');
            expect(button.disabled).toBe(false);
            expect(button.style.display).toBe('');
            expect(required(document, '#share-progress-container', 'div').style.display).not.toBe('flex');

            button.click();
            await settled(2);

            // The retry begins again and finishes the share it was just
            // issued, not the one the failed attempt sent.
            expect(alert).toHaveBeenCalledOnce();
            expect(requestsTo('/upload/begin')).toHaveLength(2);
            const fresh = issued.at(-1);
            if (!fresh) throw new Error('the retry was issued no share');
            const retry = requestsTo('/upload').at(-1);
            if (!retry) throw new Error('the retry sent no upload');
            expect(field(retry, 'file_id')).toBe(fresh.file_id);
            if (errorCase.reachesUpload) {
                expect(field(failed[0], 'file_id')).toBe(issued[0].file_id);
                expect(field(failed[0], 'file_id')).not.toBe(fresh.file_id);
            }
            expect(navigate).toHaveBeenCalledExactlyOnceWith(successUrl(fresh.file_id));
        });
    });

    describe('security invariants', () => {
        it.each(MODES)('the password never reaches the server (%s)', async (mode) => {
            const { document, fake, alert, share, setShareOptions, settled } = start({
                fixture: 'index--notification-email',
                fakeOptions: { owner: 'notifyuser' },
            });
            setShareOptions();
            // A failed attempt first, so the retry path is on record too.
            fake.failNext('/upload', 413);

            share(mode);
            await settled();
            required(document, '#share-action-btn', 'button').click();
            await settled(2);

            expect(alert).toHaveBeenCalledOnce();
            expect(fake.log).toHaveLength(4);
            for (const request of fake.log) {
                const text = await requestText(request);
                expect(text).not.toContain(PASSWORD);
                expect(text).not.toContain(encodeURIComponent(PASSWORD));
            }
        });

        it.each(MODES)('a weak password is refused before any request (%s)', async (mode) => {
            const { document, fake, navigate, alert, share } = start();

            share(mode, 'password');
            await vi.waitFor(() => {
                expect(required(document, '#password-error', 'p').textContent).toMatch(/^Password rejected: /);
            }, { timeout: SETTLE_TIMEOUT, interval: 20 });

            expect(fake.log).toEqual([]);
            expect(navigate).not.toHaveBeenCalled();
            expect(alert).not.toHaveBeenCalled();
        });

        it('every session-authed mutation carries the CSRF token', async () => {
            const { fake, share, settled, pathOf } = start();
            fake.failNext('/upload', 429);

            share('file');
            await settled();
            share('text');
            await settled(2);

            expect(fake.log.map((request) => `${request.method} ${pathOf(request)}`)).toEqual([
                'POST /upload/begin', 'POST /upload', 'POST /upload/begin', 'POST /upload',
            ]);
            for (const request of fake.log) {
                const headers = Object.fromEntries(
                    Object.entries(request.headers).map(([name, value]) => [name.toLowerCase(), value]));
                expect(headers['x-csrf-token']).toBe(CSRF_TOKEN);
            }
        });

        // Storage is checked as a whole, not searched for H, so H in any
        // encoding (or anything derived from it) counts.
        it.each(MODES)('H is never written to localStorage or sessionStorage (%s)', async (mode) => {
            const { window, document, fake, issued, navigate, share, settled } = start();
            const setItem = vi.spyOn(window.Storage.prototype, 'setItem');
            // A failed attempt first: a page tempted to keep a share for the
            // retry would do it here.
            fake.failNext('/upload', 413);

            share(mode);
            await settled();
            required(document, '#share-action-btn', 'button').click();
            await settled(2);

            expect(navigate).toHaveBeenCalledOnce();
            expect(issued).toHaveLength(2);
            expect(setItem).not.toHaveBeenCalled();
            expect(window.localStorage).toHaveLength(0);
            expect(window.sessionStorage).toHaveLength(0);
        });
    });
});
