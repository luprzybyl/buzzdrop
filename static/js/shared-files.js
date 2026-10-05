/**
 * A shared-files table row: anything carrying the `data-search-text` the
 * template (or rowSearchText) sets on it.
 * @typedef {{ dataset: { searchText: string } }} SearchableRow
 */

/**
 * A file's status as the shared-files table shows it.
 * @typedef {object} FileStatus
 * @property {string} status - 'active' or 'expired'
 * @property {string | null} [downloaded_at]
 * @property {string | null} [status_display]
 * @property {string | null} [downloaded_by_ip]
 */

/**
 * @template {SearchableRow} Row
 * @param {Row[]} rows
 * @param {string} searchTerm
 * @param {number} pageSize
 * @param {number} requestedPage
 * @returns {{filteredRows: Row[], visibleRows: Row[], currentPage: number, totalPages: number, startIndex: number}}
 */
export function getSharedFilesPage(rows, searchTerm, pageSize, requestedPage) {
    const safePageSize = Math.max(pageSize, 1);
    const normalizedSearch = searchTerm.trim().toLowerCase();
    const filteredRows = rows.filter((row) => row.dataset.searchText.includes(normalizedSearch));
    const totalPages = Math.max(Math.ceil(filteredRows.length / safePageSize), 1);
    const currentPage = Math.min(Math.max(requestedPage, 1), totalPages);
    const startIndex = (currentPage - 1) * safePageSize;

    return {
        filteredRows,
        visibleRows: filteredRows.slice(startIndex, startIndex + safePageSize),
        currentPage,
        totalPages,
        startIndex,
    };
}

/**
 * @param {string} currentUrl
 * @param {number} page
 * @param {string} searchTerm
 * @returns {URL}
 */
export function buildSharedFilesUrl(currentUrl, page, searchTerm) {
    const url = new URL(currentUrl);
    const normalizedSearch = searchTerm.trim();

    if (page > 1) {
        url.searchParams.set('shared_page', String(page));
    } else {
        url.searchParams.delete('shared_page');
    }
    if (normalizedSearch) {
        url.searchParams.set('shared_search', normalizedSearch);
    } else {
        url.searchParams.delete('shared_search');
    }

    return url;
}

// Downloaded wins over expired, which wins over active.
/**
 * @param {FileStatus} file
 * @returns {string}
 */
export function statusBadgeClass(file) {
    if (file.downloaded_at) return 'status-badge-green';
    if (file.status === 'expired') return 'status-badge-red';
    return 'status-badge-amber';
}

/**
 * @param {string} searchBase
 * @param {FileStatus} file
 * @returns {string}
 */
export function rowSearchText(searchBase, file) {
    return `${searchBase} ${file.status} ${file.status_display || ''} ${file.downloaded_by_ip || ''}`.toLowerCase();
}
