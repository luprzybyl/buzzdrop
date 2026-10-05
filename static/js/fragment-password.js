// One-click links carry the password in the URL fragment, which browsers
// never send to the server. Pages read it with readFragmentPassword() and
// scrub it from the address bar themselves (an effect, so it stays there).
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
 * `shareUrl` with the password as its fragment, replacing any fragment the
 * URL already carries.
 * @param {string} shareUrl
 * @param {string} password
 * @returns {string}
 */
export function buildOneClickLink(shareUrl, password) {
    return shareUrl.split('#')[0] + '#' + encodeURIComponent(password);
}
