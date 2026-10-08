// --- Success Page Logic ---
// This file controls the UI for the upload success page:
// - Copying the share link, the password and the one-click link to clipboard
// - Toggling password visibility
// - Auto-filling the password and one-click link from the URL fragment

import { buildOneClickLink, readFragmentPassword } from './fragment-password.js';
import { required, requiredWindow } from './required.js';

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

    /**
     * One region for the page announces every copy; the button flash is visual.
     * @param {string} message
     */
    function setCopyStatus(message) {
        const region = root.getElementById('copy-status');
        if (region) region.textContent = message;
    }

    const COPIED_FLASH_MS = 2000;
    const FAILED_FLASH_MS = 4000;

    /** @type {WeakMap<HTMLButtonElement, {timer: ReturnType<typeof setTimeout>, originalText: string | null}>} */
    const copyFlashes = new WeakMap();

    /**
     * Flash the outcome on the button and announce it. Only the visible label
     * is rewritten: the button's accessible name comes from its aria-label,
     * and setting textContent on the button itself would drop the label span.
     * @param {HTMLButtonElement} button
     * @param {string} label
     * @param {string} message
     * @param {boolean} failed
     */
    function flashCopyResult(button, label, message, failed) {
        setCopyStatus(message);
        const labelEl = button.querySelector('.copy-label');
        // A re-click mid-flash must not capture "Copied!" as the text to restore,
        // which would leave the label stuck on it.
        const pending = copyFlashes.get(button);
        if (pending) clearTimeout(pending.timer);
        const originalText = pending ? pending.originalText : (labelEl ? labelEl.textContent : '');

        if (labelEl) labelEl.textContent = label;
        const timer = setTimeout(() => {
            if (labelEl) labelEl.textContent = originalText;
            copyFlashes.delete(button);
            // Emptying it means the next copy writes fresh text, which is what
            // makes assistive tech announce it again.
            setCopyStatus('');
        }, failed ? FAILED_FLASH_MS : COPIED_FLASH_MS);
        copyFlashes.set(button, { timer, originalText });
    }

    /**
     * Put `text` on the clipboard through the Clipboard API. The share link is
     * copied by selecting its field instead, which also works over plain HTTP,
     * where there is no Clipboard API; a password field's value can't be
     * copied by selection, and the one-click link isn't on the page in full.
     * @param {HTMLButtonElement} button
     * @param {string} text
     * @param {string} what - what is copied, as the status names it, e.g. 'Password'
     */
    function copyText(button, text, what) {
        // Started inside a promise so a missing Clipboard API (a non-secure
        // context has no navigator.clipboard) lands in the failure branch
        // instead of throwing with no feedback at all.
        Promise.resolve().then(() => window.navigator.clipboard.writeText(text)).then(
            () => flashCopyResult(button, 'Copied!', `${what} copied to clipboard.`, false),
            () => flashCopyResult(button, 'Failed',
                `Your browser blocked clipboard access, so the ${what.toLowerCase()} was not copied.`, true),
        );
    }

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
    copyLinkBtn.addEventListener('click', () => {
        shareLink.select();
        root.execCommand('copy');
        flashCopyResult(copyLinkBtn, 'Copied!', 'Link copied to clipboard.', false);
    });
    copyPasswordBtn.addEventListener('click', () => copyText(copyPasswordBtn, pwdInput.value, 'Password'));
    copyOneClickBtn.addEventListener('click', () => copyText(copyOneClickBtn, oneClickLink, 'One-click link'));
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
        copyPasswordBtn.disabled = false;

        // The convenience link: password in the fragment, ready to paste
        // anywhere. Deliberate, and deliberately labelled as such on the page —
        // see the tradeoff spelled out in fragment-password.js. The page shows
        // it with the fragment masked, like the password field.
        oneClickLink = buildOneClickLink(shareLink.value, pwd);
        oneClickDisplay.hidden = false;
        copyOneClickBtn.disabled = false;
    }
}
