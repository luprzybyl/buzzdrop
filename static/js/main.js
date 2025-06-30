// Parse allowed file extensions from a hidden JSON element injected by the server
const allowedExtensions = JSON.parse(document.getElementById('allowed-extensions-json').textContent);

// --- File Upload Logic ---
if (document.querySelector('form')) {
    // Validate file extension when a file is selected
    document.getElementById('file').addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const ext = file.name.split('.').pop().toLowerCase();
        if (!allowedExtensions.includes(ext)) {
            alert('File type not allowed');
            e.target.value = '';
        }
    });

    // Handle form submission: encrypt file client-side, then upload
    document.querySelector('form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const fileInput = document.getElementById('file');
        const passInput = document.getElementById('password');
        const file = fileInput.files[0];
        const password = passInput.value;
        if (!file || !password) return;

        // --- ENCRYPTION WORKFLOW ---
        // 1. Setup encoder, salt, and IV for crypto
        const enc = new TextEncoder();
        const salt = window.crypto.getRandomValues(new Uint8Array(16)); // For PBKDF2 key derivation
        const iv = window.crypto.getRandomValues(new Uint8Array(12));   // For AES-GCM

        // 2. Derive encryption key from password using PBKDF2
        const keyMaterial = await window.crypto.subtle.importKey(
            'raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']
        );
        const key = await window.crypto.subtle.deriveKey(
            { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
            keyMaterial,
            { name: 'AES-GCM', length: 256 },
            true,
            ['encrypt', 'decrypt']
        );

        // 3. Prepare file data: prepend a header for integrity check
        const header = enc.encode('BKP-FILE'); // Magic bytes for later validation
        const fileData = new Uint8Array(await file.arrayBuffer());
        const plain = new Uint8Array(header.length + fileData.length);
        plain.set(header);
        plain.set(fileData, header.length);

        // 4. Encrypt the file using AES-GCM
        const encrypted = await window.crypto.subtle.encrypt(
            { name: 'AES-GCM', iv }, key, plain
        );

        // 5. Concatenate salt + iv + encrypted data for upload
        const total = new Uint8Array(salt.length + iv.length + encrypted.byteLength);
        total.set(salt); // First 16 bytes: salt
        total.set(iv, salt.length); // Next 12 bytes: IV
        total.set(new Uint8Array(encrypted), salt.length + iv.length); // Remainder: encrypted file

        // 6. Prepare the upload as a FormData POST
        const encBlob = new Blob([total], { type: 'application/octet-stream' });
        const formData = new FormData();
        formData.append('file', new File([encBlob], file.name));
        const expiryInput = document.getElementById('expiry');
        if (expiryInput && expiryInput.value) {
            formData.append('expiry', expiryInput.value);
        }

        // 7. Upload the encrypted file to the server
        const res = await fetch(window.uploadUrl, {
            method: 'POST',
            body: formData,
            headers: { 'X-Requested-With': 'XMLHttpRequest' }
        });
        if (!res.ok) {
            let msg = 'Upload failed';
            try {
                const err = await res.json();
                if (err.error) msg = err.error;
            } catch (e) {}
            alert(msg);
            return;
        }
        // 8. On success, store password for later and redirect
        const json = await res.json();
        sessionStorage.setItem('uploadPassword', password);
        window.location.href = `/success/${json.file_id}`;
    });
}

// --- Copy URL to Clipboard Logic ---
document.querySelectorAll('.copy-url').forEach(el => {
    el.addEventListener('click', (e) => {
        e.preventDefault();
        const url = el.getAttribute('data-url');
        navigator.clipboard.writeText(url).then(() => {
            alert('url copied to clipboard');
        });
    });
});
