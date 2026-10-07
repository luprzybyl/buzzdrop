// --- Index page logic ---
// The composer (file/note tabs, password gate, dropzone, upload) and the
// shared-files list. The page loads for anonymous visitors too, who get
// neither, so lookups into those parts keep their null checks.

import { CryptoService, bytesToHex, hexToBytes } from './crypto.js';
import { buildSharedFilesUrl, getSharedFilesPage, rowSearchText, statusBadgeClass } from './shared-files.js';
import { isAllowedFile } from './file-extensions.js';
import { buildOneClickLink } from './fragment-password.js';
import { assessPassword, generatePassphrase } from './passphrase.js';
import { required, requiredWindow } from './required.js';

/**
 * @typedef {object} IndexDeps
 * @property {typeof fetch} fetch
 * @property {typeof XMLHttpRequest} XMLHttpRequest - supplies upload.onprogress
 * @property {(url: string) => void} navigate
 * @property {(message: string) => void} alert
 * @property {Pick<CryptoService, 'encrypt' | 'receiptHash'>} crypto
 */

/**
 * The extensions the upload form accepts (`allowed-extensions-json`):
 * lowercase, without the dot.
 * @typedef {string[]} AllowedExtensions
 */

/**
 * The upload endpoints (`upload-endpoints-json`).
 * @typedef {object} UploadEndpoints
 * @property {string} uploadBeginUrl
 * @property {string} uploadUrl
 */

/**
 * What POST /upload/begin answers: the new share's id and the server share H
 * (hex).
 * @typedef {object} UploadBeginResponse
 * @property {string} file_id
 * @property {string} h
 */

/**
 * What POST /upload answers: the share's id on success, `{error}` otherwise.
 * @typedef {object} UploadResponse
 * @property {string} [file_id]
 * @property {string} [error]
 */

/**
 * What the shared-files status endpoint answers.
 * @typedef {{files: Array<import('./shared-files.js').FileStatus & {id: string}>}} FileStatusesResponse
 */

/**
 * The options both upload paths send alongside the encrypted payload.
 * @typedef {object} ShareOptions
 * @property {string} expiry
 * @property {string} privateNote
 * @property {boolean} notifyOnOpen
 * @property {string} notificationEmail
 */

/**
 * A shared-files row; the template sets all of these data attributes.
 * @typedef {HTMLElement & {dataset: DOMStringMap & {fileId: string, searchBase: string, searchText: string}}} SharedFileRow
 */

/**
 * `fetch` is bound to the window: called unbound, as deps.fetch(...), the
 * browser's fetch throws "Illegal invocation".
 * @returns {IndexDeps}
 */
export function browserDeps() {
    return {
        fetch: window.fetch.bind(window),
        XMLHttpRequest: window.XMLHttpRequest,
        navigate: (url) => { window.location.href = url; },
        alert: (message) => window.alert(message),
        crypto: new CryptoService(),
    };
}

/**
 * @param {Document} root - the index.html document
 * @param {IndexDeps} deps
 */
export function initIndex(root, deps) {
    const window = requiredWindow(root);
    const cryptoService = deps.crypto;
    /** @type {'file' | 'text'} */
    let activeShareMode = 'file';
    let uploadInProgress = false;

    // The index page never uses URL fragments — a stray one here can only be a
    // password leaked by fragment inheritance across a redirect (e.g. a dead
    // one-click link). Scrub it so it does not linger in the address bar or
    // history.
    if (window.location.hash.length > 1) {
        window.history.replaceState(
            null, '', window.location.pathname + window.location.search);
    }

    /**
     * Parse allowed file extensions from a hidden JSON element injected by the server
     * @type {AllowedExtensions}
     */
    const allowedExtensions = JSON.parse(required(root, '#allowed-extensions-json', 'script').text);

    /**
     * Upload endpoints injected the same way — a type="application/json" data
     * island, which CSP does not treat as script.
     * @type {UploadEndpoints}
     */
    const uploadEndpoints = JSON.parse(required(root, '#upload-endpoints-json', 'script').text);

    // --- Tab Switching Logic ---
    // The composer's two modes are an ARIA tab set: the rail is the tablist and
    // each section is the panel its tab controls.
    const shareModes = {
        file: { tab: 'file-tab', panel: 'file-upload-section', action: 'Share file' },
        text: { tab: 'text-tab', panel: 'text-note-section', action: 'Share note' },
    };
    /** @type {Array<'file' | 'text'>} */
    const shareModeOrder = ['file', 'text'];

    /**
     * The action button holds an icon alongside its label, so only the label node is rewritten.
     * @param {string} label
     */
    function setShareAction(label) {
        const button = root.getElementById('share-action-btn');
        const labelNode = root.getElementById('share-action-label');
        if (labelNode) {
            labelNode.textContent = label;
        }
        if (button) {
            button.setAttribute('aria-label', label);
        }
    }

    /**
     * Toggling one class rather than reassigning className, so the ARIA state set
     * below survives a mode switch.
     * @param {'file' | 'text'} mode
     * @param {{focusTab?: boolean}} [options]
     */
    function selectShareMode(mode, { focusTab = false } = {}) {
        activeShareMode = mode;

        shareModeOrder.forEach((name) => {
            const { tab, panel } = shareModes[name];
            const isActive = name === mode;
            const tabNode = root.getElementById(tab);
            const panelNode = root.getElementById(panel);

            if (panelNode) panelNode.style.display = isActive ? 'block' : 'none';
            if (!tabNode) return;

            tabNode.classList.toggle('share-tab-active', isActive);
            tabNode.setAttribute('aria-selected', String(isActive));
            // Roving tabindex: Tab reaches the rail once, arrows move within it.
            tabNode.tabIndex = isActive ? 0 : -1;
            if (isActive && focusTab) tabNode.focus();
        });

        setShareAction(shareModes[mode].action);
    }

    function showFileUpload() {
        selectShareMode('file');
    }

    function showTextNote() {
        selectShareMode('text');
    }

    // Tabs wire up here, not via inline onclick — CSP forbids inline handlers.
    root.getElementById('file-tab')?.addEventListener('click', showFileUpload);
    root.getElementById('text-tab')?.addEventListener('click', showTextNote);

    // The tab role promises a keyboard contract, so honour it: arrows move between
    // tabs, Home and End jump to the ends.
    const shareTabRail = /** @type {HTMLElement | null} */ (root.querySelector('.tab-rail'));
    if (shareTabRail) {
        shareTabRail.addEventListener('keydown', (e) => {
            const current = shareModeOrder.indexOf(activeShareMode);
            const last = shareModeOrder.length - 1;
            let next;

            if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                next = current === last ? 0 : current + 1;
            } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                next = current === 0 ? last : current - 1;
            } else if (e.key === 'Home') {
                next = 0;
            } else if (e.key === 'End') {
                next = last;
            } else {
                return;
            }

            e.preventDefault();
            selectShareMode(shareModeOrder[next], { focusTab: true });
        });
    }

    // --- Password Generation & Strength Gate ---
    // The server never sees the password (encryption is client-side), so this
    // check is the only place a weak key can be refused — and it must refuse.
    const passwordInput = /** @type {HTMLInputElement | null} */ (root.getElementById('shared-password'));
    const generatePasswordBtn = root.getElementById('generate-password-btn');
    const togglePasswordBtn = root.getElementById('toggle-password-btn');
    const copyPasswordBtn = /** @type {HTMLButtonElement | null} */ (root.getElementById('copy-password-btn'));
    const strengthRegion = root.getElementById('password-strength');
    const strengthMeter = root.getElementById('password-strength-meter');
    const strengthBar = root.getElementById('password-strength-bar');
    const strengthText = root.getElementById('password-strength-text');
    const passwordError = root.getElementById('password-error');

    // Per level: the bar's and the message's colour, and the word the meter
    // reports to assistive tech (the colour carries it on screen).
    const STRENGTH = {
        weak: { fill: 'pw-fill-weak', text: 'pw-text-weak', label: 'Weak' },
        fair: { fill: 'pw-fill-fair', text: 'pw-text-fair', label: 'Fair' },
        strong: { fill: 'pw-fill-strong', text: 'pw-text-strong', label: 'Strong' },
    };

    /**
     * Same always-present-region pattern as #file-error: only the text swaps.
     * @param {string} message
     */
    function setPasswordError(message) {
        if (passwordError) passwordError.textContent = message;
    }

    function updatePasswordStrength() {
        if (!passwordInput || !strengthRegion || !strengthMeter || !strengthBar || !strengthText) {
            return;
        }
        const result = assessPassword(passwordInput.value);
        if (result.level === 'empty') {
            strengthRegion.hidden = true;
            return;
        }
        strengthRegion.hidden = false;
        const level = STRENGTH[result.level];
        strengthBar.className = `pw-fill ${level.fill}`;
        // Scale ~90 bits to a full bar so "fair" doesn't read as nearly done.
        // The meter holds the fill once, for the bar's width and for
        // assistive tech alike.
        const fill = Math.min(100, Math.round((result.bits / 90) * 100));
        strengthMeter.style.setProperty('--strength-fill', `${fill}%`);
        strengthMeter.setAttribute('aria-valuenow', String(fill));
        strengthMeter.setAttribute('aria-valuetext', level.label);
        strengthText.className = `field-help ${level.text}`;
        strengthText.textContent = result.message;
    }

    /**
     * Mask or reveal the password, keeping the toggle's name in step: it
     * names what pressing it will do.
     * @param {boolean} visible
     */
    function setPasswordVisible(visible) {
        if (!passwordInput || !togglePasswordBtn) return;
        passwordInput.type = visible ? 'text' : 'password';
        togglePasswordBtn.textContent = visible ? 'Hide' : 'Show';
        togglePasswordBtn.setAttribute('aria-label', visible ? 'Hide password' : 'Show password');
    }

    /** Copy has nothing to copy until there is a password. */
    function syncCopyPassword() {
        if (copyPasswordBtn && passwordInput) copyPasswordBtn.disabled = !passwordInput.value;
    }

    if (passwordInput) {
        passwordInput.addEventListener('input', () => {
            updatePasswordStrength();
            syncCopyPassword();
            // Re-typing clears a stale refusal so the user sees progress.
            setPasswordError('');
        });
    }

    if (togglePasswordBtn && passwordInput) {
        togglePasswordBtn.addEventListener('click', () => {
            setPasswordVisible(passwordInput.type === 'password');
        });
    }

    if (generatePasswordBtn && passwordInput) {
        generatePasswordBtn.addEventListener('click', () => {
            passwordInput.value = generatePassphrase();
            // Show the phrase so the sender can read it back on another channel;
            // the success page reveals it again via the URL fragment.
            setPasswordVisible(true);
            setPasswordError('');
            updatePasswordStrength();
            syncCopyPassword();
            passwordInput.focus();
        });
    }

    if (copyPasswordBtn && passwordInput) {
        const copyStatus = root.getElementById('password-copy-status');
        /** @type {ReturnType<typeof setTimeout> | undefined} */
        let copyStatusTimer;

        /**
         * Same timing as the share-link pill: a failure stays up longer
         * because it has to be read.
         * @param {string} message
         * @param {boolean} failed
         */
        const showCopyResult = (message, failed) => {
            if (!copyStatus) return;
            copyStatus.textContent = message;
            clearTimeout(copyStatusTimer);
            copyStatusTimer = setTimeout(() => { copyStatus.textContent = ''; }, failed ? 4000 : 1800);
        };

        copyPasswordBtn.addEventListener('click', () => {
            window.navigator.clipboard.writeText(passwordInput.value).then(
                () => showCopyResult('Password copied to clipboard.', false),
                () => showCopyResult('Your browser blocked clipboard access, so the password was not copied.', true),
            );
        });
    }

    /**
     * Refuse an empty password inline, where a weak one is refused too.
     * @param {string} password
     * @returns {boolean} whether there is one
     */
    function requirePassword(password) {
        if (password) return true;
        setPasswordError('Enter a password, or press Generate.');
        if (passwordInput) passwordInput.focus();
        return false;
    }

    /**
     * The actual gate: refuse to encrypt/upload a weak password. Called from
     * both upload paths (file form submit and text note) so every drop shares
     * the same floor.
     * @param {string} password
     * @returns {boolean}
     */
    function enforcePasswordStrength(password) {
        const result = assessPassword(password);
        if (result.blocked) {
            updatePasswordStrength();
            setPasswordError(`Password rejected: ${result.message}`);
            if (passwordInput) passwordInput.focus();
            return false;
        }
        return true;
    }

    // --- Shared Upload Logic ---

    // Session-authed mutating routes require the CSRF token the server
    // renders into <meta name="csrf-token"> — read once, reused per request.
    const csrfToken =
        /** @type {HTMLMetaElement | null} */ (root.querySelector('meta[name="csrf-token"]'))?.content || '';

    /**
     * Encrypt data for upload through the two-phase key-release handshake:
     * /upload/begin mints file_id + the server share H, the client derives
     * Kp/V from the password, encrypts under HKDF(Kp ‖ H), and returns the
     * blob plus the fields the finish POST needs.
     * @param {import('./crypto.js').Bytes} data - Raw plaintext
     * @param {string} password
     * @returns {Promise<{blob: import('./crypto.js').Bytes, fileId: string, keyVerifier: string, receiptHash: string}>}
     * @throws {Error} When the server refuses the handshake
     */
    async function encryptForUpload(data, password) {
        const res = await deps.fetch(uploadEndpoints.uploadBeginUrl, {
            method: 'POST',
            headers: {
                'X-Requested-With': 'XMLHttpRequest',
                'X-CSRF-Token': csrfToken,
            },
        });
        if (!res.ok) {
            throw new Error('The server refused the upload handshake.');
        }
        /** @type {UploadBeginResponse} */
        const { file_id, h } = await res.json();
        const { blob, verifier, receipt } = await cryptoService.encrypt(
            data, password, hexToBytes(h));
        return {
            blob,
            fileId: file_id,
            keyVerifier: bytesToHex(verifier),
            // SHA-256 of the in-ciphertext receipt — the server stores the
            // hash so /report_decryption can prove the client really
            // decrypted the payload.
            receiptHash: await cryptoService.receiptHash(receipt),
        };
    }

    /**
     * The share options as the composer currently holds them.
     * @returns {ShareOptions}
     */
    function readShareOptions() {
        return {
            expiry: required(root, '#shared-expiry', 'input').value,
            privateNote: required(root, '#shared-private-note', 'textarea').value.trim(),
            notifyOnOpen: required(root, '#notify-on-open', 'input').checked,
            // Rendered only for an account with an email to notify.
            notificationEmail: /** @type {HTMLInputElement | null} */ (
                root.getElementById('notification-email'))?.value.trim() ?? '',
        };
    }

    /**
     * Add the options that were set; the server treats a missing field as unset.
     * @param {FormData} formData
     * @param {ShareOptions} opts
     */
    function appendShareOptions(formData, opts) {
        if (opts.expiry) {
            formData.append('expiry', opts.expiry);
        }
        if (opts.privateNote) {
            formData.append('private_note', opts.privateNote);
        }
        if (opts.notifyOnOpen) {
            formData.append('notify_on_open', 'true');
        }
        if (opts.notificationEmail) {
            formData.append('notification_email', opts.notificationEmail);
        }
    }

    /**
     * Upload data with progress tracking via XHR.
     * @param {FormData} formData - Form data to upload
     * @param {string} password - Password carried to the success page in the URL fragment
     */
    function uploadWithProgress(formData, password) {
        const uploadBtn = required(root, '#share-action-btn', 'button');
        const progressContainer = required(root, '#share-progress-container', 'div');
        const progressBar = required(root, '#share-progress-bar', 'div');
        const progressText = required(root, '#share-progress-text', 'span');

        if (uploadInProgress) {
            return;
        }

        uploadInProgress = true;
        uploadBtn.disabled = true;
        uploadBtn.style.display = 'none';
        progressContainer.style.display = 'flex';
        progressBar.style.width = '0%';
        progressText.textContent = '0%';
        progressContainer.setAttribute('aria-valuenow', '0');

        const xhr = new deps.XMLHttpRequest();
        xhr.open('POST', uploadEndpoints.uploadUrl, true);
        xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
        xhr.setRequestHeader('X-CSRF-Token', csrfToken);

        xhr.upload.onprogress = function(e) {
            if (e.lengthComputable) {
                const percent = Math.round((e.loaded / e.total) * 100);
                progressBar.style.width = percent + '%';
                progressText.textContent = percent + '%';
                progressContainer.setAttribute('aria-valuenow', String(percent));
            }
        };

        xhr.onload = function() {
            if (xhr.status >= 200 && xhr.status < 300) {
                /** @type {UploadResponse} */
                let json = {};
                try {
                    json = JSON.parse(xhr.responseText);
                } catch (e) {
                    deps.alert('Upload succeeded but server returned invalid JSON');
                    uploadInProgress = false;
                    uploadBtn.disabled = false;
                    uploadBtn.style.display = '';
                    progressContainer.style.display = 'none';
                    return;
                }
                // Hand the password to the success page via the URL fragment —
                // the same in-memory-only channel as one-click links. It is
                // read once there and scrubbed; nothing is persisted.
                deps.navigate(
                    buildOneClickLink(`/success/${json.file_id}`, password));
            } else {
                let msg = 'Upload failed';
                try {
                    /** @type {UploadResponse} */
                    const err = JSON.parse(xhr.responseText);
                    if (err.error) msg = err.error;
                } catch (e) {}
                deps.alert(msg);
                uploadInProgress = false;
                uploadBtn.disabled = false;
                uploadBtn.style.display = '';
                progressContainer.style.display = 'none';
            }
        };

        xhr.onerror = function() {
            deps.alert('Network error during upload');
            uploadInProgress = false;
            uploadBtn.disabled = false;
            uploadBtn.style.display = '';
            progressContainer.style.display = 'none';
        };

        xhr.send(formData);
    }

    // --- Dropzone Logic ---
    /**
     * Show (or clear) the chip naming the file that is queued for encryption.
     * @param {File | null} file
     */
    function showSelectedFile(file) {
        const chip = root.getElementById('file-selected');
        const chipName = root.getElementById('file-selected-name');
        if (!chip || !chipName) return;
        chipName.textContent = file ? file.name : '';
        chip.hidden = !file;
    }

    /**
     * The region is always present and only its text changes, so assistive tech
     * announces every rejection rather than a one-time reveal.
     * @param {string} message
     */
    function setFileError(message) {
        const region = root.getElementById('file-error');
        if (region) region.textContent = message;
    }

    /**
     * Reject a disallowed file, discarding any earlier selection along with it.
     * @param {HTMLInputElement} input
     */
    function rejectFile(input) {
        input.value = '';
        showSelectedFile(null);
        setFileError('That file type is not allowed.');
    }

    const dropzone = root.getElementById('dropzone');
    if (dropzone) {
        const fileField = required(root, '#file', 'input');

        /** @param {boolean} isDragging */
        const setDragging = (isDragging) => dropzone.classList.toggle('dropzone-active', isDragging);

        ['dragenter', 'dragover'].forEach((eventName) => {
            dropzone.addEventListener(eventName, (e) => {
                e.preventDefault();
                setDragging(true);
            });
        });

        // dragleave also fires when crossing into a child, so ignore those.
        dropzone.addEventListener('dragleave', (e) => {
            if (!dropzone.contains(/** @type {Node | null} */ (e.relatedTarget))) {
                setDragging(false);
            }
        });

        dropzone.addEventListener('drop', (e) => {
            e.preventDefault();
            setDragging(false);
            const file = e.dataTransfer && e.dataTransfer.files[0];
            if (!file) return;
            if (!isAllowedFile(file.name, allowedExtensions)) {
                rejectFile(fileField);
                return;
            }
            // Hand the dropped file to the real input so the form submits it unchanged.
            const transfer = new window.DataTransfer();
            transfer.items.add(file);
            fileField.files = transfer.files;
            showSelectedFile(file);
            setFileError('');
        });
    }

    // --- File Upload Logic ---
    const fileUploadForm = /** @type {HTMLFormElement | null} */ (root.querySelector('#file-upload-section form'));
    if (fileUploadForm) {
        // Validate file extension when a file is selected
        required(root, '#file', 'input').addEventListener('change', (e) => {
            const input = /** @type {HTMLInputElement} */ (e.target);
            const file = input.files?.[0];
            if (!file) {
                showSelectedFile(null);
                return;
            }
            if (!isAllowedFile(file.name, allowedExtensions)) {
                rejectFile(input);
                return;
            }
            showSelectedFile(file);
            setFileError('');
        });

        // Handle form submission: encrypt file client-side, then upload
        fileUploadForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            if (uploadInProgress) return;
            const fileInput = required(root, '#file', 'input');
            const passInput = required(root, '#shared-password', 'input');
            const file = fileInput.files?.[0];
            const password = passInput.value;
            if (!file) {
                setFileError('Choose a file to share.');
                return;
            }
            if (!requirePassword(password) || !enforcePasswordStrength(password)) return;

            // Read and encrypt file data via the key-release handshake
            const fileData = new Uint8Array(await file.arrayBuffer());
            let prepared;
            try {
                prepared = await encryptForUpload(fileData, password);
            } catch (err) {
                const error = /** @type {Error | undefined} */ (err);
                deps.alert(error && error.message ? error.message : 'Upload failed');
                return;
            }

            // Prepare FormData
            const encBlob = new Blob([prepared.blob], { type: 'application/octet-stream' });
            const formData = new FormData();
            formData.append('file', new File([encBlob], file.name));
            formData.append('file_id', prepared.fileId);
            formData.append('key_verifier', prepared.keyVerifier);
            formData.append('receipt_hash', prepared.receiptHash);
            appendShareOptions(formData, readShareOptions());

            // Upload with progress
            uploadWithProgress(formData, password);
        });
    }

    // --- Text Note Upload Logic ---
    /**
     * Same always-present-region pattern as #file-error.
     * @param {string} message
     */
    function setNoteError(message) {
        const region = root.getElementById('note-error');
        if (region) region.textContent = message;
    }

    const noteField = root.getElementById('note-text');
    if (noteField) {
        noteField.addEventListener('input', () => setNoteError(''));
    }

    async function uploadNote() {
        if (uploadInProgress) return;
        const noteText = required(root, '#note-text', 'textarea').value;
        const password = required(root, '#shared-password', 'input').value;
        const shareOptions = readShareOptions();

        if (!noteText) {
            setNoteError('Write the note you want to share.');
            required(root, '#note-text', 'textarea').focus();
            return;
        }
        if (!requirePassword(password) || !enforcePasswordStrength(password)) return;

        // Encrypt text data via the key-release handshake
        const enc = new TextEncoder();
        const textData = enc.encode(noteText);
        let prepared;
        try {
            prepared = await encryptForUpload(textData, password);
        } catch (err) {
            const error = /** @type {Error | undefined} */ (err);
            deps.alert(error && error.message ? error.message : 'Upload failed');
            return;
        }

        // Prepare FormData with base64 encoded encrypted data
        const base64Encrypted = btoa(String.fromCharCode(...prepared.blob));
        const formData = new FormData();
        formData.append('note_text', base64Encrypted);
        formData.append('type', 'text');
        formData.append('file_id', prepared.fileId);
        formData.append('key_verifier', prepared.keyVerifier);
        formData.append('receipt_hash', prepared.receiptHash);
        appendShareOptions(formData, shareOptions);

        // Upload with progress
        uploadWithProgress(formData, password);
    }

    const shareActionButton = root.getElementById('share-action-btn');
    if (shareActionButton) {
        shareActionButton.addEventListener('click', () => {
            if (uploadInProgress) return;
            if (activeShareMode === 'text') {
                uploadNote();
                return;
            }

            const fileForm = /** @type {HTMLFormElement | null} */ (root.querySelector('#file-upload-section form'));
            if (fileForm) {
                fileForm.requestSubmit();
            }
        });
    }

    // --- Copy URL to Clipboard Logic ---
    /**
     * Every row shares one status region, so a long list does not become a page
     * full of live regions. The per-row pill is visual only.
     * @param {string} message
     */
    function setCopyStatus(message) {
        const region = root.getElementById('copy-status');
        if (region) region.textContent = message;
    }

    root.querySelectorAll('.copy-url').forEach(el => {
        const flash = /** @type {HTMLElement | null} */ (el.querySelector('.copy-flash'));
        /** @type {ReturnType<typeof setTimeout> | undefined} */
        let flashTimer;

        /**
         * Inline confirmation beats a modal dialog for something this small. The
         * pill carries the outcome for sighted users, the shared region announces
         * it, and a failure lingers longer because it has to be read.
         * @param {string} label
         * @param {string} message
         * @param {boolean} failed
         */
        const showResult = (label, message, failed) => {
            setCopyStatus(message);
            if (flash) {
                flash.textContent = label;
                flash.classList.toggle('copy-flash-error', failed);
                flash.hidden = false;
            }
            clearTimeout(flashTimer);
            flashTimer = setTimeout(() => {
                if (flash) flash.hidden = true;
                // Emptying it means the next copy writes fresh text, which is
                // what makes assistive tech announce it again.
                setCopyStatus('');
            }, failed ? 4000 : 1800);
        };

        el.addEventListener('click', (e) => {
            e.preventDefault();
            // Every .copy-url in the template carries its link in data-url.
            const url = /** @type {string} */ (el.getAttribute('data-url'));
            window.navigator.clipboard.writeText(url).then(
                () => showResult('Copied', 'Share link copied to clipboard.', false),
                // A denied permission or a non-secure context rejects here. Say so
                // rather than leaving the click with no feedback at all.
                () => showResult('Copy failed', 'Your browser blocked clipboard access, so the link was not copied.', true),
            );
        });
    });

    // Destructive forms carry their confirmation text in data-confirm-message —
    // a submit listener replaces the old inline onclick, which CSP forbids.
    /** @type {NodeListOf<HTMLFormElement>} */ (root.querySelectorAll('form[data-confirm-message]')).forEach((form) => {
        form.addEventListener('submit', (e) => {
            if (!window.confirm(form.dataset.confirmMessage)) {
                e.preventDefault();
            }
        });
    });

    // --- Shared Files Search & Pagination ---
    function initializeSharedFilesList() {
        const list = root.getElementById('shared-files-list');
        const searchInput = /** @type {HTMLInputElement | null} */ (root.getElementById('shared-files-search'));
        const sortInput = /** @type {HTMLSelectElement | null} */ (root.getElementById('shared-files-sort'));
        const emptyState = root.getElementById('shared-files-empty-state');
        const summary = root.getElementById('shared-files-summary');
        const pageLabel = root.getElementById('shared-files-page');
        const prevButton = /** @type {HTMLButtonElement | null} */ (root.getElementById('shared-files-prev'));
        const nextButton = /** @type {HTMLButtonElement | null} */ (root.getElementById('shared-files-next'));

        if (!list || !searchInput || !sortInput || !emptyState || !summary || !pageLabel || !prevButton || !nextButton) {
            return;
        }

        const rows = Array.from(/** @type {NodeListOf<SharedFileRow>} */ (list.querySelectorAll('.shared-file-row')));
        if (rows.length === 0) {
            return;
        }

        const pageSize = Math.max(parseInt(list.dataset.pageSize || '5', 10), 1);
        const params = new URLSearchParams(window.location.search);
        searchInput.value = params.get('shared_search') || '';
        let currentPage = Math.max(parseInt(params.get('shared_page') || '', 10) || 1, 1);

        const render = () => {
            const [sortField, sortDirection] = sortInput.value.split(':');
            const timestampField = /** @type {Record<string, string>} */ ({
                uploaded: 'uploadedAt',
                expiry: 'expiryAt',
                downloaded: 'downloadedAt'
            })[sortField];
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

        /** @param {SharedFileRow[]} pageRows */
        const refreshStatuses = async (pageRows) => {
            const statusUrl = list.dataset.statusUrl;
            if (!statusUrl || pageRows.length === 0) {
                return;
            }

            const params = new URLSearchParams();
            pageRows.forEach((row) => params.append('id', row.dataset.fileId));

            try {
                const response = await deps.fetch(`${statusUrl}?${params}`, {
                    headers: { 'X-Requested-With': 'XMLHttpRequest' },
                });
                if (!response.ok) {
                    return;
                }
                /** @type {FileStatusesResponse} */
                const { files } = await response.json();
                let updated = false;
                files.forEach((file) => {
                    const row = rows.find((item) => item.dataset.fileId === file.id);
                    if (!row) {
                        return;
                    }
                    const downloadedAt = required(row, '[data-file-downloaded-at]', 'dd');
                    const downloadedBy = required(row, '[data-file-downloaded-by]', 'dd');
                    const statusBadge = required(row, '[data-file-status]', 'span');
                    downloadedAt.textContent = file.downloaded_at || 'No';
                    downloadedBy.textContent = file.downloaded_by_ip || '-';
                    row.dataset.downloadedAt = file.downloaded_at || '';
                    statusBadge.textContent = file.status_display || 'Active';
                    statusBadge.classList.remove('status-badge-green', 'status-badge-red', 'status-badge-amber');
                    statusBadge.classList.add(statusBadgeClass(file));
                    row.dataset.searchText = rowSearchText(row.dataset.searchBase, file);
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
}
