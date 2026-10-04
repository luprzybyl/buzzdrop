// --- Confirm Download Page Logic ---
// One-click links carry the password in the URL fragment so it never
// reaches the server. Read it once, scrub it from the address bar and
// history entry, then re-attach it to the form action on submit — the
// POST navigation lands the next page on the same fragment, which
// view.js reads and clears. Nothing is persisted (no sessionStorage).
(function () {
    var fragmentPassword = null;
    if (window.location.hash.length > 1) {
        try {
            fragmentPassword = decodeURIComponent(window.location.hash.substring(1));
        } catch (e) {
            fragmentPassword = null;
        }
        window.history.replaceState(
            null, '', window.location.pathname + window.location.search);
    }
    if (fragmentPassword) {
        document.getElementById('confirm-form').addEventListener('submit', function () {
            this.action = this.action.split('#')[0]
                + '#' + encodeURIComponent(fragmentPassword);
        });
    }
})();
