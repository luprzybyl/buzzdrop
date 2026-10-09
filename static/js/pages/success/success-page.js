// --- Success Page Logic ---
// This file controls the UI for the upload success page:
// - Copying the share link, the password and the one-click link to clipboard
// - Toggling password visibility
// - Auto-filling the password and one-click link from the URL fragment

import { copyWithFeedback } from '../../features/clipboard-feedback/index.js';
import { buildOneClickLink, readFragmentPassword } from '../../lib/one-click-link.js';
import { required, requiredWindow } from '../../lib/required.js';

/**
 * @typedef {Record<string, never>} SuccessDeps
 */

/**
 * The page needs nothing beyond the DOM, which comes in as `root`; the URL and
 * history are read from the root's own window.
 * @returns {SuccessDeps}
 */
export function browserDeps() {
    return {};
}

/**
 * @param {Document} root - the success.html document
 * @param {SuccessDeps} deps
 */
export function initSuccess(root, deps) {
    const window = requiredWindow(root);
    const shareLink = required(root, '#share-link', 'input');
    const oneClickDisplay = required(root, '#one-click-link', 'p');
    const pwdInput = required(root, '#password-display', 'input');
    const copyLinkBtn = required(root, '#copy-link-btn', 'button');
    const copyPasswordBtn = required(root, '#copy-password-btn', 'button');
    const copyOneClickBtn = required(root, '#copy-one-click-btn', 'button');
    const toggleBtn = required(root, '#toggle-password', 'button');
    const toggleLabel = required(toggleBtn, '#toggle-password-label', 'span');

    // One region for the page announces every copy; the button flash is visual.
    const copyStatus = required(root, '#copy-status', 'p');

    /** The one-click link, once the fragment has supplied a password. */
    let oneClickLink = '';

    /**
     * A reveal's auto-hide; a manual Hide cancels it, so it can't cut a later
     * reveal short.
     * @type {ReturnType<typeof setTimeout> | undefined}
     */
    let hideTimer;

    // Toggle password field between 'password' and 'text' for user convenience
    function togglePasswordVisibility() {
        clearTimeout(hideTimer);
        if (pwdInput.type === 'password') {
            pwdInput.type = 'text';
            toggleLabel.textContent = 'Hide';
            hideTimer = setTimeout(() => {
                pwdInput.type = 'password';
                toggleLabel.textContent = 'Show';
            }, 5000);
        } else {
            pwdInput.type = 'password';
            toggleLabel.textContent = 'Show';
        }
    }

    // Buttons wire up here, not via inline onclick — CSP forbids inline handlers.
    // The share link is copied by selecting its field, which also works over
    // plain HTTP, where there is no Clipboard API; a password field's value
    // can't be copied by selection, and the one-click link isn't on the page
    // in full.
    copyLinkBtn.addEventListener('click', () =>
        copyWithFeedback(copyLinkBtn, shareLink, { status: copyStatus, what: 'Link' }));
    copyPasswordBtn.addEventListener('click', () =>
        copyWithFeedback(copyPasswordBtn, pwdInput.value, { status: copyStatus, what: 'Password' }));
    copyOneClickBtn.addEventListener('click', () =>
        copyWithFeedback(copyOneClickBtn, oneClickLink, { status: copyStatus, what: 'One-click link' }));
    toggleBtn.addEventListener('click', togglePasswordVisibility);

    // Auto-fill the password from the URL fragment (the upload flow navigates
    // here with it). Read it once, then scrub it from the address bar and
    // history entry — nothing is persisted. The entry is a module script, so
    // the DOM is already parsed when this runs.
    if (window.location.hash.length <= 1) return;
    const pwd = readFragmentPassword(window.location.hash);
    window.history.replaceState(
        null, '', window.location.pathname + window.location.search);
    if (pwd) {
        pwdInput.value = pwd;
        toggleBtn.disabled = false;
        copyPasswordBtn.disabled = false;

        // The convenience link: password in the fragment, ready to paste
        // anywhere. Deliberate, and deliberately labelled as such on the page —
        // see the tradeoff spelled out in lib/one-click-link.js. The page shows
        // it with the fragment masked, like the password field.
        oneClickLink = buildOneClickLink(shareLink.value, pwd);
        oneClickDisplay.hidden = false;
        copyOneClickBtn.disabled = false;
    }
}
