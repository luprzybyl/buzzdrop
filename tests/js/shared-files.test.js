import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSharedFilesUrl, getSharedFilesPage, rowSearchText, statusBadgeClass } from '../../static/js/shared-files.js';

const rows = Array.from({ length: 12 }, (_, index) => ({
    dataset: { searchText: `file-${index}.txt` },
}));

test('selects the requested page of filtered rows', () => {
    const page = getSharedFilesPage(rows, 'file-', 5, 2);

    assert.equal(page.currentPage, 2);
    assert.equal(page.totalPages, 3);
    assert.deepEqual(page.visibleRows, rows.slice(5, 10));
});

test('preserves other URL parameters while changing search and page state', () => {
    const url = buildSharedFilesUrl(
        'https://example.test/?tab=files&shared_page=3',
        2,
        ' report ',
    );

    assert.equal(url.searchParams.get('tab'), 'files');
    assert.equal(url.searchParams.get('shared_page'), '2');
    assert.equal(url.searchParams.get('shared_search'), 'report');
});

test('gives a downloaded file the green badge, even once expired', () => {
    assert.equal(statusBadgeClass({ downloaded_at: '2025-01-01 10:00', status: 'active' }), 'status-badge-green');
    assert.equal(statusBadgeClass({ downloaded_at: '2025-01-01 10:00', status: 'expired' }), 'status-badge-green');
});

test('gives an expired, undownloaded file the red badge', () => {
    assert.equal(statusBadgeClass({ downloaded_at: null, status: 'expired' }), 'status-badge-red');
});

test('gives an active, undownloaded file the amber badge', () => {
    assert.equal(statusBadgeClass({ downloaded_at: null, status: 'active' }), 'status-badge-amber');
});

test('builds lowercase row search text from the base and the file status', () => {
    assert.equal(
        rowSearchText('report.pdf 2025-01-01', {
            status: 'active',
            status_display: 'Downloaded',
            downloaded_by_ip: '10.0.0.1',
        }),
        'report.pdf 2025-01-01 active downloaded 10.0.0.1',
    );
});

test('leaves a null IP and a missing status display out of the search text', () => {
    const text = rowSearchText('report.pdf', { status: 'Active', downloaded_by_ip: null });

    assert.match(text, /^report\.pdf active\b/);
    assert.doesNotMatch(text, /null|undefined/);
});
