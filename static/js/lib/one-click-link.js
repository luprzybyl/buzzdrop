// One-click links carry the password in the URL fragment, which browsers
// never send to the server. A page takes it with takeFragmentPassword(),
// which reads it once and scrubs it from the address bar and history entry,
// so that rule lives here rather than in each page. Nothing is persisted.
//
// Deliberately kept, and the tradeoff is worth stating plainly: for a lot of
// shares the friction of a second channel costs more than the exposure buys.
// But a share whose password rides along with the link is not encrypted
// against that link — Slack/DM history, notification previews, exports and
// channel backups all keep it, and whoever reads it decrypts without ever
// reaching /release. Two channels is the entire point of the split key; one
// channel is a convenience that quietly spends it. Fine for a throwaway note,
// just spend it on purpose.

/**
 * The password in a `location.hash` value, or null when there is none or it
 * is not valid percent-encoding.
 * @param {string} hash
 * @returns {string | null}
 */
export function readFragmentPassword(hash) {
    if (hash.length <= 1) return null;
    try {
        return decodeURIComponent(hash.substring(1));
    } catch {
        return null;
    }
}

/**
 * Read the password from the page's fragment, then scrub any fragment from
 * the address bar and the current history entry (without adding one). A
 * page that never uses a fragment calls it too: a stray one there can only
 * be a password leaked by fragment inheritance across a redirect.
 * @param {{ location: Location | URL, history: Pick<History, 'replaceState'> }} window - the page's window
 * @returns {string | null} as readFragmentPassword()
 */
export function takeFragmentPassword(window) {
    const { hash, pathname, search } = window.location;
    if (hash.length <= 1) return null;
    window.history.replaceState(null, '', pathname + search);
    return readFragmentPassword(hash);
}

/**
 * `shareUrl` with the password as its fragment, replacing any fragment the
 * URL already carries.
 * @param {string} shareUrl
 * @param {string} password
 * @returns {string}
 */
export function buildOneClickLink(shareUrl, password) {
    return shareUrl.split('#')[0] + '#' + encodeURIComponent(password);
}
