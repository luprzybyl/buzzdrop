// --- Secure File Download & Decryption Logic ---
// This script handles the process of proving the password, downloading, and
// decrypting the file client-side (docs/true-one-time.md §6.4).
// Steps:
// 1. The visitor types the password; the client derives V and proves it
//    to /release, receiving the server share H plus a one-time download
//    ticket. The ciphertext is NOT fetched upfront — opening the page
//    must not consume the share.
// 2. With the ticket, the client streams /download (progress in the
//    status line), derives file_key = HKDF(Kp ‖ H) and decrypts locally.
// 3. The plaintext is saved as a download and the receipt reported to
//    /report_decryption.

import { CryptoService, bytesToHex, hexToBytes } from './crypto.js';
import { readFragmentPassword } from './fragment-password.js';
import { required, requiredWindow } from './required.js';

/** @typedef {import('./crypto.js').Bytes} Bytes */

/**
 * @typedef {object} ViewDeps
 * @property {typeof fetch} fetch
 * @property {Pick<CryptoService, 'deriveKeyReleaseKeys' | 'deriveFileKey' | 'decryptWithKey'>} crypto
 */

/**
 * The per-share config the template injects as `view-config-json`.
 * @typedef {object} ViewConfig
 * @property {string} downloadUrl
 * @property {string} releaseUrl
 * @property {string} reportDecryptionUrl
 * @property {string} originalName
 * @property {'file' | 'text'} fileType
 * @property {string} salt - hex BKV3 salt: the only non-secret the
 *   envelope carries, handed over so V can be derived before the download
 */

/**
 * What POST /release answers: `{h, ticket}` (the server share and the
 * one-time /download credential, hex) on a verifier match; otherwise
 * `{error}`, plus `attempts_remaining` on a 403 miss. 404 means the file
 * or its share is gone (deleted, expired or burned).
 * @typedef {object} ReleaseResponse
 * @property {string} [h]
 * @property {string} [ticket]
 * @property {number} [attempts_remaining]
 * @property {string} [error]
 */

/**
 * `fetch` is bound to the window: called unbound, as deps.fetch(...), the
 * browser's fetch throws "Illegal invocation".
 * @returns {ViewDeps}
 */
export function browserDeps() {
    return { fetch: window.fetch.bind(window), crypto: new CryptoService() };
}

/**
 * Wires up password → release → download → decrypt. Resolves once the
 * page is ready for a password — no share traffic happens before then.
 * @param {Document} root - the view.html document
 * @param {ViewDeps} deps
 * @returns {Promise<void>}
 */
export async function initView(root, deps) {
    const window = requiredWindow(root);
    const cryptoService = deps.crypto;

    /**
     * Per-share config injected as a type="application/json" data island —
     * CSP does not treat it as script, so script-src can stay 'self'.
     * @type {ViewConfig}
     */
    const {
        downloadUrl,
        releaseUrl,
        reportDecryptionUrl,
        originalName,
        fileType,
        salt: saltHex,
    } = JSON.parse(required(root, '#view-config-json', 'script').text);

    const decryptForm = required(root, '#decrypt-form', 'form');
    const decryptBtn = required(root, '#decrypt-btn', 'button');
    const passInput = required(root, '#password-input', 'input');
    const status = required(root, '#status', 'p');
    // Counts the attempts before the first one; after that the status line
    // says what is left, so the warning would only contradict it.
    const attemptsWarning = required(root, '#attempts-warning', 'p');

    // Shuts the password step while a try is in flight, or for good when the
    // share can't be opened; the attempts warning doesn't come back either way.
    // The field stops pointing at it too: a description reference reads even
    // hidden text, so it would keep announcing the count it no longer shows.
    function lockForm() {
        decryptBtn.disabled = true;
        passInput.disabled = true;
        attemptsWarning.hidden = true;
        passInput.removeAttribute('aria-describedby');
    }

    /** @type {Bytes} */
    let salt;
    try {
        salt = hexToBytes(saltHex);
    } catch (err) {
        lockForm();
        status.textContent =
            'This share uses an unsupported format. Ask the author to upload it again.';
        return;
    }

    // One-click links carry the password in the URL fragment — read it
    // once and scrub it from the address bar and history entry; nothing is
    // persisted.
    const fragmentPassword = readFragmentPassword(window.location.hash);
    if (window.location.hash.length > 1) {
        window.history.replaceState(
            null, '', window.location.pathname + window.location.search);
        if (fragmentPassword) {
            passInput.value = fragmentPassword;
            // Files show a press-Decrypt hint; notes render none.
            const passwordStatus = /** @type {HTMLElement | null} */ (root.querySelector('#password-status'));
            if (passwordStatus) passwordStatus.style.display = 'flex';
        }
    }

    /**
     * @param {boolean} success
     * @param {string} [receiptHex]
     */
    function reportDecryption(success, receiptHex) {
        deps.fetch(reportDecryptionUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            // The receipt lives inside the ciphertext — only a successful
            // decryption can produce it; the server stores its SHA-256.
            body: JSON.stringify({ success, receipt: receiptHex || null })
        }).catch(() => {});
    }

    /** @param {Bytes} fileBytes */
    function showPlaintext(fileBytes) {
        // Check if this is a text note or file
        if (fileType === 'text') {
            // Display text in the page
            const text = new TextDecoder().decode(fileBytes);
            required(root, '#text-content', 'pre').textContent = text;
            required(root, '#text-display', 'div').style.display = 'block';
            status.textContent = 'Text decrypted successfully.';
            decryptForm.style.display = 'none';

            // Add copy functionality. The button's name stays "Copy text", so
            // the flash on it is visual; the status line announces the copy.
            const btn = required(root, '#copy-text-btn', 'button');
            btn.addEventListener('click', () => {
                window.navigator.clipboard.writeText(text).then(() => {
                    const originalText = btn.textContent;
                    btn.textContent = 'Copied!';
                    status.textContent = 'Text copied to clipboard.';
                    setTimeout(() => {
                        btn.textContent = originalText;
                    }, 2000);
                });
            });
        } else {
            // Trigger file download
            const blob = new Blob([fileBytes], { type: 'application/octet-stream' });
            const a = root.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = originalName;
            root.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(a.href);
            status.textContent = 'Download complete.';
        }
    }

    /**
     * Derives V and asks /release for H — the blob itself stays on the
     * server until the password is proven. Errors marked `retryable`
     * (network drop, 5xx) let the visitor press Decrypt again; the rest
     * are terminal. Returns {kp, h, ticket}, or null on a counted miss
     * with attempts left.
     * @param {string} password
     * @returns {Promise<{kp: Bytes, h: Bytes, ticket: string} | null>}
     */
    async function attemptRelease(password) {
        status.textContent = 'Checking password…';
        const { kp, v } = await cryptoService.deriveKeyReleaseKeys(password, salt);

        let res;
        try {
            res = await deps.fetch(releaseUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Requested-With': 'XMLHttpRequest',
                },
                body: JSON.stringify({ v: bytesToHex(v) }),
            });
        } catch (err) {
            throw Object.assign(
                new Error('Could not reach the server to release the key.'),
                { retryable: true });
        }

        /** @type {ReleaseResponse} */
        const body = await res.json().catch(() => ({}));

        if (res.status === 403) {
            // Verifier miss — the server counts attempts, so a typo is not
            // fatal anymore; report how many tries remain and let them retry.
            const remaining = body.attempts_remaining;
            const suffix = (typeof remaining === 'number')
                ? ` ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`
                : '';
            status.textContent =
                `Incorrect password.${suffix}`;
            return null;
        }
        if (res.status === 410) {
            throw new Error('This share has already been claimed.');
        }
        if (res.status === 429) {
            throw new Error(
                'Too many incorrect attempts — this share is locked.');
        }
        if (res.status === 404) {
            // A deleted file, an expired or burned share all answer a uniform
            // 404. Our own lockout gets the 429 above; a 404 means the share
            // was gone before this attempt (e.g. a link holder burned it).
            throw new Error(
                'This share no longer exists — it was deleted, has expired, '
                + 'or was locked by wrong password attempts.');
        }
        if (
            !res.ok
            || typeof body.h !== 'string'
            || typeof body.ticket !== 'string'
        ) {
            throw Object.assign(
                new Error('The server refused to release the key.'),
                { retryable: res.status >= 500 });
        }

        return { kp, h: hexToBytes(body.h), ticket: body.ticket };
    }

    /**
     * Streams the ciphertext behind the release ticket, reporting progress
     * in the status line. A failed read leaves the ticket usable, so the
     * same Decrypt press can retry — the server claims the share only when
     * the fetch reaches it.
     * @param {string} ticket
     * @returns {Promise<Bytes>}
     */
    async function downloadCiphertext(ticket) {
        let res;
        try {
            res = await deps.fetch(downloadUrl, {
                headers: { 'X-Download-Ticket': ticket },
            });
        } catch (err) {
            throw new Error('The download failed — press Decrypt to retry.');
        }
        if (res.redirected || res.status === 404 || res.status === 410) {
            throw Object.assign(new Error(
                'This share no longer exists — it was deleted, has expired, '
                + 'or was already claimed.'), { terminal: true });
        }
        if (!res.ok) {
            throw new Error('The download failed — press Decrypt to retry.');
        }

        const total = Number(res.headers.get('Content-Length')) || 0;
        const reader = res.body && res.body.getReader ? res.body.getReader() : null;
        if (!reader) {
            status.textContent = 'Downloading encrypted file…';
            return new Uint8Array(await res.arrayBuffer());
        }

        /** @type {Bytes[]} */
        const chunks = [];
        let received = 0;
        let shown = '';
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            received += value.length;
            const progress = total
                ? `Downloading encrypted file… ${Math.floor((received * 100) / total)}%`
                : `Downloading encrypted file… ${(received / 1048576).toFixed(1)} MB`;
            if (progress !== shown) {
                shown = progress;
                status.textContent = progress;
            }
        }

        const data = new Uint8Array(received);
        let offset = 0;
        for (const chunk of chunks) {
            data.set(chunk, offset);
            offset += chunk.length;
        }
        return data;
    }

    /** @type {{kp: Bytes, h: Bytes, ticket: string} | null} */
    let released = null;
    /** @type {Bytes | null} */
    let encryptedData = null;

    // Submitting the form (the Decrypt button or Enter in the field) attempts
    // the decryption in place; the form never navigates.
    decryptForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (!released && !passInput.value) return;
        lockForm();

        try {
            if (!released) {
                released = await attemptRelease(passInput.value);
                if (!released) {
                    // Wrong password, attempts remaining — let them retry.
                    decryptBtn.disabled = false;
                    passInput.disabled = false;
                    passInput.select();
                    return;
                }
            }

            if (!encryptedData) {
                encryptedData = await downloadCiphertext(released.ticket);
            }

            status.textContent = 'Decrypting…';
            const fileKey = await cryptoService.deriveFileKey(
                released.kp, released.h, salt);
            const { data, receipt } = await cryptoService.decryptWithKey(
                encryptedData, fileKey);

            showPlaintext(data);

            // Notify server that decryption was successful — the receipt
            // proves it (it's only reachable inside the plaintext).
            reportDecryption(true, bytesToHex(receipt));
        } catch (err) {
            const error = /** @type {Error & { retryable?: boolean, terminal?: boolean } | undefined} */ (err);
            const message = error && error.message ? error.message : '';
            status.textContent = /unsupported share format/i.test(message)
                ? 'This share uses an unsupported format. Ask the author to upload it again.'
                : message || 'Incorrect password or corrupted file. Ask the author to upload the file again.';
            // Notify server that decryption failed
            reportDecryption(false);
            if (!released) {
                // A retryable release failure (dropped request, 5xx) —
                // the password may be right; give it another press.
                if (error && error.retryable) {
                    decryptBtn.disabled = false;
                    passInput.disabled = false;
                }
            } else if (!encryptedData && !(error && error.terminal)) {
                // The ticket survives a failed fetch — Decrypt retries the
                // download without re-proving the password.
                decryptBtn.disabled = false;
            }
        }
    });
    // The template renders the button disabled so nothing submits natively
    // before this listener exists; the share stays untouched until then.
    decryptBtn.disabled = false;
    // Focus the decrypt button so user can easily press Enter to proceed
    if (fragmentPassword) decryptBtn.focus();
}
