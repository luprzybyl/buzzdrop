// Copy buttons: put text on the clipboard, flash the outcome on the button's
// label and announce it in a status region. The button keeps its accessible
// name (its aria-label), so the flash is visual; the region is what assistive
// tech hears. A failure stays up longer, because it has to be read.

const COPIED_FLASH_MS = 2000;
const FAILED_FLASH_MS = 4000;

/**
 * A flash still on screen: its timer, and the label text it returns to.
 * @type {WeakMap<HTMLElement, {timer: ReturnType<typeof setTimeout>, resting: string | null}>}
 */
const flashes = new WeakMap();

/**
 * @typedef {object} CopyFeedback
 * @property {HTMLElement} status - the region that announces the outcome
 * @property {string} what - what is copied, as the status names it, e.g. 'Password'
 * @property {HTMLElement} [label] - the element whose text flashes; the
 *   button's `.copy-label`, or the button itself, by default
 * @property {boolean} [keepStatus] - leave the message in `status` after the
 *   flash, for a status line that isn't only for copies. By default it is
 *   emptied, so that the next copy writes fresh text, which is what makes
 *   assistive tech announce it again.
 */

/**
 * Copy `source` and show how it went. A string goes through the Clipboard
 * API; an input is copied by selecting it, which also works over plain HTTP,
 * where there is no Clipboard API.
 * @param {HTMLButtonElement} button
 * @param {string | HTMLInputElement} source
 * @param {CopyFeedback} feedback
 */
export function copyWithFeedback(button, source, feedback) {
    const { what } = feedback;
    const copied = () => flash(button, feedback, 'Copied!', `${what} copied to clipboard.`, COPIED_FLASH_MS);
    const failed = () => flash(button, feedback, 'Failed',
        `Your browser blocked clipboard access, so the ${what.toLowerCase()} was not copied.`, FAILED_FLASH_MS);

    if (typeof source !== 'string') {
        source.select();
        if (source.ownerDocument.execCommand('copy')) copied(); else failed();
        return;
    }
    const navigator = button.ownerDocument.defaultView?.navigator;
    // Started inside a promise so a missing Clipboard API (a non-secure
    // context has no navigator.clipboard) lands in the failure branch instead
    // of throwing with no feedback at all.
    Promise.resolve().then(() => /** @type {Navigator} */ (navigator).clipboard.writeText(source)).then(copied, failed);
}

/**
 * @param {HTMLButtonElement} button
 * @param {CopyFeedback} feedback
 * @param {string} outcome - what the label flashes
 * @param {string} message - what the status announces
 * @param {number} duration
 */
function flash(button, { status, label = button.querySelector('.copy-label') ?? button, keepStatus = false }, outcome, message, duration) {
    status.textContent = message;
    // A re-click mid-flash must not capture "Copied!" as the text to return
    // to, which would leave the label stuck on it.
    const pending = flashes.get(button);
    if (pending) clearTimeout(pending.timer);
    const resting = pending ? pending.resting : label.textContent;

    label.textContent = outcome;
    const timer = setTimeout(() => {
        label.textContent = resting;
        flashes.delete(button);
        if (!keepStatus) status.textContent = '';
    }, duration);
    flashes.set(button, { timer, resting });
}
