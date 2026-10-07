// The index page's upload flows against the protocol fake, with the real
// crypto.js and real PBKDF2 (docs/frontend-test-strategy.md §7, JS integration
// and the upload-side security invariants).
import { describe, expect, it } from 'vitest';
import { CryptoService, bytesToHex, hexToBytes } from '../../../static/js/crypto.js';
import { PASSWORDS, openUploadPage, screen } from '../support/pages/upload.js';

/**
 * @typedef {'file' | 'text'} Mode
 * @typedef {ReturnType<typeof openUploadPage>} UploadPage
 * @typedef {UploadPage['backend']['log'][number]} LoggedRequest
 * @typedef {import('../support/pages/upload.js').UploadServer} UploadServer
 */

const PASSWORD = PASSWORDS.strong;
const CSRF_TOKEN = 'fixture-csrf-token';
const FILE_NAME = 'report.pdf';
const FILE_BYTES = new TextEncoder().encode('%PDF-1.7 quarterly numbers');
const NOTE = 'the gate code is 4711';
const SHARE_OPTIONS = { expiry: '2099-01-31T12:00', privateNote: '  for the Q3 audit  ', notify: true };
// PBKDF2 at 600k iterations runs once per encryption and once per check; the
// driver waits up to 10 s for each upload to settle.
const TEST_TIMEOUT = 20_000;

/** @type {Mode[]} */
const MODES = ['file', 'text'];

/**
 * Where a finished upload sends the page: the success page, with the password
 * in the fragment.
 * @param {string} fileId
 */
const successUrl = (fileId) => `/success/${fileId}#${encodeURIComponent(PASSWORD)}`;

/**
 * Share in `mode` from the composer.
 * @param {UploadPage} upload
 * @param {Mode} mode
 * @param {{ password?: string, server?: UploadServer }} [options]
 */
const shareIn = (upload, mode, { password = PASSWORD, server } = {}) => (mode === 'text'
    ? upload.shareMessage(NOTE, password, { server })
    : upload.shareFile({ name: FILE_NAME, bytes: FILE_BYTES }, password, { server }));

/** @param {LoggedRequest} request */
const pathOf = (request) => new URL(request.url).pathname;

/**
 * @param {UploadPage} upload
 * @param {string} path
 */
const requestsTo = (upload, path) => upload.backend.log.filter((request) => pathOf(request) === path);

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

describe('index page uploads', { timeout: TEST_TIMEOUT }, () => {
    describe.each(MODES)('two-phase upload (%s)', (mode) => {
        it('begins, encrypts under the issued H, uploads with progress and goes to success', async () => {
            const upload = openUploadPage({ account: 'no-shares', crypto: 'real' });

            await shareIn(upload, mode);

            expect(upload.alerts()).toEqual([]);
            expect(upload.backend.log.map(pathOf)).toEqual(['/upload/begin', '/upload']);
            expect(upload.sharesIssued()).toHaveLength(1);
            const [{ file_id: fileId, h }] = upload.sharesIssued();
            const [request] = requestsTo(upload, '/upload');

            expect(field(request, 'file_id')).toBe(fileId);
            if (mode === 'text') {
                expect(field(request, 'type')).toBe('text');
                expect(field(request, 'file')).toBeNull();
            } else {
                const file = field(request, 'file');
                expect(file instanceof File && file.name).toBe(FILE_NAME);
                expect(field(request, 'note_text')).toBeNull();
            }
            // Options left unset are left out.
            for (const name of ['expiry', 'private_note', 'notify_on_open', 'notification_email']) {
                expect(field(request, name)).toBeNull();
            }

            // The blob opens under the password and the H the fake issued, and
            // the verifier and receipt hash bound to it are the blob's own.
            const blob = await uploadedBlob(request);
            const cryptoService = new CryptoService();
            const { data, receipt } = await cryptoService.decrypt(blob, PASSWORD, hexToBytes(h));
            expect(data).toEqual(mode === 'text' ? new TextEncoder().encode(NOTE) : FILE_BYTES);
            expect(field(request, 'receipt_hash')).toBe(await cryptoService.receiptHash(receipt));
            const verifier = await cryptoService.deriveVerifier(PASSWORD, cryptoService.parseBlob(blob).salt);
            expect(field(request, 'key_verifier')).toBe(bytesToHex(verifier));
            expect(upload.backend.state.keys.get(fileId)?.v).toBe(bytesToHex(verifier));

            expect(upload.progressShown()).toEqual([
                { shown: '0%', visible: true }, { shown: '50%', visible: true }, { shown: '100%', visible: true },
            ]);
            expect(upload.navigatedTo()).toEqual([successUrl(fileId)]);
        });

        it('sends the share options', async () => {
            const upload = openUploadPage({ account: 'with-email', crypto: 'real' });
            await upload.setShareOptions(SHARE_OPTIONS);

            await shareIn(upload, mode);

            expect(upload.alerts()).toEqual([]);
            const [request] = requestsTo(upload, '/upload');
            expect(field(request, 'expiry')).toBe('2099-01-31T12:00');
            expect(field(request, 'private_note')).toBe('for the Q3 audit');
            expect(field(request, 'notify_on_open')).toBe('true');
            expect(field(request, 'notification_email')).toBe('notify@example.test');
            expect(upload.backend.state.files.size).toBe(1);
        });
    });

    /**
     * @typedef {object} ErrorCase
     * @property {string} name
     * @property {UploadServer} server
     * @property {string} [message] - what the page alerts, pinned only for 413
     * @property {boolean} reachesUpload - whether the failed attempt sends /upload
     */
    // File and note share the upload code, so the error paths run once, in
    // file mode: one failure per phase, plus the 413 message
    // (docs/frontend-test-strategy.md §7, Granularity). Which message each
    // other status shows is not an integration concern.
    /** @type {ErrorCase[]} */
    const ERROR_CASES = [
        { name: 'begin is rate-limited (429)', server: 'busy', reachesUpload: false },
        { name: 'the upload errors (500, HTML body)', server: 'failing', reachesUpload: true },
        { name: 'the upload is too large (413)', server: 'too-large', message: 'File too large', reachesUpload: true },
    ];

    describe('upload errors', () => {
        it.each(ERROR_CASES)('$name: alerts, recovers and retries with a fresh share', async (errorCase) => {
            const upload = openUploadPage({ account: 'no-shares', crypto: 'real' });

            await shareIn(upload, 'file', { server: errorCase.server });

            expect(upload.alerts()).toHaveLength(1);
            if (errorCase.message) expect(upload.alerts()).toEqual([errorCase.message]);
            expect(upload.navigatedTo()).toEqual([]);
            const failed = requestsTo(upload, '/upload');
            expect(failed).toHaveLength(errorCase.reachesUpload ? 1 : 0);
            expect(screen.getByRole('button', { name: 'Share file' })).toBeEnabled();
            expect(screen.getByRole('button', { name: 'Share file' })).toBeVisible();
            expect(screen.queryByRole('progressbar', { name: 'Upload progress' })).toBeNull();

            await upload.share();

            // The retry begins again and finishes the share it was just
            // issued, not the one the failed attempt sent.
            expect(upload.alerts()).toHaveLength(1);
            expect(requestsTo(upload, '/upload/begin')).toHaveLength(2);
            const issued = upload.sharesIssued();
            const fresh = issued.at(-1);
            if (!fresh) throw new Error('the retry was issued no share');
            const retry = requestsTo(upload, '/upload').at(-1);
            if (!retry) throw new Error('the retry sent no upload');
            expect(field(retry, 'file_id')).toBe(fresh.file_id);
            if (errorCase.reachesUpload) {
                expect(field(failed[0], 'file_id')).toBe(issued[0].file_id);
                expect(field(failed[0], 'file_id')).not.toBe(fresh.file_id);
            }
            expect(upload.navigatedTo()).toEqual([successUrl(fresh.file_id)]);
        });
    });

    describe('security invariants', () => {
        it.each(MODES)('the password never reaches the server (%s)', async (mode) => {
            const upload = openUploadPage({ account: 'with-email', crypto: 'real' });
            await upload.setShareOptions(SHARE_OPTIONS);

            // A failed attempt first, so the retry path is on record too.
            await shareIn(upload, mode, { server: 'too-large' });
            await upload.share();

            expect(upload.alerts()).toHaveLength(1);
            expect(upload.backend.log).toHaveLength(4);
            for (const request of upload.backend.log) {
                const text = await requestText(request);
                expect(text).not.toContain(PASSWORD);
                expect(text).not.toContain(encodeURIComponent(PASSWORD));
            }
        });

        it.each(MODES)('a weak password is refused before any request (%s)', async (mode) => {
            const upload = openUploadPage({ account: 'no-shares', crypto: 'real' });

            await shareIn(upload, mode, { password: PASSWORDS.weak });

            expect(screen.getByLabelText('Password')).toHaveAccessibleDescription(/^Password rejected: /);
            expect(upload.backend.log).toEqual([]);
            expect(upload.navigatedTo()).toEqual([]);
            expect(upload.alerts()).toEqual([]);
        });

        it('every session-authed mutation carries the CSRF token', async () => {
            const upload = openUploadPage({ account: 'no-shares', crypto: 'real' });

            await shareIn(upload, 'file', { server: 'rate-limited' });
            await shareIn(upload, 'text');

            expect(upload.backend.log.map((request) => `${request.method} ${pathOf(request)}`)).toEqual([
                'POST /upload/begin', 'POST /upload', 'POST /upload/begin', 'POST /upload',
            ]);
            for (const request of upload.backend.log) {
                const headers = Object.fromEntries(
                    Object.entries(request.headers).map(([name, value]) => [name.toLowerCase(), value]));
                expect(headers['x-csrf-token']).toBe(CSRF_TOKEN);
            }
        });

        // Storage is checked as a whole, not searched for H, so H in any
        // encoding (or anything derived from it) counts.
        it.each(MODES)('H is never written to localStorage or sessionStorage (%s)', async (mode) => {
            const upload = openUploadPage({ account: 'no-shares', crypto: 'real' });

            // A failed attempt first: a page tempted to keep a share for the
            // retry would do it here.
            await shareIn(upload, mode, { server: 'too-large' });
            await upload.share();

            expect(upload.navigatedTo()).toHaveLength(1);
            expect(upload.sharesIssued()).toHaveLength(2);
            expect(upload.storage()).toEqual({ writes: 0, localStorage: 0, sessionStorage: 0 });
        });
    });
});
