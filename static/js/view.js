// --- Secure File Download & Decryption Logic ---
// This script handles the process of downloading, decrypting, and saving the file client-side
// Steps:
// 1. Download the encrypted file from the server
// 2. Wait for user to enter password and click 'Decrypt'
// 3. Prove the password to /release, receive the server share H,
//    then decrypt with Kp ‖ H (docs/true-one-time.md §6.4)
// 4. Save file to disk and notify server

import { CryptoService, bytesToHex, hexToBytes } from './crypto.js';

const cryptoService = new CryptoService();

// Per-share config injected as a type="application/json" data island —
// CSP does not treat it as script, so script-src can stay 'self'.
const {
    downloadUrl,
    releaseUrl,
    reportDecryptionUrl,
    originalName,
    fileType,
} = JSON.parse(document.getElementById('view-config-json').textContent);

(async () => {
    // Download the encrypted file as a single Uint8Array
    const res = await fetch(downloadUrl);
    const encryptedData = new Uint8Array(await res.arrayBuffer());
    const decryptBtn = document.getElementById('decrypt-btn');
    const passInput = document.getElementById('password-input');

    let salt;
    try {
        ({ salt } = cryptoService.parseBlob(encryptedData));
    } catch (err) {
        decryptBtn.disabled = true;
        passInput.disabled = true;
        document.getElementById('status').textContent =
            'This share uses an unsupported format. Ask the author to upload it again.';
        return;
    }

    // One-click links carry the password in the URL fragment — read it
    // once and scrub it from the address bar and history entry; nothing is
    // persisted.
    const fragmentHash = window.location.hash;
    if (fragmentHash.length > 1) {
        window.history.replaceState(
            null, '', window.location.pathname + window.location.search);
        let fragmentPassword = null;
        try {
            fragmentPassword = decodeURIComponent(fragmentHash.substring(1));
        } catch (err) {
            fragmentPassword = null;
        }
        if (fragmentPassword) {
            passInput.value = fragmentPassword;
            // Show status message
            const statusMsg = document.getElementById('password-status');
            if (statusMsg) {
                statusMsg.style.display = 'flex';
            }
            // Focus the decrypt button so user can easily press Enter to proceed
            decryptBtn.focus();
        }
    }

    function reportDecryption(success, receiptHex) {
        fetch(reportDecryptionUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            // The receipt lives inside the ciphertext — only a successful
            // decryption can produce it; the server stores its SHA-256.
            body: JSON.stringify({ success, receipt: receiptHex || null })
        }).catch(() => {});
    }

    function showPlaintext(fileBytes) {
        // Check if this is a text note or file
        if (fileType === 'text') {
            // Display text in the page
            const text = new TextDecoder().decode(fileBytes);
            document.getElementById('text-content').textContent = text;
            document.getElementById('text-display').style.display = 'block';
            document.getElementById('status').textContent = 'Text decrypted successfully.';
            document.getElementById('password-input').style.display = 'none';
            document.getElementById('decrypt-btn').style.display = 'none';

            // Add copy functionality
            document.getElementById('copy-text-btn').addEventListener('click', () => {
                navigator.clipboard.writeText(text).then(() => {
                    const btn = document.getElementById('copy-text-btn');
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
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = originalName;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(a.href);
            document.getElementById('status').textContent = 'Download complete.';
        }
    }

    // The blob alone is mathematically dead — the password must be proven
    // to /release, which hands out the server share H once. Returns the
    // decrypted bytes, or null when the attempt failed in a recoverable
    // way (wrong password with attempts left).
    async function decryptKeyRelease(password) {
        const v = await cryptoService.deriveVerifier(password, salt);

        let res;
        try {
            res = await fetch(releaseUrl, {
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

        const body = await res.json().catch(() => ({}));

        if (res.status === 403) {
            // Verifier miss — the server counts attempts, so a typo is not
            // fatal anymore; report how many tries remain and let them retry.
            const remaining = body.attempts_remaining;
            const suffix = (typeof remaining === 'number')
                ? ` ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`
                : '';
            document.getElementById('status').textContent =
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
        if (!res.ok || typeof body.h !== 'string') {
            throw new Error('The server refused to release the key.');
        }

        const h = hexToBytes(body.h);
        const { data, receipt } = await cryptoService.decrypt(
            encryptedData, password, h);
        return { data, receipt };
    }

    // When user clicks 'Decrypt', attempt to decrypt the file
    decryptBtn.addEventListener('click', async () => {
        const password = passInput.value;
        if (!password) return;
        decryptBtn.disabled = true;
        passInput.disabled = true;

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
            document.getElementById('status').textContent =
                err && err.message
                    ? err.message
                    : 'Incorrect password or corrupted file. Ask the author to upload the file again.';
            // Notify server that decryption failed
            reportDecryption(false);
        }
    });
})();
