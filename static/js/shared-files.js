/**
 * A shared-files table row: anything carrying the `data-search-text` the
 * template (or rowSearchText) sets on it.
 * @typedef {{ dataset: { searchText: string } }} SearchableRow
 */

/**
 * A file's status as the shared-files table shows it.
 * @typedef {object} FileStatus
 * @property {string} status - 'active' or 'expired'
 * @property {string} status_key - 'active', 'decrypted', 'decryption-failed',
 *   'locked-out', 'downloaded' or 'expired'; only an active drop's link works
 * @property {string | null} [downloaded_at] - for display
 * @property {string | null} [downloaded_at_iso] - offset-aware ISO 8601
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

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * A timestamp as a short, scannable distance from now: "just now",
 * "2 min ago", "yesterday", "in 3 days". Every unit is rounded down, and a
 * month is 30 days, a year 365: this is for scanning, the full timestamp
 * stays in the element's title.
 * @param {number} then - epoch milliseconds
 * @param {number} now - epoch milliseconds
 * @returns {string | null} null when `then` is not a valid time
 */
export function relativeTime(then, now) {
    if (!Number.isFinite(then)) return null;
    const future = then > now;
    const elapsed = Math.abs(then - now);
    /** @param {number} count @param {string} unit */
    const phrase = (count, unit) => {
        const amount = `${count} ${unit}`;
        return future ? `in ${amount}` : `${amount} ago`;
    };
    /** @param {number} count @param {string} unit */
    const plural = (count, unit) => phrase(count, count === 1 ? unit : `${unit}s`);

    if (elapsed < MINUTE) return 'just now';
    if (elapsed < HOUR) return phrase(Math.floor(elapsed / MINUTE), 'min');
    if (elapsed < DAY) return phrase(Math.floor(elapsed / HOUR), 'h');
    const days = Math.floor(elapsed / DAY);
    if (days === 1) return future ? 'tomorrow' : 'yesterday';
    if (days < 30) return plural(days, 'day');
    if (days < 365) return plural(Math.floor(days / 30), 'month');
    return plural(Math.floor(days / 365), 'year');
}

/**
 * @param {string} searchBase
 * @param {Pick<FileStatus, 'status' | 'status_display' | 'downloaded_by_ip'>} file
 * @returns {string}
 */
export function rowSearchText(searchBase, file) {
    return `${searchBase} ${file.status} ${file.status_display || ''} ${file.downloaded_by_ip || ''}`.toLowerCase();
}
