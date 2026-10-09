// --- Secure File Download & Decryption Logic ---
// This script handles the process of downloading, decrypting, and saving the file client-side
// Steps:
// 1. Download the encrypted file from the server
// 2. Wait for user to enter password and click 'Decrypt'
// 3. Prove the password to /release, receive the server share H,
//    then decrypt with Kp ‖ H (docs/true-one-time.md §6.4)
// 4. Save file to disk and notify server

import { copyWithFeedback } from '../../features/clipboard-feedback/index.js';
import { claimShare, downloadShare } from '../../features/share-protocol/index.js';
import * as shareCrypto from '../../lib/crypto.js';
import { takeFragmentPassword } from '../../lib/one-click-link.js';
import { required, requiredWindow } from '../../lib/required.js';

/** @typedef {import('../../lib/crypto.js').Bytes} Bytes */

/**
 * @typedef {object} ViewDeps
 * @property {typeof fetch} fetch
 * @property {Pick<import('../../lib/crypto.js').ShareCrypto, 'open'>} crypto
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
 * `fetch` is bound to the window: called unbound, as deps.fetch(...), the
 * browser's fetch throws "Illegal invocation".
 * @returns {ViewDeps}
 */
export function browserDeps() {
    return { fetch: window.fetch.bind(window), crypto: shareCrypto };
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

    const download = await downloadShare(downloadUrl, deps);
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

    if (download.kind === 'unsupported') {
        lockForm();
        status.textContent =
            'This share uses an unsupported format. Ask the author to upload it again.';
        return;
    }
    const { sealed } = download;

    // One-click links carry the password in the URL fragment.
    const fragmentPassword = takeFragmentPassword(window);
    if (fragmentPassword) {
        passInput.value = fragmentPassword;
        // Files show a press-Decrypt hint; notes render none.
        const passwordStatus = /** @type {HTMLElement | null} */ (root.querySelector('#password-status'));
        if (passwordStatus) passwordStatus.style.display = 'flex';
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

            // The status line also reports the decryption, so the copy's
            // message stays on it after the flash.
            const btn = required(root, '#copy-text-btn', 'button');
            btn.addEventListener('click', () => copyWithFeedback(btn, text, { status, what: 'Text', keepStatus: true }));
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
     * What the status line says when an attempt ends without the plaintext.
     * @param {Exclude<import('../../features/share-protocol/index.js').ClaimResult, {kind: 'opened'}>} result
     * @returns {string}
     */
    function failureMessage(result) {
        switch (result.kind) {
        case 'retry': {
            const { remaining } = result;
            const suffix = remaining === null
                ? ''
                : ` ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`;
            return `Incorrect password.${suffix}`;
        }
        case 'unreachable':
            return 'Could not reach the server to release the key.';
        case 'gone':
            return {
                claimed: 'This share has already been claimed.',
                locked: 'Too many incorrect attempts — this share is locked.',
                // A 404 means the share was gone before this attempt (e.g. a
                // link holder burned it); our own lockout is 'locked'.
                missing: 'This share no longer exists — it was deleted, has expired, '
                    + 'or was locked by wrong password attempts.',
                refused: 'The server refused to release the key.',
            }[result.reason];
        }
    }

    // Submitting the form (the Decrypt button or Enter in the field) attempts
    // the decryption in place; the form never navigates.
    decryptForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        const password = passInput.value;
        if (!password) return;
        lockForm();

        // The blob alone is mathematically dead: the password must be
        // proven to /release, which hands out the server share H once.
        let result;
        try {
            result = await claimShare(sealed, password, {
                fetch: deps.fetch,
                urls: { release: releaseUrl, report: reportDecryptionUrl },
            });
        } catch {
            status.textContent =
                'Incorrect password or corrupted file. Ask the author to upload the file again.';
            return;
        }
        if (result.kind === 'opened') {
            showPlaintext(result.data);
            return;
        }
        status.textContent = failureMessage(result);
        if (result.kind === 'retry') {
            decryptBtn.disabled = false;
            passInput.disabled = false;
            passInput.select();
        }
    });
    // The template renders the button disabled so nothing submits natively
    // while the share downloads; only now does submit stay on the page.
    decryptBtn.disabled = false;
    // Focus the decrypt button so user can easily press Enter to proceed
    if (fragmentPassword) decryptBtn.focus();
}
