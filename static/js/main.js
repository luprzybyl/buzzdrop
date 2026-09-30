// Import CryptoService for encryption
import { CryptoService } from './crypto.js';
import { buildSharedFilesUrl, getSharedFilesPage } from './shared-files.mjs';

const cryptoService = new CryptoService();
let activeShareMode = 'file';
let uploadInProgress = false;

// Parse allowed file extensions from a hidden JSON element injected by the server
const allowedExtensions = JSON.parse(document.getElementById('allowed-extensions-json').textContent);

// --- Tab Switching Logic ---
// The action button holds an icon alongside its label, so only the label node is rewritten.
function setShareAction(label) {
    const button = document.getElementById('share-action-btn');
    const labelNode = document.getElementById('share-action-label');
    if (labelNode) {
        labelNode.textContent = label;
    }
    if (button) {
        button.setAttribute('aria-label', label);
    }
}

function showFileUpload() {
    activeShareMode = 'file';
    document.getElementById('file-upload-section').style.display = 'block';
    document.getElementById('text-note-section').style.display = 'none';
    document.getElementById('file-tab').className = 'share-tab share-tab-active';
    document.getElementById('text-tab').className = 'share-tab';
    setShareAction('Share file');
}

function showTextNote() {
    activeShareMode = 'text';
    document.getElementById('file-upload-section').style.display = 'none';
    document.getElementById('text-note-section').style.display = 'block';
    document.getElementById('file-tab').className = 'share-tab';
    document.getElementById('text-tab').className = 'share-tab share-tab-active';
    setShareAction('Share note');
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

// --- Dropzone Logic ---
function isAllowedFile(name) {
    return allowedExtensions.includes(name.split('.').pop().toLowerCase());
}

// Show (or clear) the chip naming the file that is queued for encryption.
function showSelectedFile(file) {
    const chip = document.getElementById('file-selected');
    const chipName = document.getElementById('file-selected-name');
    if (!chip || !chipName) return;
    chipName.textContent = file ? file.name : '';
    chip.classList.toggle('hidden', !file);
}

// The region is always present and only its text changes, so assistive tech
// announces every rejection rather than a one-time reveal.
function setFileError(message) {
    const region = document.getElementById('file-error');
    if (region) region.textContent = message;
}

// Reject a disallowed file, discarding any earlier selection along with it.
function rejectFile(input) {
    input.value = '';
    showSelectedFile(null);
    setFileError('That file type is not allowed.');
}

const dropzone = document.getElementById('dropzone');
if (dropzone) {
    const fileField = document.getElementById('file');

    const setDragging = (isDragging) => dropzone.classList.toggle('dropzone-active', isDragging);

    ['dragenter', 'dragover'].forEach((eventName) => {
        dropzone.addEventListener(eventName, (e) => {
            e.preventDefault();
            setDragging(true);
        });
    });

    // dragleave also fires when crossing into a child, so ignore those.
    dropzone.addEventListener('dragleave', (e) => {
        if (!dropzone.contains(e.relatedTarget)) {
            setDragging(false);
        }
    });

    dropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        setDragging(false);
        const file = e.dataTransfer && e.dataTransfer.files[0];
        if (!file) return;
        if (!isAllowedFile(file.name)) {
            rejectFile(fileField);
            return;
        }
        // Hand the dropped file to the real input so the form submits it unchanged.
        const transfer = new DataTransfer();
        transfer.items.add(file);
        fileField.files = transfer.files;
        showSelectedFile(file);
        setFileError('');
    });
}

// --- File Upload Logic ---
const fileUploadForm = document.querySelector('#file-upload-section form');
if (fileUploadForm) {
    // Validate file extension when a file is selected
    document.getElementById('file').addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) {
            showSelectedFile(null);
            return;
        }
        if (!isAllowedFile(file.name)) {
            rejectFile(e.target);
            return;
        }
        showSelectedFile(file);
        setFileError('');
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
        const notifyOnOpenInput = document.getElementById('notify-on-open');
        const notificationEmailInput = document.getElementById('notification-email');
        if (expiryInput && expiryInput.value) {
            formData.append('expiry', expiryInput.value);
        }
        if (privateNoteInput && privateNoteInput.value.trim()) {
            formData.append('private_note', privateNoteInput.value.trim());
        }
        if (notifyOnOpenInput && notifyOnOpenInput.checked) {
            formData.append('notify_on_open', 'true');
        }
        if (notificationEmailInput && notificationEmailInput.value.trim()) {
            formData.append('notification_email', notificationEmailInput.value.trim());
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
    const notifyOnOpen = document.getElementById('notify-on-open').checked;
    const notificationEmail = document.getElementById('notification-email').value.trim();

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
    if (notifyOnOpen) {
        formData.append('notify_on_open', 'true');
    }
    if (notificationEmail) {
        formData.append('notification_email', notificationEmail);
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
    const flash = el.querySelector('.copy-flash');
    let flashTimer;

    el.addEventListener('click', (e) => {
        e.preventDefault();
        const url = el.getAttribute('data-url');
        navigator.clipboard.writeText(url).then(() => {
            if (!flash) {
                alert('url copied to clipboard');
                return;
            }
            // Inline confirmation beats a modal dialog for something this small.
            flash.classList.remove('hidden');
            clearTimeout(flashTimer);
            flashTimer = setTimeout(() => flash.classList.add('hidden'), 1800);
        });
    });
});

// --- Shared Files Search & Pagination ---
function initializeSharedFilesList() {
    const list = document.getElementById('shared-files-list');
    const searchInput = document.getElementById('shared-files-search');
    const sortInput = document.getElementById('shared-files-sort');
    const emptyState = document.getElementById('shared-files-empty-state');
    const summary = document.getElementById('shared-files-summary');
    const pageLabel = document.getElementById('shared-files-page');
    const prevButton = document.getElementById('shared-files-prev');
    const nextButton = document.getElementById('shared-files-next');

    if (!list || !searchInput || !sortInput || !emptyState || !summary || !pageLabel || !prevButton || !nextButton) {
        return;
    }

    const rows = Array.from(list.querySelectorAll('.shared-file-row'));
    if (rows.length === 0) {
        return;
    }

    const pageSize = Math.max(parseInt(list.dataset.pageSize || '5', 10), 1);
    const params = new URLSearchParams(window.location.search);
    searchInput.value = params.get('shared_search') || '';
    let currentPage = Math.max(parseInt(params.get('shared_page'), 10) || 1, 1);

    const render = () => {
        const [sortField, sortDirection] = sortInput.value.split(':');
        const timestampField = {
            uploaded: 'uploadedAt',
            expiry: 'expiryAt',
            downloaded: 'downloadedAt'
        }[sortField];
        const sortMultiplier = sortDirection === 'desc' ? -1 : 1;
        const sortedRows = [...rows].sort((a, b) => {
            const aTimestamp = a.dataset[timestampField] || '';
            const bTimestamp = b.dataset[timestampField] || '';
            if (!aTimestamp || !bTimestamp) {
                return aTimestamp ? -1 : bTimestamp ? 1 : 0;
            }
            if (aTimestamp === bTimestamp) {
                return 0;
            }
            return (aTimestamp < bTimestamp ? -1 : 1) * sortMultiplier;
        });
        sortedRows.forEach((row) => list.appendChild(row));
        const page = getSharedFilesPage(sortedRows, searchInput.value, pageSize, currentPage);
        const totalResults = page.filteredRows.length;
        currentPage = page.currentPage;

        rows.forEach((row) => {
            row.style.display = 'none';
        });

        page.visibleRows.forEach((row) => {
            row.style.display = '';
        });

        if (totalResults === 0) {
            emptyState.style.display = 'block';
            pageLabel.textContent = 'Page 0 of 0';
            summary.textContent = 'No matching drops';
        } else {
            emptyState.style.display = 'none';
            pageLabel.textContent = `Page ${currentPage} of ${page.totalPages}`;
            summary.textContent = `Showing ${page.startIndex + 1}-${Math.min(page.startIndex + pageSize, totalResults)} of ${totalResults} drops`;
        }

        prevButton.disabled = currentPage <= 1 || totalResults === 0;
        nextButton.disabled = currentPage >= page.totalPages || totalResults === 0;
        return page;
    };

    const refreshStatuses = async (pageRows) => {
        const statusUrl = list.dataset.statusUrl;
        if (!statusUrl || pageRows.length === 0) {
            return;
        }

        const params = new URLSearchParams();
        pageRows.forEach((row) => params.append('id', row.dataset.fileId));

        try {
            const response = await fetch(`${statusUrl}?${params}`, {
                headers: { 'X-Requested-With': 'XMLHttpRequest' },
            });
            if (!response.ok) {
                return;
            }
            const { files } = await response.json();
            let updated = false;
            files.forEach((file) => {
                const row = rows.find((item) => item.dataset.fileId === file.id);
                if (!row) {
                    return;
                }
                const downloadedAt = row.querySelector('[data-file-downloaded-at]');
                const downloadedBy = row.querySelector('[data-file-downloaded-by]');
                const statusBadge = row.querySelector('[data-file-status]');
                downloadedAt.textContent = file.downloaded_at || 'No';
                downloadedBy.textContent = file.downloaded_by_ip || '-';
                row.dataset.downloadedAt = file.downloaded_at || '';
                statusBadge.textContent = file.status_display || 'Active';
                statusBadge.classList.remove('status-badge-green', 'status-badge-red', 'status-badge-amber');
                statusBadge.classList.add(file.downloaded_at
                    ? 'status-badge-green'
                    : file.status === 'expired'
                        ? 'status-badge-red'
                        : 'status-badge-amber');
                row.dataset.searchText = `${row.dataset.searchBase} ${file.status} ${file.status_display} ${file.downloaded_by_ip || ''}`.toLowerCase();
                updated = true;
            });
            if (updated) {
                render();
                window.history.replaceState(
                    window.history.state,
                    '',
                    buildSharedFilesUrl(window.location.href, currentPage, searchInput.value),
                );
            }
        } catch {
            return;
        }
    };

    searchInput.addEventListener('input', () => {
        currentPage = 1;
        render();
        window.history.replaceState(
            window.history.state,
            '',
            buildSharedFilesUrl(window.location.href, currentPage, searchInput.value),
        );
    });

    sortInput.addEventListener('change', () => {
        currentPage = 1;
        render();
    });

    prevButton.addEventListener('click', () => {
        if (currentPage > 1) {
            currentPage -= 1;
            const page = render();
            window.history.replaceState(
                window.history.state,
                '',
                buildSharedFilesUrl(window.location.href, currentPage, searchInput.value),
            );
            refreshStatuses(page.visibleRows);
        }
    });

    nextButton.addEventListener('click', () => {
        const page = render();
        if (currentPage < page.totalPages) {
            currentPage += 1;
            const nextPage = render();
            window.history.replaceState(
                window.history.state,
                '',
                buildSharedFilesUrl(window.location.href, currentPage, searchInput.value),
            );
            refreshStatuses(nextPage.visibleRows);
        }
    });

    render();
}

initializeSharedFilesList();
