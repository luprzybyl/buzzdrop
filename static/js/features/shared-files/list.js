// The drop list on the index page: sort, search, paging (kept in the
// address), relative times, and a status refresh for the rows on screen.

import { required, requiredWindow } from '../../lib/required.js';
import { buildSharedFilesUrl, compareRows, getSharedFilesPage, relativeTime, rowSearchText } from './shared-files.js';

/**
 * What the shared-files status endpoint answers.
 * @typedef {{files: Array<import('./shared-files.js').FileStatus & {id: string}>}} FileStatusesResponse
 */

/**
 * A shared-files row; the template sets all of these data attributes.
 * @typedef {HTMLElement & {dataset: DOMStringMap & {fileId: string, searchBase: string, searchText: string, uploadedAt: string, expiryAt: string, downloadedAt: string}}} SharedFileRow
 */

/**
 * @typedef {object} SharedFilesDeps
 * @property {typeof fetch} fetch - for the status refresh
 * @property {() => number} now - epoch milliseconds, for the relative times
 */

/**
 * Wire up the list, if the page has one with rows in it.
 * @param {Document} root
 * @param {SharedFilesDeps} deps
 */
export function initSharedFilesList(root, deps) {
    const window = requiredWindow(root);
    const list = root.getElementById('shared-files-list');
    const searchInput = /** @type {HTMLInputElement | null} */ (root.getElementById('shared-files-search'));
    const sortInput = /** @type {HTMLSelectElement | null} */ (root.getElementById('shared-files-sort'));
    const emptyState = root.getElementById('shared-files-empty-state');
    const summary = root.getElementById('shared-files-summary');
    const pageLabel = root.getElementById('shared-files-page');
    const pagination = root.getElementById('shared-files-pagination');
    const prevButton = /** @type {HTMLButtonElement | null} */ (root.getElementById('shared-files-prev'));
    const nextButton = /** @type {HTMLButtonElement | null} */ (root.getElementById('shared-files-next'));

    if (!list || !searchInput || !sortInput || !emptyState || !summary || !pagination || !pageLabel || !prevButton || !nextButton) {
        return;
    }

    const rows = Array.from(/** @type {NodeListOf<SharedFileRow>} */ (list.querySelectorAll('.shared-file-row')));
    if (rows.length === 0) {
        return;
    }

    /**
     * Swap each full timestamp for one relative to now; the full one stays
     * in the element's title (the template sets it).
     * @param {ParentNode} container
     */
    const showRelativeTimes = (container) => {
        const now = deps.now();
        /** @type {NodeListOf<HTMLTimeElement>} */ (container.querySelectorAll('time[datetime]')).forEach((time) => {
            const relative = relativeTime(Date.parse(time.dateTime), now);
            if (relative) time.textContent = relative;
        });
    };
    showRelativeTimes(list);

    const pageSize = Math.max(parseInt(list.dataset.pageSize || '5', 10), 1);
    const params = new URLSearchParams(window.location.search);
    searchInput.value = params.get('shared_search') || '';
    let currentPage = Math.max(parseInt(params.get('shared_page') || '', 10) || 1, 1);

    const render = () => {
        const sortedRows = [...rows].sort(compareRows(sortInput.value));
        sortedRows.forEach((row) => list.appendChild(row));
        const page = getSharedFilesPage(sortedRows, searchInput.value, pageSize, currentPage);
        const totalResults = page.filteredRows.length;
        currentPage = page.currentPage;

        rows.forEach((row) => {
            row.style.display = 'none';
        });

        page.visibleRows.forEach((row) => {
            row.style.display = '';
        });

        if (totalResults === 0) {
            emptyState.style.display = 'block';
            pageLabel.textContent = 'Page 0 of 0';
            summary.textContent = 'No matching drops';
        } else {
            emptyState.style.display = 'none';
            pageLabel.textContent = `Page ${currentPage} of ${page.totalPages}`;
            summary.textContent = `Showing ${page.startIndex + 1}-${Math.min(page.startIndex + pageSize, totalResults)} of ${totalResults} drops`;
        }

        pagination.hidden = page.totalPages <= 1;
        prevButton.disabled = currentPage <= 1 || totalResults === 0;
        nextButton.disabled = currentPage >= page.totalPages || totalResults === 0;
        return page;
    };

    // The page and search live in the address, so a reload or a shared link
    // lands on the same view; replaced, so paging adds no history entries.
    const rememberPage = () => window.history.replaceState(
        window.history.state, '', buildSharedFilesUrl(window.location.href, currentPage, searchInput.value));

    /** @param {SharedFileRow[]} pageRows */
    const refreshStatuses = async (pageRows) => {
        const statusUrl = list.dataset.statusUrl;
        if (!statusUrl || pageRows.length === 0) {
            return;
        }

        const params = new URLSearchParams();
        pageRows.forEach((row) => params.append('id', row.dataset.fileId));

        try {
            const response = await deps.fetch(`${statusUrl}?${params}`, {
                headers: { 'X-Requested-With': 'XMLHttpRequest' },
            });
            if (!response.ok) {
                return;
            }
            /** @type {FileStatusesResponse} */
            const { files } = await response.json();
            let updated = false;
            files.forEach((file) => {
                const row = rows.find((item) => item.dataset.fileId === file.id);
                if (!row) {
                    return;
                }
                const downloadedAt = required(row, '[data-file-downloaded-at]', 'dd');
                const downloadedBy = required(row, '[data-file-downloaded-by]', 'dd');
                const statusBadge = required(row, '[data-file-status]', 'span');
                const copyButton = required(row, '.copy-url', 'button');
                if (file.downloaded_at) {
                    const time = root.createElement('time');
                    time.dateTime = file.downloaded_at_iso || '';
                    time.title = file.downloaded_at;
                    time.textContent = file.downloaded_at;
                    downloadedAt.replaceChildren(time);
                    showRelativeTimes(downloadedAt);
                } else {
                    downloadedAt.textContent = 'Not yet';
                }
                downloadedBy.textContent = file.downloaded_by_ip || '—';
                row.dataset.downloadedAt = file.downloaded_at_iso || '';
                statusBadge.textContent = file.status_display || '';
                statusBadge.dataset.status = file.status_key;
                copyButton.hidden = file.status_key !== 'active';
                row.dataset.searchText = rowSearchText(row.dataset.searchBase, file);
                updated = true;
            });
            if (updated) {
                render();
                rememberPage();
            }
        } catch {
            return;
        }
    };

    searchInput.addEventListener('input', () => {
        currentPage = 1;
        render();
        rememberPage();
    });

    sortInput.addEventListener('change', () => {
        currentPage = 1;
        render();
    });

    prevButton.addEventListener('click', () => {
        if (currentPage > 1) {
            currentPage -= 1;
            const page = render();
            rememberPage();
            refreshStatuses(page.visibleRows);
        }
    });

    nextButton.addEventListener('click', () => {
        const page = render();
        if (currentPage < page.totalPages) {
            currentPage += 1;
            const nextPage = render();
            rememberPage();
            refreshStatuses(nextPage.visibleRows);
        }
    });

    render();
}
