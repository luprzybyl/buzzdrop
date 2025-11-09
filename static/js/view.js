// --- Secure File Download & Decryption Logic ---
// This script handles the process of downloading, decrypting, and saving the file client-side
// Steps:
// 1. Download the encrypted file (salt + iv + ciphertext) from the server
// 2. Wait for user to enter password and click 'Decrypt'
// 3. Derive key from password using PBKDF2 and the salt
// 4. Decrypt using AES-GCM and IV
// 5. Validate the decrypted data (check for header)
// 6. Save file to disk and notify server

(async () => {
    // Download the encrypted file as a single Uint8Array
    const res = await fetch(window.downloadUrl);
    const allData = new Uint8Array(await res.arrayBuffer());
    // Extract salt (first 16 bytes), IV (next 12 bytes), and encrypted data (rest)
    const salt = allData.slice(0, 16);
    const iv = allData.slice(16, 28);
    const encData = allData.slice(28);
    const enc = new TextEncoder();
    const header = enc.encode('BKP-FILE'); // Magic bytes for integrity check
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
        // Derive key from password using PBKDF2 and salt
        const keyMaterial = await window.crypto.subtle.importKey(
            'raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']
        );
        const key = await window.crypto.subtle.deriveKey(
            { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
            keyMaterial,
            { name: 'AES-GCM', length: 256 },
            false,
            ['decrypt']
        );
        try {
            // Attempt to decrypt using AES-GCM and IV
            const decrypted = await window.crypto.subtle.decrypt(
                { name: 'AES-GCM', iv }, key, encData
            );
            const decBytes = new Uint8Array(decrypted);
            // Validate magic header to check integrity
            let valid = header.length <= decBytes.length;
            for (let i = 0; i < header.length && valid; i++) {
                if (decBytes[i] !== header[i]) valid = false;
            }
            if (!valid) {
                document.getElementById('status').textContent = 'Incorrect password or corrupted file. The file was deleted from the server to avoid attempted password breaking. Ask author to upload the file again.';
                return;
            }
            // If valid, extract file content
            const fileBytes = decBytes.slice(header.length);

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
        }
    });
})();
