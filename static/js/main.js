const allowedExtensions = JSON.parse(document.getElementById('allowed-extensions-json').textContent);
if (document.querySelector('form')) {
    document.getElementById('file').addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const ext = file.name.split('.').pop().toLowerCase();
        if (!allowedExtensions.includes(ext)) {
            alert('File type not allowed');
            e.target.value = '';
        }
    });
    document.querySelector('form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const fileInput = document.getElementById('file');
        const passInput = document.getElementById('password');
        const file = fileInput.files[0];
        const password = passInput.value;
        if (!file || !password) return;

        const enc = new TextEncoder();
        const salt = window.crypto.getRandomValues(new Uint8Array(16));
        const iv = window.crypto.getRandomValues(new Uint8Array(12));

        const keyMaterial = await window.crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
        const key = await window.crypto.subtle.deriveKey(
            { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
            keyMaterial,
            { name: 'AES-GCM', length: 256 },
            true,
            ['encrypt', 'decrypt']
        );

        const header = enc.encode('BKP-FILE');
        const fileData = new Uint8Array(await file.arrayBuffer());
        const plain = new Uint8Array(header.length + fileData.length);
        plain.set(header);
        plain.set(fileData, header.length);

        const encrypted = await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain);

        const total = new Uint8Array(salt.length + iv.length + encrypted.byteLength);
        total.set(salt);
        total.set(iv, salt.length);
        total.set(new Uint8Array(encrypted), salt.length + iv.length);

        const encBlob = new Blob([total], { type: 'application/octet-stream' });
        const formData = new FormData();
        formData.append('file', new File([encBlob], file.name));
        const expiryInput = document.getElementById('expiry');
        if (expiryInput && expiryInput.value) {
            formData.append('expiry', expiryInput.value);
        }

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
        const json = await res.json();
        sessionStorage.setItem('uploadPassword', password);
        window.location.href = `/success/${json.file_id}`;
    });
}
document.querySelectorAll('.copy-url').forEach(el => {
    el.addEventListener('click', (e) => {
        e.preventDefault();
        const url = el.getAttribute('data-url');
        navigator.clipboard.writeText(url).then(() => {
            alert('url copied to clipboard');
        });
    });
});
