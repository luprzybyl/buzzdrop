// --- Secure File Download & Decryption Logic ---
// This script handles the process of downloading, decrypting, and saving the file client-side
// Steps:
// 1. Download the encrypted file from the server
// 2. Wait for user to enter password and click 'Decrypt'
// 3. Use CryptoService to decrypt
// 4. Save file to disk and notify server

import { CryptoService } from './crypto.js';

const cryptoService = new CryptoService();

(async () => {
    // Download the encrypted file as a single Uint8Array
    const res = await fetch(window.downloadUrl);
    const encryptedData = new Uint8Array(await res.arrayBuffer());
    const decryptBtn = document.getElementById('decrypt-btn');
    const passInput = document.getElementById('password-input');

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

    // When user clicks 'Decrypt', attempt to decrypt the file
    decryptBtn.addEventListener('click', async () => {
        const password = passInput.value;
        if (!password) return;
        decryptBtn.disabled = true;
        passInput.disabled = true;
        
        try {
            // Decrypt using CryptoService
            const fileBytes = await cryptoService.decrypt(encryptedData, password);

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

            // Notify server that decryption was successful
            fetch(window.reportDecryptionUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ success: true })
            }).catch(() => {});
        } catch (err) {
            document.getElementById('status').textContent = 'Incorrect password or corrupted file. The file was deleted from the server to avoid attempted password breaking. Ask author to upload the file again.';
            // Notify server that decryption failed
            fetch(window.reportDecryptionUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ success: false })
            }).catch(() => {});
        }
    });
})();
