// --- Success Page Logic ---
// This file controls the UI for the upload success page:
// - Copying the share link to clipboard
// - Toggling password visibility
// - Auto-filling the password from the URL fragment

import { buildOneClickLink, readFragmentPassword } from './fragment-password.js';

/**
 * @typedef {Record<string, never>} SuccessDeps
 */

// The page needs nothing beyond the DOM, which comes in as `root`; the URL and
// history are read from the root's own window.
/** @returns {SuccessDeps} */
export function browserDeps() {
    return {};
}

/**
 * @param {Document} root - the success.html document
 * @param {SuccessDeps} deps
 */
export function initSuccess(root, deps) {
    // A document handed to a page module always belongs to a window.
    const window = /** @type {Window} */ (root.defaultView);

    // One region for the page announces every copy; the button flash is visual.
    /** @param {string} message */
    function setCopyStatus(message) {
        const region = root.getElementById('copy-status');
        if (region) region.textContent = message;
    }

    /** @type {WeakMap<Element, {timer: ReturnType<typeof setTimeout>, originalText: string | null}>} */
    const copyFlashes = new WeakMap();

    // Flash confirmation on the button and announce it. Only the visible label is
    // rewritten: the button also carries a screen-reader-only prefix naming which
    // link it copies, and setting textContent on the button itself would destroy it.
    /**
     * @param {Element} button
     * @param {string} message
     */
    function flashCopied(button, message) {
        setCopyStatus(message);
        const label = button.querySelector('.copy-label');
        // A re-click mid-flash must not capture "Copied!" as the text to restore,
        // which would leave the label stuck on it.
        const pending = copyFlashes.get(button);
        if (pending) clearTimeout(pending.timer);
        const originalText = pending ? pending.originalText : (label ? label.textContent : '');

        if (label) label.textContent = 'Copied!';
        const timer = setTimeout(() => {
            if (label) label.textContent = originalText;
            copyFlashes.delete(button);
            // Emptying it means the next copy writes fresh text, which is what
            // makes assistive tech announce it again.
            setCopyStatus('');
        }, 2000);
        copyFlashes.set(button, { timer, originalText });
    }

    // Copy the share link to clipboard and show a temporary message
    function copyLink() {
        const shareLink = /** @type {HTMLInputElement} */ (root.getElementById('share-link'));
        shareLink.select();
        root.execCommand('copy');
        // The template puts each copy button right after its input.
        flashCopied(/** @type {Element} */ (shareLink.nextElementSibling), 'Link copied to clipboard.');
    }

    // Copy the share link with password to clipboard
    function copyLinkWithPassword() {
        const shareLinkWithPassword = /** @type {HTMLInputElement} */ (root.getElementById('share-link-with-password'));
        shareLinkWithPassword.select();
        root.execCommand('copy');
        flashCopied(/** @type {Element} */ (shareLinkWithPassword.nextElementSibling), 'One-click link copied to clipboard.');
    }

    // A reveal's auto-hide; a manual Hide cancels it, so it can't cut a later
    // reveal short.
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let hideTimer;

    // Toggle password field between 'password' and 'text' for user convenience
    function togglePasswordVisibility() {
        const pwdInput = /** @type {HTMLInputElement} */ (root.getElementById('password-display'));
        const toggleBtn = /** @type {HTMLButtonElement} */ (root.getElementById('toggle-password'));
        clearTimeout(hideTimer);
        if (pwdInput.type === 'password') {
            pwdInput.type = 'text';
            toggleBtn.textContent = 'Hide';
            hideTimer = setTimeout(() => {
                pwdInput.type = 'password';
                toggleBtn.textContent = 'Show';
            }, 5000);
        } else {
            pwdInput.type = 'password';
            toggleBtn.textContent = 'Show';
        }
    }

    // Buttons wire up here, not via inline onclick — CSP forbids inline handlers.
    /** @type {HTMLButtonElement} */ (root.getElementById('copy-link-btn')).addEventListener('click', copyLink);
    /** @type {HTMLButtonElement} */ (root.getElementById('copy-one-click-btn')).addEventListener('click', copyLinkWithPassword);
    /** @type {HTMLButtonElement} */ (root.getElementById('toggle-password')).addEventListener('click', togglePasswordVisibility);

    // Auto-fill the password from the URL fragment (the upload flow navigates
    // here with it). Read it once, then scrub it from the address bar and
    // history entry — nothing is persisted. The entry is a module script, so
    // the DOM is already parsed when this runs.
    if (window.location.hash.length <= 1) return;
    const pwd = readFragmentPassword(window.location.hash);
    window.history.replaceState(
        null, '', window.location.pathname + window.location.search);
    if (pwd) {
        /** @type {HTMLInputElement} */ (root.getElementById('password-display')).value = pwd;

        // Generate link with password in URL fragment
        const shareLink = /** @type {HTMLInputElement} */ (root.getElementById('share-link')).value;
        /** @type {HTMLInputElement} */ (root.getElementById('share-link-with-password')).value = buildOneClickLink(shareLink, pwd);
    }
}
