// PROTOTYPE — throwaway, answers wayfinder ticket "What shape should the
// testability refactor of page scripts take?" (#158). Not wired into any
// template. Shows ONE slice of main.js (text-note upload) in the proposed
// shape:
//
//   * side-effect-free page module: exports init(root, deps), touches
//     nothing at import time
//   * main.js shrinks to a 2-line auto-run entry (see PROTOTYPE-main-entry.js),
//     so the <script type="module" src=main.js integrity=…> tag is unchanged
//   * per-init state (uploadInProgress) lives in the init closure, so each
//     test gets a fresh page without vi.resetModules()
//   * deps are the TRANSPORT-level seams happy-dom can't fake faithfully
//     (fetch, XMLHttpRequest — no upload.onprogress in happy-dom), plus the
//     effects tests must observe (navigate, alert). Everything happy-dom
//     models well (DOM, history, clipboard) stays global/root-scoped.

import { CryptoService, bytesToHex, hexToBytes } from './crypto.js';

/** Real-browser deps. The only place that reaches for window globals. */
export function browserDeps() {
    return {
        fetch: (...args) => window.fetch(...args),
        XMLHttpRequest: window.XMLHttpRequest,
        navigate: (url) => { window.location.href = url; },
        alert: (msg) => window.alert(msg),
        crypto: new CryptoService(),
    };
}

/**
 * Wire the index page's share panel (note slice only, in this prototype).
 * @param {Document|Element} root - document in prod; the fixture's document in tests
 * @param {ReturnType<typeof browserDeps>} deps
 * @returns {{ uploadNote: () => Promise<void> }} handles for tests that
 *   prefer calling over clicking (optional; clicking works too)
 */
export function initIndexPage(root, deps) {
    const $ = (id) => root.querySelector(`#${id}`);
    const config = JSON.parse($('upload-endpoints-json').textContent);
    const csrfToken = root.querySelector('meta[name="csrf-token"]')?.content || '';
    let uploadInProgress = false;

    // Unchanged from main.js except fetch/crypto come from deps.
    async function encryptForUpload(data, password) {
        const res = await deps.fetch(config.uploadBeginUrl, {
            method: 'POST',
            headers: {
                'X-Requested-With': 'XMLHttpRequest',
                'X-CSRF-Token': csrfToken,
            },
        });
        if (!res.ok) {
            throw new Error('The server refused the upload handshake.');
        }
        const { file_id, h } = await res.json();
        const { blob, verifier, receipt } = await deps.crypto.encrypt(
            data, password, hexToBytes(h));
        return {
            blob,
            fileId: file_id,
            keyVerifier: bytesToHex(verifier),
            receiptHash: await deps.crypto.receiptHash(receipt),
        };
    }

    // Unchanged from main.js except XHR/navigate/alert come from deps.
    function uploadWithProgress(formData, password) {
        const uploadBtn = $('share-action-btn');
        const progressContainer = $('share-progress-container');
        const progressBar = $('share-progress-bar');
        const progressText = $('share-progress-text');
        if (uploadInProgress) return;

        const resetUi = () => {
            uploadInProgress = false;
            uploadBtn.disabled = false;
            uploadBtn.style.display = '';
            progressContainer.style.display = 'none';
        };

        uploadInProgress = true;
        uploadBtn.disabled = true;
        uploadBtn.style.display = 'none';
        progressContainer.style.display = 'flex';
        progressBar.style.width = '0%';
        progressText.textContent = '0%';

        const xhr = new deps.XMLHttpRequest();
        xhr.open('POST', config.uploadUrl, true);
        xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
        xhr.setRequestHeader('X-CSRF-Token', csrfToken);
        xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) {
                const percent = Math.round((e.loaded / e.total) * 100);
                progressBar.style.width = percent + '%';
                progressText.textContent = percent + '%';
            }
        };
        xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
                let json;
                try {
                    json = JSON.parse(xhr.responseText);
                } catch (e) {
                    deps.alert('Upload succeeded but server returned invalid JSON');
                    resetUi();
                    return;
                }
                deps.navigate(`/success/${json.file_id}#${encodeURIComponent(password)}`);
            } else {
                let msg = 'Upload failed';
                try {
                    const err = JSON.parse(xhr.responseText);
                    if (err.error) msg = err.error;
                } catch (e) {}
                deps.alert(msg);
                resetUi();
            }
        };
        xhr.onerror = () => {
            deps.alert('Network error during upload');
            resetUi();
        };
        xhr.send(formData);
    }

    async function uploadNote() {
        if (uploadInProgress) return;
        const noteText = $('note-text').value;
        const password = $('shared-password').value;
        const expiry = $('shared-expiry').value;
        if (!noteText || !password) {
            deps.alert('Please enter both text and password');
            return;
        }
        // (enforcePasswordStrength elided in the prototype)

        let prepared;
        try {
            prepared = await encryptForUpload(new TextEncoder().encode(noteText), password);
        } catch (err) {
            deps.alert(err && err.message ? err.message : 'Upload failed');
            return;
        }
        const formData = new FormData();
        formData.append('note_text', btoa(String.fromCharCode(...prepared.blob)));
        formData.append('type', 'text');
        formData.append('file_id', prepared.fileId);
        formData.append('key_verifier', prepared.keyVerifier);
        formData.append('receipt_hash', prepared.receiptHash);
        if (expiry) formData.append('expiry', expiry);
        uploadWithProgress(formData, password);
    }

    $('share-action-btn')?.addEventListener('click', () => {
        if (uploadInProgress) return;
        uploadNote(); // prototype: text mode only
    });

    return { uploadNote };
}
