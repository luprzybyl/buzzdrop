// --- Index page logic ---
// The composer (file/note tabs, dropzone, upload) and the shared-files list.
// The password gate, the upload protocol, the Copy buttons and the list come
// from their features; this page composes them. The page loads for anonymous
// visitors too, who get neither part, so lookups into those parts keep their
// null checks.

import { copyWithFeedback } from '../../features/clipboard-feedback/index.js';
import { initPasswordGate } from '../../features/password-gate/index.js';
import { createShare } from '../../features/share-protocol/index.js';
import { initSharedFilesList } from '../../features/shared-files/index.js';
import { isAllowedFile } from '../../lib/file-extensions.js';
import * as shareCrypto from '../../lib/crypto.js';
import { buildOneClickLink, takeFragmentPassword } from '../../lib/one-click-link.js';
import { required, requiredWindow } from '../../lib/required.js';

/**
 * @typedef {object} IndexDeps
 * @property {typeof fetch} fetch
 * @property {typeof XMLHttpRequest} XMLHttpRequest - supplies upload.onprogress
 * @property {(url: string) => void} navigate
 * @property {(message: string) => void} alert
 * @property {import('../../features/share-protocol/index.js').CreateDeps['crypto']} crypto
 * @property {() => number} now - epoch milliseconds, for the drop list's relative times
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
        crypto: shareCrypto,
        now: () => Date.now(),
    };
}

/**
 * @param {Document} root - the index.html document
 * @param {IndexDeps} deps
 */
export function initIndex(root, deps) {
    const window = requiredWindow(root);
    /** @type {'file' | 'text'} */
    let activeShareMode = 'file';
    let uploadInProgress = false;

    // The index page never uses URL fragments — a stray one here can only be a
    // password leaked by fragment inheritance across a redirect (e.g. a dead
    // one-click link). Taking it scrubs it from the address bar and history.
    takeFragmentPassword(window);

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

            // visibility, not display: the panels share a grid cell sized to
            // the taller one (index.html), so the inactive one keeps its space.
            if (panelNode) panelNode.style.visibility = isActive ? '' : 'hidden';
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

    /**
     * Show (or with '', clear) a refusal in one of the always-present error
     * regions (#file-error, #note-error). The region stays and only its text
     * changes, so assistive tech announces every refusal rather than a
     * one-time reveal.
     * @param {'file-error' | 'note-error'} regionId
     * @param {string} message
     */
    function showRefusal(regionId, message) {
        const region = root.getElementById(regionId);
        if (region) region.textContent = message;
    }

    // --- Password Generation & Strength Gate ---
    const passwordGate = initPasswordGate(root);
    if (passwordGate) {
        const copyBtn = required(root, '#copy-password-btn', 'button');
        const status = required(root, '#password-copy-status', 'p');
        const label = required(copyBtn, '#copy-password-label', 'span');
        copyBtn.addEventListener('click', () =>
            copyWithFeedback(copyBtn, passwordGate.input.value, { status, label, what: 'Password' }));
    }

    /**
     * The gate every upload passes: a missing or weak password is refused.
     * @param {string} password
     */
    const acceptPassword = (password) => passwordGate !== null && passwordGate.accept(password);

    // --- Open notifications ---
    // The account email (rendered only when there is one) shows while the
    // box is ticked.
    const notifyCheckbox = /** @type {HTMLInputElement | null} */ (root.getElementById('notify-on-open'));
    const notificationEmailField = root.getElementById('notification-email-field');
    if (notifyCheckbox && notificationEmailField) {
        notifyCheckbox.addEventListener('change', () => {
            notificationEmailField.hidden = !notifyCheckbox.checked;
        });
    }

    // --- Shared Upload Logic ---

    // Session-authed mutating routes require the CSRF token the server
    // renders into <meta name="csrf-token"> — read once, reused per request.
    const csrfToken =
        /** @type {HTMLMetaElement | null} */ (root.querySelector('meta[name="csrf-token"]'))?.content || '';

    /**
     * The share options as the composer currently holds them.
     * @returns {import('../../features/share-protocol/index.js').ShareOptions}
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
     * Seal the payload and upload it, with the progress bar standing in for
     * the share button while the upload runs. On success the page leaves for
     * the success page; otherwise it alerts and the button comes back.
     * @param {import('../../features/share-protocol/index.js').Payload} payload
     * @param {string} password - carried to the success page in the URL fragment
     */
    async function share(payload, password) {
        const uploadBtn = required(root, '#share-action-btn', 'button');
        const progressContainer = required(root, '#share-progress-container', 'div');
        const progressBar = required(root, '#share-progress-bar', 'div');
        const progressText = required(root, '#share-progress-text', 'span');

        /** @param {number} percent */
        const showProgress = (percent) => {
            uploadBtn.disabled = true;
            uploadBtn.style.display = 'none';
            progressContainer.style.display = 'flex';
            progressBar.style.width = percent + '%';
            progressText.textContent = percent + '%';
            progressContainer.setAttribute('aria-valuenow', String(percent));
        };

        uploadInProgress = true;
        /** @type {import('../../features/share-protocol/index.js').CreateResult} */
        let result;
        try {
            result = await createShare(payload, password, readShareOptions(), {
                fetch: deps.fetch,
                XMLHttpRequest: deps.XMLHttpRequest,
                crypto: deps.crypto,
                urls: { begin: uploadEndpoints.uploadBeginUrl, upload: uploadEndpoints.uploadUrl },
                csrfToken,
                onProgress: showProgress,
            });
        } catch (err) {
            const error = /** @type {Error | undefined} */ (err);
            result = { kind: 'refused', message: error && error.message ? error.message : 'Upload failed' };
        }

        if (result.kind === 'created') {
            // Hand the password to the success page via the URL fragment —
            // the same in-memory-only channel as one-click links. It is read
            // once there and scrubbed; nothing is persisted.
            deps.navigate(buildOneClickLink(`/success/${result.fileId}`, password));
            return;
        }
        deps.alert(result.kind === 'refused' ? result.message : 'Network error during upload');
        uploadInProgress = false;
        uploadBtn.disabled = false;
        uploadBtn.style.display = '';
        progressContainer.style.display = 'none';
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
     * Reject a disallowed file, discarding any earlier selection along with it.
     * @param {HTMLInputElement} input
     */
    function rejectFile(input) {
        input.value = '';
        showSelectedFile(null);
        showRefusal('file-error', 'That file type is not allowed.');
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
            showRefusal('file-error', '');
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
            showRefusal('file-error', '');
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
                showRefusal('file-error', 'Choose a file to share.');
                return;
            }
            if (!acceptPassword(password)) return;

            await share({ kind: 'file', name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) }, password);
        });
    }

    // --- Text Note Upload Logic ---
    const noteInput = root.getElementById('note-text');
    if (noteInput) {
        noteInput.addEventListener('input', () => showRefusal('note-error', ''));
    }

    async function uploadNote() {
        if (uploadInProgress) return;
        const noteField = required(root, '#note-text', 'textarea');
        const noteText = noteField.value;
        const password = required(root, '#shared-password', 'input').value;

        if (!noteText) {
            showRefusal('note-error', 'Write the note you want to share.');
            noteField.focus();
            return;
        }
        if (!acceptPassword(password)) return;

        await share({ kind: 'text', bytes: new TextEncoder().encode(noteText) }, password);
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
    // Every row shares one status region, so a long list does not become a
    // page full of live regions. The per-row pill is visual only.
    /** @type {NodeListOf<HTMLButtonElement>} */ (root.querySelectorAll('.copy-url')).forEach((button) => {
        button.addEventListener('click', (e) => {
            e.preventDefault();
            // Every .copy-url in the template carries its link in data-url.
            const url = /** @type {string} */ (button.getAttribute('data-url'));
            copyWithFeedback(button, url, { status: required(root, '#copy-status', 'p'), what: 'Share link' });
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
    initSharedFilesList(root, deps);
}
