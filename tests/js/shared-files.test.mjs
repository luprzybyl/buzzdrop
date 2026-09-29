import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSharedFilesUrl, getSharedFilesPage } from '../../static/js/shared-files.mjs';

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
