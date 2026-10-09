// Session-authed mutating routes require the CSRF token base.html renders
// into <meta name="csrf-token">; requests carry it as X-CSRF-Token.

/**
 * The page's CSRF token, or '' where base.html rendered none.
 * @param {Document} root
 * @returns {string}
 */
export function csrfToken(root) {
    return /** @type {HTMLMetaElement | null} */ (root.querySelector('meta[name="csrf-token"]'))?.content || '';
}
