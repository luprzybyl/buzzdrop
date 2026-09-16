// Import CryptoService for encryption
import { CryptoService } from './crypto.js';

const cryptoService = new CryptoService();
let activeShareMode = 'file';
let uploadInProgress = false;

// Parse allowed file extensions from a hidden JSON element injected by the server
const allowedExtensions = JSON.parse(document.getElementById('allowed-extensions-json').textContent);

// --- Tab Switching Logic ---
function showFileUpload() {
    activeShareMode = 'file';
    document.getElementById('file-upload-section').style.display = 'block';
    document.getElementById('text-note-section').style.display = 'none';
    document.getElementById('file-tab').className = 'share-tab share-tab-active';
    document.getElementById('text-tab').className = 'share-tab';
    document.getElementById('share-action-btn').textContent = 'Upload File';
}

function showTextNote() {
    activeShareMode = 'text';
    document.getElementById('file-upload-section').style.display = 'none';
    document.getElementById('text-note-section').style.display = 'block';
    document.getElementById('file-tab').className = 'share-tab';
    document.getElementById('text-tab').className = 'share-tab share-tab-active';
    document.getElementById('share-action-btn').textContent = 'Share Text Note';
}

// Make functions globally accessible for inline onclick handlers
window.showFileUpload = showFileUpload;
window.showTextNote = showTextNote;

// --- Shared Upload Logic ---
/**
 * Upload data with progress tracking via XHR.
 * @param {FormData} formData - Form data to upload
 * @param {string} password - Password to store in sessionStorage on success
 * @param {Object} uiElements - UI element IDs for progress display
 * @param {string} uiElements.btnId - Upload button element ID
 * @param {string} uiElements.containerId - Progress container element ID
 * @param {string} uiElements.barId - Progress bar element ID
 * @param {string} uiElements.textId - Progress text element ID
 */
function uploadWithProgress(formData, password, uiElements) {
    const uploadBtn = document.getElementById(uiElements.btnId);
    const progressContainer = document.getElementById(uiElements.containerId);
    const progressBar = document.getElementById(uiElements.barId);
    const progressText = document.getElementById(uiElements.textId);

    if (uploadInProgress) {
        return;
    }

    uploadInProgress = true;
    uploadBtn.disabled = true;
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

    xhr.onload = function() {
        if (xhr.status >= 200 && xhr.status < 300) {
            let json = {};
            try {
                json = JSON.parse(xhr.responseText);
            } catch (e) {
                alert('Upload succeeded but server returned invalid JSON');
                uploadInProgress = false;
                uploadBtn.disabled = false;
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
            uploadInProgress = false;
            uploadBtn.disabled = false;
            uploadBtn.style.display = '';
            progressContainer.style.display = 'none';
        }
    };

    xhr.onerror = function() {
        alert('Network error during upload');
        uploadInProgress = false;
        uploadBtn.disabled = false;
        uploadBtn.style.display = '';
        progressContainer.style.display = 'none';
    };

    xhr.send(formData);
}

// --- File Upload Logic ---
const fileUploadForm = document.querySelector('#file-upload-section form');
if (fileUploadForm) {
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
    fileUploadForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (uploadInProgress) return;
        const fileInput = document.getElementById('file');
        const passInput = document.getElementById('shared-password');
        const file = fileInput.files[0];
        const password = passInput.value;
        if (!file || !password) return;

        // Read and encrypt file data
        const fileData = new Uint8Array(await file.arrayBuffer());
        const encrypted = await cryptoService.encrypt(fileData, password);

        // Prepare FormData
        const encBlob = new Blob([encrypted], { type: 'application/octet-stream' });
        const formData = new FormData();
        formData.append('file', new File([encBlob], file.name));
        const expiryInput = document.getElementById('shared-expiry');
        const privateNoteInput = document.getElementById('shared-private-note');
        if (expiryInput && expiryInput.value) {
            formData.append('expiry', expiryInput.value);
        }
        if (privateNoteInput && privateNoteInput.value.trim()) {
            formData.append('private_note', privateNoteInput.value.trim());
        }

        // Upload with progress
        uploadWithProgress(formData, password, {
            btnId: 'share-action-btn',
            containerId: 'share-progress-container',
            barId: 'share-progress-bar',
            textId: 'share-progress-text'
        });
    });
}

// --- Text Note Upload Logic ---
async function uploadNote() {
    if (uploadInProgress) return;
    const noteText = document.getElementById('note-text').value;
    const password = document.getElementById('shared-password').value;
    const expiry = document.getElementById('shared-expiry').value;
    const privateNote = document.getElementById('shared-private-note').value.trim();

    if (!noteText || !password) {
        alert('Please enter both text and password');
        return;
    }

    // Encrypt text data
    const enc = new TextEncoder();
    const textData = enc.encode(noteText);
    const encrypted = await cryptoService.encrypt(textData, password);

    // Prepare FormData with base64 encoded encrypted data
    const base64Encrypted = btoa(String.fromCharCode(...encrypted));
    const formData = new FormData();
    formData.append('note_text', base64Encrypted);
    formData.append('type', 'text');
    if (expiry) {
        formData.append('expiry', expiry);
    }
    if (privateNote) {
        formData.append('private_note', privateNote);
    }

    // Upload with progress
    uploadWithProgress(formData, password, {
        btnId: 'share-action-btn',
        containerId: 'share-progress-container',
        barId: 'share-progress-bar',
        textId: 'share-progress-text'
    });
}

const shareActionButton = document.getElementById('share-action-btn');
if (shareActionButton) {
    shareActionButton.addEventListener('click', () => {
        if (uploadInProgress) return;
        if (activeShareMode === 'text') {
            uploadNote();
            return;
        }

        const fileForm = document.querySelector('#file-upload-section form');
        if (fileForm) {
            fileForm.requestSubmit();
        }
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

// --- Shared Files Search & Pagination ---
function initializeSharedFilesList() {
    const list = document.getElementById('shared-files-list');
    const searchInput = document.getElementById('shared-files-search');
    const emptyState = document.getElementById('shared-files-empty-state');
    const summary = document.getElementById('shared-files-summary');
    const pageLabel = document.getElementById('shared-files-page');
    const prevButton = document.getElementById('shared-files-prev');
    const nextButton = document.getElementById('shared-files-next');

    if (!list || !searchInput || !emptyState || !summary || !pageLabel || !prevButton || !nextButton) {
        return;
    }

    const rows = Array.from(list.querySelectorAll('.shared-file-row'));
    if (rows.length === 0) {
        return;
    }

    const pageSize = Math.max(parseInt(list.dataset.pageSize || '5', 10), 1);
    let currentPage = 1;

    const render = () => {
        const searchTerm = searchInput.value.trim().toLowerCase();
        const filteredRows = rows.filter((row) => row.dataset.searchText.includes(searchTerm));
        const totalResults = filteredRows.length;
        const totalPages = Math.max(Math.ceil(totalResults / pageSize), 1);

        if (currentPage > totalPages) {
            currentPage = totalPages;
        }

        const startIndex = (currentPage - 1) * pageSize;
        const endIndex = startIndex + pageSize;

        rows.forEach((row) => {
            row.style.display = 'none';
        });

        filteredRows.slice(startIndex, endIndex).forEach((row) => {
            row.style.display = '';
        });

        if (totalResults === 0) {
            emptyState.style.display = 'block';
            pageLabel.textContent = 'Page 0 of 0';
            summary.textContent = 'No matching drops';
        } else {
            emptyState.style.display = 'none';
            pageLabel.textContent = `Page ${currentPage} of ${totalPages}`;
            summary.textContent = `Showing ${startIndex + 1}-${Math.min(endIndex, totalResults)} of ${totalResults} drops`;
        }

        prevButton.disabled = currentPage <= 1 || totalResults === 0;
        nextButton.disabled = currentPage >= totalPages || totalResults === 0;
    };

    searchInput.addEventListener('input', () => {
        currentPage = 1;
        render();
    });

    prevButton.addEventListener('click', () => {
        if (currentPage > 1) {
            currentPage -= 1;
            render();
        }
    });

    nextButton.addEventListener('click', () => {
        const searchTerm = searchInput.value.trim().toLowerCase();
        const filteredRows = rows.filter((row) => row.dataset.searchText.includes(searchTerm));
        const totalPages = Math.max(Math.ceil(filteredRows.length / pageSize), 1);
        if (currentPage < totalPages) {
            currentPage += 1;
            render();
        }
    });

    render();
}

initializeSharedFilesList();
