// The view page's protocol flow against the protocol fake, with the real
// lib/crypto.js and real PBKDF2 (docs/frontend-test-strategy.md §7, JS integration
// and the view-side security invariants).
import { describe, expect, it } from 'vitest';
import { openUploadPage } from '../support/pages/upload.js';
import { openShare, screen } from '../support/pages/view.js';
import { pathOf } from '../support/protocol-fake.js';

/**
 * @typedef {import('../support/pages/view.js').ShareView} ShareView
 * @typedef {ReturnType<ShareView['requestsSent']>[number]} LoggedRequest
 */

// Six EFF words: strong enough for the index page's gate, and distinctive
// enough that a leak of it into a request can't be a coincidence.
const PASSWORD = 'abacus-abdomen-abdominal-abide-abiding-ability';
const WRONG_PASSWORD = 'zebra-zesty-zigzag-zipfile-zipping-zone';
const FILE_BYTES = new TextEncoder().encode('%PDF-1.7 signed contract');
const NOTE = 'the gate code is 4711';
// PBKDF2 at 600k iterations runs on every encryption, verifier and
// decryption; the drivers wait up to REAL_CRYPTO_TIMEOUT for each step.
const TEST_TIMEOUT = 30_000;

/**
 * Everything a view request carried, as text: URL, header names and values,
 * and the body (the view page sends only JSON strings).
 * @param {LoggedRequest} request
 */
const requestText = (request) => {
    if (request.body !== null && typeof request.body !== 'string') {
        throw new Error(`unexpected non-string body to ${request.url}`);
    }
    return [request.url, ...Object.entries(request.headers).flat(), request.body ?? ''].join('\n');
};

describe('view page decryption', { timeout: TEST_TIMEOUT }, () => {
    it('fetches the blob, releases H, decrypts the file and reports the receipt', async () => {
        const share = await openShare({ crypto: 'real', type: 'file', password: PASSWORD, content: FILE_BYTES });

        await share.decryptWithPassword(PASSWORD);

        expect(await share.decryptionRecorded()).toBe(true);
        expect(await share.savedFile()).toEqual({ name: 'contract.pdf', bytes: FILE_BYTES });
        expect(share.requestsSent().map((request) => `${request.method} ${pathOf(request)}`)).toEqual([
            `GET /download/${share.fileId}`,
            `POST /release/${share.fileId}`,
            `POST /report_decryption/${share.fileId}`,
        ]);
        expect(share.backend.state.keys.get(share.fileId)?.releasedAt).not.toBeNull();
    });

    it('opens a message the index page uploaded to the same server', async () => {
        const upload = openUploadPage({ account: 'no-shares', crypto: 'real' });
        await upload.shareMessage(NOTE, PASSWORD);
        expect(upload.alerts()).toEqual([]);
        const [{ file_id: fileId }] = upload.sharesIssued();

        const share = await openShare({ crypto: 'real', uploaded: { backend: upload.backend, fileId } });
        await share.decryptWithPassword(PASSWORD);

        expect(await share.decryptionRecorded()).toBe(true);
        expect(screen.getByRole('region', { name: 'Decrypted text' })).toHaveTextContent(NOTE);
        expect(share.backend.log.map(pathOf)).toEqual([
            '/upload/begin', '/upload',
            `/download/${fileId}`, `/release/${fileId}`, `/report_decryption/${fileId}`,
        ]);
    });

    it('a wrong password shows the attempts left, and the right one still decrypts', async () => {
        const share = await openShare({ crypto: 'real', password: PASSWORD, content: NOTE, maxAttempts: 3 });

        await share.decryptWithPassword(WRONG_PASSWORD);

        // The exact wording is DOM-tested; here, the fake's count reaches the page.
        expect(screen.getByRole('status')).toHaveTextContent(/\b2 attempts\b/);
        expect(share.backend.state.keys.get(share.fileId)?.attempts).toBe(1);

        await share.decryptWithPassword(PASSWORD);

        expect(await share.decryptionRecorded()).toBe(true);
        expect(screen.getByRole('region', { name: 'Decrypted text' })).toHaveTextContent(NOTE);
    });

    describe('security invariants', () => {
        it('the password never reaches the server, right or wrong', async () => {
            const share = await openShare({ crypto: 'real', password: PASSWORD, content: NOTE, maxAttempts: 3 });
            // Checked after each attempt, so a leak fails at the attempt that
            // made it rather than as a stalled flow later on.
            const expectNoPassword = () => {
                for (const request of share.requestsSent()) {
                    const text = requestText(request);
                    expect(text).not.toContain(PASSWORD);
                    expect(text).not.toContain(encodeURIComponent(PASSWORD));
                    expect(text).not.toContain(WRONG_PASSWORD);
                }
            };

            await share.decryptWithPassword(WRONG_PASSWORD);
            expectNoPassword();
            await share.decryptWithPassword(PASSWORD);
            await share.decryptionRecorded();
            expectNoPassword();

            expect(share.requestsSent().filter((request) => pathOf(request) === `/release/${share.fileId}`))
                .toHaveLength(2);
        });

        it('H is never persisted in the browser', async () => {
            const share = await openShare({ crypto: 'real', password: PASSWORD, content: NOTE });

            await share.decryptWithPassword(PASSWORD);
            await share.decryptionRecorded();

            expect(share.storage()).toEqual({ writes: 0, localStorage: 0, sessionStorage: 0 });
            // The test environment's global storage, which a bare
            // `localStorage` in the module would reach.
            expect(globalThis.localStorage).toHaveLength(0);
            expect(globalThis.sessionStorage).toHaveLength(0);
        });
    });
});
