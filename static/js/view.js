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

(async () => {
    // Download the encrypted file as a single Uint8Array
    const res = await fetch(window.downloadUrl);
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

    // Auto-fill password from sessionStorage if available (from URL fragment)
    const savedPassword = sessionStorage.getItem('downloadPassword');
    if (savedPassword) {
        passInput.value = savedPassword;
        sessionStorage.removeItem('downloadPassword');
        // Show status message
        const statusMsg = document.getElementById('password-status');
        if (statusMsg) {
            statusMsg.style.display = 'block';
        }
        // Focus the decrypt button so user can easily press Enter to proceed
        decryptBtn.focus();
    }

    function reportDecryption(success) {
        fetch(window.reportDecryptionUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ success })
        }).catch(() => {});
    }

    function showPlaintext(fileBytes) {
        // Check if this is a text note or file
        if (window.fileType === 'text') {
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
            a.download = window.originalName;
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
    async function decryptOracle(password) {
        const v = await cryptoService.deriveVerifier(password, salt);

        let res;
        try {
            res = await fetch(window.releaseUrl, {
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
        return cryptoService.decrypt(encryptedData, password, h);
    }

    // When user clicks 'Decrypt', attempt to decrypt the file
    decryptBtn.addEventListener('click', async () => {
        const password = passInput.value;
        if (!password) return;
        decryptBtn.disabled = true;
        passInput.disabled = true;

        try {
            const fileBytes = await decryptOracle(password);
            if (fileBytes === null) {
                // Wrong password, attempts remaining — let them retry.
                decryptBtn.disabled = false;
                passInput.disabled = false;
                passInput.select();
                return;
            }

            showPlaintext(fileBytes);

            // Notify server that decryption was successful
            reportDecryption(true);
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
