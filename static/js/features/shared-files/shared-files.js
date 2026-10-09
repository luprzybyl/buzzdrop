/**
 * A shared-files table row: anything carrying the `data-search-text` the
 * template (or rowSearchText) sets on it.
 * @typedef {{ dataset: { searchText: string } }} SearchableRow
 */

/**
 * utils.STATUS_LABELS' keys, which the badge's data-status styles by.
 * @typedef {'active' | 'decrypted' | 'downloaded' | 'locked-out' | 'expired'} StatusKey
 */

/**
 * A file's status as the shared-files table shows it.
 * @typedef {object} FileStatus
 * @property {string} status - 'active' or 'expired'
 * @property {StatusKey} status_key - only an active drop's link works
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
 * A row as the Sort menu orders it: by the ISO timestamps (with offsets) the
 * template sets in its data attributes, empty when there is none.
 * @typedef {{ dataset: { uploadedAt?: string, expiryAt?: string, downloadedAt?: string } }} TimedRow
 */

/** The Sort menu's fields, by the data attribute each orders by. */
const SORT_FIELDS = /** @type {const} */ ({ uploaded: 'uploadedAt', expiry: 'expiryAt', downloaded: 'downloadedAt' });

/**
 * The comparator for a Sort menu value such as 'uploaded:desc'. Times are
 * compared as instants, since CET and CEST strings don't sort lexically;
 * rows without the time go last in either direction, and rows it can't tell
 * apart keep their order.
 * @param {string} sort - '<field>:<asc|desc>'
 * @returns {(a: TimedRow, b: TimedRow) => number}
 */
export function compareRows(sort) {
    const [field, direction] = sort.split(':');
    const key = /** @type {Record<string, keyof TimedRow['dataset']>} */ (SORT_FIELDS)[field];
    const sign = direction === 'desc' ? -1 : 1;
    /** @param {TimedRow} row */
    const instant = (row) => (key ? Date.parse(row.dataset[key] || '') : NaN);
    return (a, b) => {
        const at = instant(a);
        const bt = instant(b);
        if (Number.isNaN(at) || Number.isNaN(bt)) {
            return !Number.isNaN(at) ? -1 : !Number.isNaN(bt) ? 1 : 0;
        }
        if (at === bt) return 0;
        return (at < bt ? -1 : 1) * sign;
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
 * "2 min ago", "yesterday", "in 3 days". Each unit is rounded to the nearest
 * whole one (an expiry set three days out still reads "in 3 days" a few
 * minutes later), a month is 30 days and a year 365: this is for scanning,
 * the full timestamp stays in the element's title.
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

    if (elapsed < MINUTE) return future ? 'in under a minute' : 'just now';
    const minutes = Math.round(elapsed / MINUTE);
    if (minutes < 60) return phrase(minutes, 'min');
    const hours = Math.round(elapsed / HOUR);
    if (hours < 24) return phrase(hours, 'h');
    const days = Math.round(elapsed / DAY);
    if (days === 1) return future ? 'tomorrow' : 'yesterday';
    if (days < 30) return plural(days, 'day');
    const months = Math.round(days / 30);
    if (months < 12) return plural(months, 'month');
    return plural(Math.max(Math.round(days / 365), 1), 'year');
}

/**
 * @param {string} searchBase
 * @param {Pick<FileStatus, 'status' | 'status_display' | 'downloaded_by_ip'>} file
 * @returns {string}
 */
export function rowSearchText(searchBase, file) {
    return `${searchBase} ${file.status} ${file.status_display || ''} ${file.downloaded_by_ip || ''}`.toLowerCase();
}
