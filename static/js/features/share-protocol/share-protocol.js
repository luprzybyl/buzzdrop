// The key-release handshake over HTTP (docs/true-one-time.md §6), so pages
// never speak it themselves: they hand over bytes and a password and turn the
// typed result into words. Nothing here touches the DOM.
//
// Creating a share is two-phase: POST /upload/begin mints file_id and the
// server share H, the bytes are sealed under Kp ‖ H, and POST /upload binds
// the verifier and stores the blob. Claiming one proves the password's
// verifier to /release, which hands H out once, then reports the receipt.

import { bytesToHex, hexToBytes } from '../../lib/hex.js';

// The server share H that /upload/begin mints (docs/true-one-time.md §6).
const SERVER_SHARE_BYTES = 32;

/**
 * @typedef {import('../../lib/hex.js').Bytes} Bytes
 * @typedef {import('../../lib/crypto.js').ShareCrypto} ShareCrypto
 * @typedef {import('../../lib/crypto.js').SealedShare} SealedShare
 */

/**
 * What is being shared: a file under its name, or a text note.
 * @typedef {{ kind: 'file', name: string, bytes: Bytes } | { kind: 'text', bytes: Bytes }} Payload
 */

/**
 * The options sent alongside the payload; an empty one is left out, which
 * the server treats as unset.
 * @typedef {object} ShareOptions
 * @property {string} expiry
 * @property {string} privateNote
 * @property {boolean} notifyOnOpen
 * @property {string} notificationEmail
 */

/**
 * @typedef {object} CreateDeps
 * @property {typeof fetch} fetch
 * @property {typeof XMLHttpRequest} XMLHttpRequest - the upload goes by XHR for upload.onprogress
 * @property {Pick<ShareCrypto, 'seal' | 'receiptHash'>} crypto
 * @property {{ begin: string, upload: string }} urls
 * @property {string} csrfToken
 * @property {(percent: number) => void} [onProgress] - 0 when the upload starts, then as it goes
 */

/**
 * How creating a share ended. A refusal carries the server's own words when
 * it gave any.
 * @typedef {{ kind: 'created', fileId: string }
 *   | { kind: 'refused', message: string }
 *   | { kind: 'unreachable' }} CreateResult
 */

/**
 * @typedef {object} ClaimDeps
 * @property {typeof fetch} fetch
 * @property {{ release: string, report: string }} urls
 */

/**
 * How a password attempt on a share ended. `retry` means a wrong password
 * with attempts left (`remaining` when the server said how many); `gone`
 * means the share can no longer be opened: claimed by someone already,
 * locked by this attempt, missing (deleted, expired or burned before this
 * attempt), refused by a failing server, or corrupted (the server released
 * its share, but the blob didn't decrypt with it).
 * @typedef {{ kind: 'opened', data: Bytes, receipt: Bytes }
 *   | { kind: 'retry', remaining: number | null }
 *   | { kind: 'gone', reason: 'claimed' | 'locked' | 'missing' | 'refused' | 'corrupted' }
 *   | { kind: 'unreachable' }} ClaimResult
 */

/**
 * What POST /upload/begin answers: the new share's id and the server share H
 * (hex).
 * @typedef {object} UploadBeginResponse
 * @property {string} file_id
 * @property {string} h
 */

/**
 * What POST /upload answers: the share's id on success, `{error}` otherwise.
 * @typedef {object} UploadResponse
 * @property {string} [file_id]
 * @property {string} [error]
 */

/**
 * What POST /release answers: `{h}` (the server share, hex) on a verifier
 * match; otherwise `{error}`, plus `attempts_remaining` on a 403 miss.
 * @typedef {object} ReleaseResponse
 * @property {string} [h]
 * @property {number} [attempts_remaining]
 * @property {string} [error]
 */

/**
 * Seal `payload` under `password` and upload it through the two-phase
 * handshake. Rejects only when sealing itself fails.
 * @param {Payload} payload
 * @param {string} password
 * @param {ShareOptions} options
 * @param {CreateDeps} deps
 * @returns {Promise<CreateResult>}
 */
export async function createShare(payload, password, options, deps) {
    const headers = { 'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': deps.csrfToken };

    let begun;
    try {
        begun = await deps.fetch(deps.urls.begin, { method: 'POST', headers });
    } catch {
        return { kind: 'unreachable' };
    }
    const handshakeRefused = /** @type {const} */ ({ kind: 'refused', message: 'The server refused the upload handshake.' });
    if (!begun.ok) return handshakeRefused;
    let fileId;
    let h;
    try {
        /** @type {UploadBeginResponse} */
        const body = await begun.json();
        fileId = body.file_id;
        h = hexToBytes(body.h);
        if (h.length !== SERVER_SHARE_BYTES) throw new Error('server share H has the wrong length');
    } catch {
        return handshakeRefused;
    }

    const { blob, verifier, receipt } = await deps.crypto.seal(payload.bytes, password, h);
    const form = new FormData();
    if (payload.kind === 'file') {
        form.append('file', new File([blob], payload.name));
    } else {
        form.append('note_text', toBase64(blob));
        form.append('type', 'text');
    }
    form.append('file_id', fileId);
    form.append('key_verifier', bytesToHex(verifier));
    // SHA-256 of the in-ciphertext receipt: the server stores the hash so
    // /report_decryption can prove the recipient really decrypted it.
    form.append('receipt_hash', await deps.crypto.receiptHash(receipt));
    appendOptions(form, options);

    return send(deps, form, headers);
}

/**
 * Prove `password` to /release, decrypt with the server share it releases,
 * and report the outcome to /report_decryption: the receipt when it opened,
 * a failure when the share is gone or out of reach. A wrong password with
 * attempts left reports nothing.
 * @param {SealedShare} sealed
 * @param {string} password
 * @param {ClaimDeps} deps
 * @returns {Promise<ClaimResult>}
 */
export async function claimShare(sealed, password, deps) {
    const result = await release(sealed, password, deps);
    if (result.kind === 'opened') report(deps, result.receipt);
    else if (result.kind !== 'retry') report(deps, null);
    return result;
}

/**
 * Download a share's blob and open its envelope; `unsupported` when it isn't
 * a share this page can read.
 * @param {string} url
 * @param {{ fetch: typeof fetch, crypto: Pick<ShareCrypto, 'open'> }} deps
 * @returns {Promise<{ kind: 'sealed', sealed: SealedShare } | { kind: 'unsupported' }>}
 */
export async function downloadShare(url, deps) {
    const response = await deps.fetch(url);
    const blob = new Uint8Array(await response.arrayBuffer());
    try {
        return { kind: 'sealed', sealed: deps.crypto.open(blob) };
    } catch {
        return { kind: 'unsupported' };
    }
}

/**
 * @param {SealedShare} sealed
 * @param {string} password
 * @param {ClaimDeps} deps
 * @returns {Promise<ClaimResult>}
 */
async function release(sealed, password, deps) {
    const attempt = await sealed.unlock(password);

    let response;
    try {
        response = await deps.fetch(deps.urls.release, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
            body: JSON.stringify({ v: bytesToHex(attempt.verifier) }),
        });
    } catch {
        return { kind: 'unreachable' };
    }

    /** @type {ReleaseResponse} */
    const body = await response.json().catch(() => ({}));
    if (response.status === 403) {
        // The server counts misses, so a typo is not fatal.
        const remaining = body.attempts_remaining;
        return { kind: 'retry', remaining: typeof remaining === 'number' ? remaining : null };
    }
    if (response.status === 410) return { kind: 'gone', reason: 'claimed' };
    if (response.status === 429) return { kind: 'gone', reason: 'locked' };
    // A deleted file, an expired or burned share all answer a uniform 404;
    // this attempt's own lockout gets the 429 above.
    if (response.status === 404) return { kind: 'gone', reason: 'missing' };

    if (!response.ok) return { kind: 'gone', reason: 'refused' };
    let h;
    try {
        h = hexToBytes(/** @type {string} */ (body.h));
    } catch {
        return { kind: 'gone', reason: 'refused' };
    }
    try {
        const { data, receipt } = await attempt.finish(h);
        return { kind: 'opened', data, receipt };
    } catch {
        // H is spent: the share can't be tried again.
        return { kind: 'gone', reason: 'corrupted' };
    }
}

/**
 * Fire-and-forget: the receipt lives inside the ciphertext, so only a
 * successful decryption can produce it; the server stores its SHA-256.
 * @param {ClaimDeps} deps
 * @param {Bytes | null} receipt
 */
function report(deps, receipt) {
    deps.fetch(deps.urls.report, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: receipt !== null, receipt: receipt && bytesToHex(receipt) }),
    }).catch(() => {});
}

/**
 * Upload the finished form by XHR, reporting progress.
 * @param {CreateDeps} deps
 * @param {FormData} form
 * @param {Record<string, string>} headers
 * @returns {Promise<CreateResult>}
 */
function send(deps, form, headers) {
    return new Promise((resolve) => {
        const xhr = new deps.XMLHttpRequest();
        xhr.open('POST', deps.urls.upload, true);
        for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);

        xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) deps.onProgress?.(Math.round((e.loaded / e.total) * 100));
        };
        xhr.onload = () => {
            /** @type {UploadResponse | null} */
            let body = null;
            try {
                body = JSON.parse(xhr.responseText);
            } catch {}
            if (xhr.status >= 200 && xhr.status < 300) {
                resolve(body?.file_id
                    ? { kind: 'created', fileId: body.file_id }
                    : { kind: 'refused', message: 'Upload succeeded but server returned invalid JSON' });
            } else {
                resolve({ kind: 'refused', message: body?.error || 'Upload failed' });
            }
        };
        xhr.onerror = () => resolve({ kind: 'unreachable' });

        deps.onProgress?.(0);
        xhr.send(form);
    });
}

/**
 * @param {FormData} form
 * @param {ShareOptions} options
 */
function appendOptions(form, options) {
    if (options.expiry) form.append('expiry', options.expiry);
    if (options.privateNote) form.append('private_note', options.privateNote);
    if (options.notifyOnOpen) form.append('notify_on_open', 'true');
    if (options.notificationEmail) form.append('notification_email', options.notificationEmail);
}

/**
 * Base64 in chunks: spreading a whole large blob into String.fromCharCode
 * overruns the engine's argument limit (JavaScriptCore's is low).
 * @param {Bytes} bytes
 * @returns {string}
 */
function toBase64(bytes) {
    const CHUNK = 0x8000;
    let binary = '';
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
}
