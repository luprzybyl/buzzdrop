// Whether the upload form accepts a file named `name`. The extension is
// whatever follows the last dot, lowercased — a name without a dot is its
// own extension (`README` → `readme`). The server re-checks on upload.
/**
 * @param {string} name
 * @param {string[]} allowedExtensions - lowercase, without the dot
 * @returns {boolean}
 */
export function isAllowedFile(name, allowedExtensions) {
    // split() always yields at least one element, so pop() is never undefined.
    return allowedExtensions.includes(/** @type {string} */ (name.split('.').pop()).toLowerCase());
}
