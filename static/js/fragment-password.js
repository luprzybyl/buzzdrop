// One-click links carry the password in the URL fragment, which browsers
// never send to the server. Pages read it with readFragmentPassword() and
// scrub it from the address bar themselves (an effect, so it stays there).

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
