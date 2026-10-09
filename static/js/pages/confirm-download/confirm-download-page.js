// --- Confirm Download Page Logic ---
// One-click links carry the password in the URL fragment so it never
// reaches the server. Take it (read once, scrubbed from the address bar and
// history entry), then re-attach it to the form action on submit — the
// POST navigation lands the next page on the same fragment, which the view
// page takes in turn. Nothing is persisted (no sessionStorage).
import { buildOneClickLink, takeFragmentPassword } from '../../lib/one-click-link.js';
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

    const fragmentPassword = takeFragmentPassword(window);
    if (fragmentPassword) {
        const hint = root.getElementById('password-hint');
        if (hint) {
            hint.textContent =
                'This link already carries the key — continue and the drop goes BZZT.';
        }
        required(root, '#confirm-form', 'form').addEventListener('submit', function () {
            // Only wired up when there is a fragment password.
            this.action = buildOneClickLink(this.action, fragmentPassword);
        });
    }
}
