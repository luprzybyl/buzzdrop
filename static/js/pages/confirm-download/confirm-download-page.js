// --- Confirm Download Page Logic ---
// One-click links carry the password in the URL fragment so it never
// reaches the server. Read it once, scrub it from the address bar and
// history entry, then re-attach it to the form action on submit — the
// POST navigation lands the next page on the same fragment, which
// view.js reads and clears. Nothing is persisted (no sessionStorage).
import { buildOneClickLink, readFragmentPassword } from '../../lib/one-click-link.js';
import { required, requiredWindow } from '../../lib/required.js';

/**
 * @typedef {Record<string, never>} ConfirmDownloadDeps
 */

/**
 * The page needs nothing beyond the DOM, which comes in as `root`; the URL and
 * history are read from the root's own window.
 * @returns {ConfirmDownloadDeps}
 */
export function browserDeps() {
    return {};
}

/**
 * @param {Document} root - the confirm_download.html document
 * @param {ConfirmDownloadDeps} deps
 */
export function initConfirmDownload(root, deps) {
    const window = requiredWindow(root);

    var fragmentPassword = readFragmentPassword(window.location.hash);
    if (window.location.hash.length > 1) {
        window.history.replaceState(
            null, '', window.location.pathname + window.location.search);
    }
    if (fragmentPassword) {
        var hint = root.getElementById('password-hint');
        if (hint) {
            hint.textContent =
                'This link already carries the key — continue and the drop goes BZZT.';
        }
        required(root, '#confirm-form', 'form').addEventListener('submit', function () {
            // Only wired up when there is a fragment password.
            this.action = buildOneClickLink(this.action, /** @type {string} */ (fragmentPassword));
        });
    }
}
