// Whether the upload form accepts a file named `name`. The extension is
// whatever follows the last dot, lowercased — a name without a dot is its
// own extension (`README` → `readme`). The server re-checks on upload.
export function isAllowedFile(name, allowedExtensions) {
    return allowedExtensions.includes(name.split('.').pop().toLowerCase());
}
