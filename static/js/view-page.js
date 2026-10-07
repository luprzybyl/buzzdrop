// --- Secure File Download & Decryption Logic ---
// This script handles the process of downloading, decrypting, and saving the file client-side
// Steps:
// 1. Download the encrypted file from the server
// 2. Wait for user to enter password and click 'Decrypt'
// 3. Prove the password to /release, receive the server share H,
//    then decrypt with Kp ‖ H (docs/true-one-time.md §6.4)
// 4. Save file to disk and notify server

import { CryptoService, bytesToHex, hexToBytes } from './crypto.js';
import { readFragmentPassword } from './fragment-password.js';
import { required, requiredWindow } from './required.js';

/** @typedef {import('./crypto.js').Bytes} Bytes */

/**
 * @typedef {object} ViewDeps
 * @property {typeof fetch} fetch
 * @property {Pick<CryptoService, 'parseBlob' | 'deriveVerifier' | 'decrypt'>} crypto
 */

/**
 * The per-share config the template injects as `view-config-json`.
 * @typedef {object} ViewConfig
 * @property {string} downloadUrl
 * @property {string} releaseUrl
 * @property {string} reportDecryptionUrl
 * @property {string} originalName
 * @property {'file' | 'text'} fileType
 */

/**
 * What POST /release answers: `{h}` (the server share, hex) on a verifier
 * match; otherwise `{error}`, plus `attempts_remaining` on a 403 miss.
 * 404 means the file or its share is gone (deleted, expired or burned).
 * @typedef {object} ReleaseResponse
 * @property {string} [h]
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
 * Downloads the share, then wires up decryption. Resolves once the page is
 * ready for a password.
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
    } = JSON.parse(required(root, '#view-config-json', 'script').text);

    // Download the encrypted file as a single Uint8Array
    const res = await deps.fetch(downloadUrl);
    const encryptedData = new Uint8Array(await res.arrayBuffer());
    const decryptForm = required(root, '#decrypt-form', 'form');
    const decryptBtn = required(root, '#decrypt-btn', 'button');
    const passInput = required(root, '#password-input', 'input');
    const status = required(root, '#status', 'p');
    // Counts the attempts before the first one; after that the status line
    // says what is left, so the warning would only contradict it.
    const attemptsWarning = required(root, '#attempts-warning', 'p');

    // Shuts the password step while a try is in flight, or for good when the
    // share can't be opened; the attempts warning doesn't come back either way.
    function lockForm() {
        decryptBtn.disabled = true;
        passInput.disabled = true;
        attemptsWarning.hidden = true;
    }

    /** @type {Bytes} */
    let salt;
    try {
        ({ salt } = cryptoService.parseBlob(encryptedData));
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

            // Add copy functionality
            const btn = required(root, '#copy-text-btn', 'button');
            btn.addEventListener('click', () => {
                window.navigator.clipboard.writeText(text).then(() => {
                    const originalText = btn.textContent;
                    btn.textContent = 'Copied!';
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
     * The blob alone is mathematically dead — the password must be proven
     * to /release, which hands out the server share H once. Returns the
     * decrypted bytes, or null when the attempt failed in a recoverable
     * way (wrong password with attempts left).
     * @param {string} password
     * @returns {Promise<{data: Bytes, receipt: Bytes} | null>}
     */
    async function decryptKeyRelease(password) {
        const v = await cryptoService.deriveVerifier(password, salt);

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
            throw new Error('Could not reach the server to release the key.');
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
        if (!res.ok || typeof body.h !== 'string') {
            throw new Error('The server refused to release the key.');
        }

        const h = hexToBytes(body.h);
        const { data, receipt } = await cryptoService.decrypt(
            encryptedData, password, h);
        return { data, receipt };
    }

    // Submitting the form (the Decrypt button or Enter in the field) attempts
    // the decryption in place; the form never navigates.
    decryptForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        const password = passInput.value;
        if (!password) return;
        lockForm();

        try {
            const result = await decryptKeyRelease(password);
            if (result === null) {
                // Wrong password, attempts remaining — let them retry.
                decryptBtn.disabled = false;
                passInput.disabled = false;
                passInput.select();
                return;
            }

            showPlaintext(result.data);

            // Notify server that decryption was successful — the receipt
            // proves it (it's only reachable inside the plaintext).
            reportDecryption(true, bytesToHex(result.receipt));
        } catch (err) {
            const error = /** @type {Error | undefined} */ (err);
            status.textContent =
                error && error.message
                    ? error.message
                    : 'Incorrect password or corrupted file. Ask the author to upload the file again.';
            // Notify server that decryption failed
            reportDecryption(false);
        }
    });
    // The template renders the button disabled so nothing submits natively
    // while the share downloads; only now does submit stay on the page.
    decryptBtn.disabled = false;
    // Focus the decrypt button so user can easily press Enter to proceed
    if (fragmentPassword) decryptBtn.focus();
}
