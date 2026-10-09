// The share-protocol feature on its own, against the protocol fake: what the
// pages can't show through their screens (docs/frontend-test-strategy.md §7,
// JS integration).
import { describe, expect, it, vi } from 'vitest';
import { claimShare, createShare, downloadShare } from '../../../static/js/features/share-protocol/index.js';
import * as shareCrypto from '../../../static/js/lib/crypto.js';
import { makeProtocolFake } from '../support/protocol-fake.js';
import { makeStubCrypto } from '../support/stub-crypto.js';

const PASSWORD = 'abacus-abdomen-abdominal-abide-abiding-ability';
const CSRF_TOKEN = 'fixture-csrf-token';
const NO_OPTIONS = { expiry: '', privateNote: '', notifyOnOpen: false, notificationEmail: '' };

/**
 * @param {ReturnType<typeof makeProtocolFake>} fake
 * @param {string} fileId
 */
const claimDeps = (fake, fileId) => ({
    fetch: fake.fetch,
    urls: { release: `/release/${fileId}`, report: `/report_decryption/${fileId}` },
});

describe('share protocol', () => {
    it('a successful open runs PBKDF2 once', { timeout: 30_000 }, async () => {
        const fake = makeProtocolFake();
        const fileId = await fake.seedShare({ password: PASSWORD, plaintext: 'hello' });
        const download = await downloadShare(`/download/${fileId}`, { fetch: fake.fetch, crypto: shareCrypto });
        if (download.kind !== 'sealed') throw new Error('the seeded share did not open');
        const deriveBits = vi.spyOn(globalThis.crypto.subtle, 'deriveBits');

        const result = await claimShare(download.sealed, PASSWORD, claimDeps(fake, fileId));

        expect(result.kind).toBe('opened');
        const pbkdf2 = deriveBits.mock.calls.filter(([algorithm]) => /** @type {Algorithm} */ (algorithm).name === 'PBKDF2');
        expect(pbkdf2).toHaveLength(1);
    });

    // Spreading a blob this size into String.fromCharCode overruns the
    // engine's argument limit.
    it('a large note uploads and arrives whole', async () => {
        const fake = makeProtocolFake({ csrfToken: CSRF_TOKEN });
        const crypto = makeStubCrypto();
        const bytes = new Uint8Array(2 * 1024 * 1024).fill(97);

        const result = await createShare({ kind: 'text', bytes }, PASSWORD, NO_OPTIONS, {
            fetch: fake.fetch,
            XMLHttpRequest: fake.XMLHttpRequest,
            crypto,
            urls: { begin: '/upload/begin', upload: '/upload' },
            csrfToken: CSRF_TOKEN,
        });

        if (result.kind !== 'created') throw new Error(`the note was not created: ${JSON.stringify(result)}`);
        const download = await downloadShare(`/download/${result.fileId}`, { fetch: fake.fetch, crypto });
        if (download.kind !== 'sealed') throw new Error('the note did not open');
        const opened = await claimShare(download.sealed, PASSWORD, claimDeps(fake, result.fileId));
        expect(opened.kind === 'opened' && opened.data).toEqual(bytes);
    });
});
