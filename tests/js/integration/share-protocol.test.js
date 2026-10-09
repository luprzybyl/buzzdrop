// The share-protocol feature on its own, against the protocol fake: what the
// pages can't show through their screens (docs/frontend-test-strategy.md §7,
// JS integration).
import { describe, expect, it, vi } from 'vitest';
import { claimShare, createShare } from '../../../static/js/features/share-protocol/index.js';
import * as shareCrypto from '../../../static/js/lib/crypto.js';
import { makeProtocolFake } from '../support/protocol-fake.js';

const PASSWORD = 'abacus-abdomen-abdominal-abide-abiding-ability';
const CSRF_TOKEN = 'fixture-csrf-token';
const NO_OPTIONS = { expiry: '', privateNote: '', notifyOnOpen: false, notificationEmail: '' };
// Each case seals and unlocks with real 600k-iteration PBKDF2.
const TEST_TIMEOUT = 30_000;

/** @param {ReturnType<typeof makeProtocolFake>} fake */
const createDeps = (fake) => ({
    fetch: fake.fetch,
    XMLHttpRequest: fake.XMLHttpRequest,
    crypto: shareCrypto,
    urls: { begin: '/upload/begin', upload: '/upload' },
    csrfToken: CSRF_TOKEN,
});

/**
 * The salt-only share the view page builds from the server-rendered config:
 * the fake seeded the blob, so its envelope salt sits at bytes 4..20.
 * @param {ReturnType<typeof makeProtocolFake>} fake
 * @param {string} fileId
 */
const saltedShare = (fake, fileId) =>
    shareCrypto.openSalted(fake.state.files.get(fileId)?.blob?.slice(4, 20) ?? new Uint8Array(16));

/**
 * @param {ReturnType<typeof makeProtocolFake>} fake
 * @param {string} fileId
 */
const claimDeps = (fake, fileId) => ({
    fetch: fake.fetch,
    urls: {
        release: `/release/${fileId}`,
        download: `/download/${fileId}`,
        report: `/report_decryption/${fileId}`,
    },
});

describe('share protocol', { timeout: TEST_TIMEOUT }, () => {
    it('a successful open runs PBKDF2 once', async () => {
        const fake = makeProtocolFake();
        const fileId = await fake.seedShare({ password: PASSWORD, plaintext: 'hello' });
        const deriveBits = vi.spyOn(globalThis.crypto.subtle, 'deriveBits');

        const result = await claimShare(saltedShare(fake, fileId), PASSWORD, claimDeps(fake, fileId));

        expect(result.kind).toBe('opened');
        const pbkdf2 = deriveBits.mock.calls.filter(([algorithm]) => /** @type {Algorithm} */ (algorithm).name === 'PBKDF2');
        expect(pbkdf2).toHaveLength(1);
    });

    it('a failed download retries with the already-released ticket', async () => {
        const fake = makeProtocolFake();
        const fileId = await fake.seedShare({ password: PASSWORD, plaintext: 'hello' });
        const sealed = saltedShare(fake, fileId);
        fake.failNext('/download', 'network');

        const first = await claimShare(sealed, PASSWORD, claimDeps(fake, fileId));
        expect(first.kind).toBe('unreachable');

        const second = await claimShare(sealed, PASSWORD, claimDeps(fake, fileId));

        expect(second.kind).toBe('opened');
        // The retry must not spend another release — H is released once.
        expect(fake.log.filter((request) => request.url.includes('/release/'))).toHaveLength(1);
    });

    // Spreading a blob this size into String.fromCharCode overruns the
    // engine's argument limit.
    it('a large note uploads and arrives whole', async () => {
        const fake = makeProtocolFake({ csrfToken: CSRF_TOKEN });
        const bytes = new Uint8Array(2 * 1024 * 1024).fill(97);

        const result = await createShare({ kind: 'text', bytes }, PASSWORD, NO_OPTIONS, createDeps(fake));

        if (result.kind !== 'created') throw new Error(`the note was not created: ${JSON.stringify(result)}`);
        const opened = await claimShare(saltedShare(fake, result.fileId), PASSWORD, claimDeps(fake, result.fileId));
        expect(opened.kind === 'opened' && opened.data).toEqual(bytes);
    });

    it('a server share of the wrong length is a refused handshake', async () => {
        const fake = makeProtocolFake({ csrfToken: CSRF_TOKEN });
        fake.failNext('/upload/begin', { status: 200, body: { file_id: crypto.randomUUID(), h: 'ab'.repeat(16) } });

        const result = await createShare({ kind: 'text', bytes: new Uint8Array([1]) }, PASSWORD, NO_OPTIONS, createDeps(fake));

        expect(result).toEqual({ kind: 'refused', message: 'The server refused the upload handshake.' });
    });
});
