// Parse allowed file extensions from a hidden JSON element injected by the server
const allowedExtensions = JSON.parse(document.getElementById('allowed-extensions-json').textContent);

// --- Tab Switching Logic ---
function showFileUpload() {
    document.getElementById('file-upload-section').style.display = 'block';
    document.getElementById('text-note-section').style.display = 'none';
    document.getElementById('file-tab').className = 'px-4 py-2 font-medium text-indigo-600 border-b-2 border-indigo-600';
    document.getElementById('text-tab').className = 'px-4 py-2 font-medium text-gray-500 hover:text-gray-700';
}

function showTextNote() {
    document.getElementById('file-upload-section').style.display = 'none';
    document.getElementById('text-note-section').style.display = 'block';
    document.getElementById('file-tab').className = 'px-4 py-2 font-medium text-gray-500 hover:text-gray-700';
    document.getElementById('text-tab').className = 'px-4 py-2 font-medium text-indigo-600 border-b-2 border-indigo-600';
}

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
        // --- DEBUG LOG: Upload timing ---
        const uploadStartTime = new Date();
        console.log(`[DEBUG] Upload started at: ${uploadStartTime.toISOString()}`);
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
        tick = new Date()
        console.log(`[DEBUG] Encoder set: ${tick.toISOString()} (elapsed: ${((tick - uploadStartTime)/1000).toFixed(3)}s)`);

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
        tick = new Date()
        console.log(`[DEBUG] key derived: ${tick.toISOString()} (elapsed: ${((tick - uploadStartTime)/1000).toFixed(3)}s)`);

        // 3. Prepare file data: prepend a header for integrity check
        const header = enc.encode('BKP-FILE'); // Magic bytes for later validation
        const fileData = new Uint8Array(await file.arrayBuffer());
        const plain = new Uint8Array(header.length + fileData.length);
        plain.set(header);
        plain.set(fileData, header.length);
        tick = new Date()
        console.log(`[DEBUG] Data prepared for encryption: ${tick.toISOString()} (elapsed: ${((tick - uploadStartTime)/1000).toFixed(3)}s)`);

        // 4. Encrypt the file using AES-GCM
        const encrypted = await window.crypto.subtle.encrypt(
            { name: 'AES-GCM', iv }, key, plain
        );
        tick = new Date()
        console.log(`[DEBUG] File encrypted: ${tick.toISOString()} (elapsed: ${((tick - uploadStartTime)/1000).toFixed(3)}s)`);

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
        // --- PROGRESS BAR LOGIC ---
        const uploadBtn = document.getElementById('upload-btn');
        const progressContainer = document.getElementById('upload-progress-container');
        const progressBar = document.getElementById('upload-progress-bar');
        const progressText = document.getElementById('upload-progress-text');

        uploadBtn.style.display = 'none';
        progressContainer.style.display = 'flex';
        progressBar.style.width = '0%';
        progressText.textContent = '0%';

        const xhr = new XMLHttpRequest();
        xhr.open('POST', window.uploadUrl, true);
        xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');

        xhr.upload.onprogress = function(e) {
            if (e.lengthComputable) {
                const percent = Math.round((e.loaded / e.total) * 100);
                progressBar.style.width = percent + '%';
                progressText.textContent = percent + '%';
            }
        };

        xhr.onload = async function() {
            const afterUploadTime = new Date();
            console.log(`[DEBUG] Upload finished at: ${afterUploadTime.toISOString()} (elapsed: ${((afterUploadTime - uploadStartTime)/1000).toFixed(3)}s)`);
            if (xhr.status >= 200 && xhr.status < 300) {
                let json = {};
                try {
                    json = JSON.parse(xhr.responseText);
                } catch (e) {
                    alert('Upload succeeded but server returned invalid JSON');
                    uploadBtn.style.display = '';
                    progressContainer.style.display = 'none';
                    return;
                }
                sessionStorage.setItem('uploadPassword', password);
                window.location.href = `/success/${json.file_id}`;
            } else {
                let msg = 'Upload failed';
                try {
                    const err = JSON.parse(xhr.responseText);
                    if (err.error) msg = err.error;
                } catch (e) {}
                alert(msg);
                uploadBtn.style.display = '';
                progressContainer.style.display = 'none';
            }
        };

        xhr.onerror = function() {
            alert('Network error during upload');
            uploadBtn.style.display = '';
            progressContainer.style.display = 'none';
        };

        const beforeUploadTime = new Date();
        console.log(`[DEBUG] Time before upload: ${beforeUploadTime.toISOString()} (elapsed: ${((beforeUploadTime - uploadStartTime)/1000).toFixed(3)}s)`);
        xhr.send(formData);
    });
}

// --- Text Note Upload Logic ---
async function uploadNote() {
    const uploadStartTime = new Date();
    console.log(`[DEBUG] Note upload started at: ${uploadStartTime.toISOString()}`);

    const noteText = document.getElementById('note-text').value;
    const password = document.getElementById('note-password').value;
    const expiry = document.getElementById('note-expiry').value;

    if (!noteText || !password) {
        alert('Please enter both text and password');
        return;
    }

    // --- ENCRYPTION WORKFLOW (same as file) ---
    const enc = new TextEncoder();
    const salt = window.crypto.getRandomValues(new Uint8Array(16));
    const iv = window.crypto.getRandomValues(new Uint8Array(12));

    // Derive encryption key from password
    const keyMaterial = await window.crypto.subtle.importKey(
        'raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']
    );
    const key = await window.crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
        keyMaterial,
        { name: 'AES-GCM', length: 256 },
        true,
        ['encrypt']
    );

    // Prepare data: prepend header for integrity check
    const header = enc.encode('BKP-FILE');
    const textData = enc.encode(noteText);
    const plain = new Uint8Array(header.length + textData.length);
    plain.set(header);
    plain.set(textData, header.length);

    // Encrypt the text
    const encrypted = await window.crypto.subtle.encrypt(
        { name: 'AES-GCM', iv }, key, plain
    );

    // Concatenate salt + iv + encrypted data
    const total = new Uint8Array(salt.length + iv.length + encrypted.byteLength);
    total.set(salt);
    total.set(iv, salt.length);
    total.set(new Uint8Array(encrypted), salt.length + iv.length);

    // Prepare FormData for upload
    // Convert encrypted data to base64 for easy transport
    const base64Encrypted = btoa(String.fromCharCode(...total));
    const formData = new FormData();
    formData.append('note_text', base64Encrypted);
    formData.append('type', 'text');
    if (expiry) {
        formData.append('expiry', expiry);
    }

    // Progress bar logic
    const uploadBtn = document.getElementById('note-upload-btn');
    const progressContainer = document.getElementById('note-upload-progress-container');
    const progressBar = document.getElementById('note-upload-progress-bar');
    const progressText = document.getElementById('note-upload-progress-text');

    uploadBtn.style.display = 'none';
    progressContainer.style.display = 'flex';
    progressBar.style.width = '0%';
    progressText.textContent = '0%';

    const xhr = new XMLHttpRequest();
    xhr.open('POST', window.uploadUrl, true);
    xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');

    xhr.upload.onprogress = function(e) {
        if (e.lengthComputable) {
            const percent = Math.round((e.loaded / e.total) * 100);
            progressBar.style.width = percent + '%';
            progressText.textContent = percent + '%';
        }
    };

    xhr.onload = async function() {
        const afterUploadTime = new Date();
        console.log(`[DEBUG] Note upload finished at: ${afterUploadTime.toISOString()} (elapsed: ${((afterUploadTime - uploadStartTime)/1000).toFixed(3)}s)`);
        if (xhr.status >= 200 && xhr.status < 300) {
            let json = {};
            try {
                json = JSON.parse(xhr.responseText);
            } catch (e) {
                alert('Upload succeeded but server returned invalid JSON');
                uploadBtn.style.display = '';
                progressContainer.style.display = 'none';
                return;
            }
            sessionStorage.setItem('uploadPassword', password);
            window.location.href = `/success/${json.file_id}`;
        } else {
            let msg = 'Upload failed';
            try {
                const err = JSON.parse(xhr.responseText);
                if (err.error) msg = err.error;
            } catch (e) {}
            alert(msg);
            uploadBtn.style.display = '';
            progressContainer.style.display = 'none';
        }
    };

    xhr.onerror = function() {
        alert('Network error during upload');
        uploadBtn.style.display = '';
        progressContainer.style.display = 'none';
    };

    xhr.send(formData);
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
