// --- Confirm Download Page Logic ---
// One-click links carry the password in the URL fragment so it never
// reaches the server. Read it once, scrub it from the address bar and
// history entry, then re-attach it to the form action on submit — the
// POST navigation lands the next page on the same fragment, which
// view.js reads and clears. Nothing is persisted (no sessionStorage).
import { buildOneClickLink, readFragmentPassword } from './fragment-password.js';

// The page needs nothing beyond the DOM, which comes in as `root`; the URL and
// history are read from the root's own window.
export function browserDeps() {
    return {};
}

export function initConfirmDownload(root, deps) {
    const window = root.defaultView;

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
        root.getElementById('confirm-form').addEventListener('submit', function () {
            this.action = buildOneClickLink(this.action, fragmentPassword);
        });
    }
}
