(async () => {
    const res = await fetch(window.downloadUrl);
    const allData = new Uint8Array(await res.arrayBuffer());
    const salt = allData.slice(0, 16);
    const iv = allData.slice(16, 28);
    const encData = allData.slice(28);
    const enc = new TextEncoder();
    const header = enc.encode('BKP-FILE');
    const decryptBtn = document.getElementById('decrypt-btn');
    const passInput = document.getElementById('password-input');
    decryptBtn.addEventListener('click', async () => {
        const password = passInput.value;
        if (!password) return;
        decryptBtn.disabled = true;
        passInput.disabled = true;
        const keyMaterial = await window.crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
        const key = await window.crypto.subtle.deriveKey(
            { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
            keyMaterial,
            { name: 'AES-GCM', length: 256 },
            false,
            ['decrypt']
        );
        try {
            const decrypted = await window.crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, encData);
            const decBytes = new Uint8Array(decrypted);
            let valid = header.length <= decBytes.length;
            for (let i = 0; i < header.length && valid; i++) {
                if (decBytes[i] !== header[i]) valid = false;
            }
            if (!valid) {
                document.getElementById('status').textContent = 'Incorrect password or corrupted file. The file was deleted from the server to avoid attempted password breaking. Ask author to upload the file again.';
                return;
            }
            const fileBytes = decBytes.slice(header.length);
            const blob = new Blob([fileBytes], { type: 'application/octet-stream' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = window.originalName;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(a.href);
            document.getElementById('status').textContent = 'Download complete.';
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
