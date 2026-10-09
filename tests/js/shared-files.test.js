import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSharedFilesUrl, getSharedFilesPage, relativeTime, rowSearchText } from '../../static/js/features/shared-files/shared-files.js';

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

const NOW = Date.parse('2026-10-06T21:37:00+02:00');
/** @param {string} iso */
const ago = (iso) => relativeTime(Date.parse(iso), NOW);

test('calls the last minute "just now", and the next "in under a minute"', () => {
    assert.equal(ago('2026-10-06T21:36:30+02:00'), 'just now');
    assert.equal(ago('2026-10-06T21:37:20+02:00'), 'in under a minute');
});

test('rounds to the nearest unit, so a time just short of one reads as it', () => {
    // An expiry set three days out, looked at a few minutes later.
    assert.equal(ago('2026-10-09T21:30:00+02:00'), 'in 3 days');
    assert.equal(ago('2026-10-06T19:40:00+02:00'), '2 h ago');
    assert.equal(ago('2026-10-05T21:57:00+02:00'), 'yesterday');
    assert.equal(ago('2026-08-08T21:37:00+02:00'), '2 months ago');
});

test('counts minutes and hours, in the past and the future', () => {
    assert.equal(ago('2026-10-06T21:35:00+02:00'), '2 min ago');
    assert.equal(ago('2026-10-06T21:42:00+02:00'), 'in 5 min');
    assert.equal(ago('2026-10-06T18:30:00+02:00'), '3 h ago');
    assert.equal(ago('2026-10-07T01:37:00+02:00'), 'in 4 h');
});

test('says "yesterday" and "tomorrow" a day away', () => {
    assert.equal(ago('2026-10-05T20:00:00+02:00'), 'yesterday');
    assert.equal(ago('2026-10-07T23:00:00+02:00'), 'tomorrow');
});

test('counts days, months and years further out', () => {
    assert.equal(ago('2026-10-01T21:37:00+02:00'), '5 days ago');
    assert.equal(ago('2026-12-06T21:37:00+01:00'), 'in 2 months');
    assert.equal(ago('2025-10-01T12:00:00+02:00'), '1 year ago');
    assert.equal(ago('2099-01-01T00:00:00+01:00'), 'in 72 years');
});

test('has no relative time for an unreadable timestamp', () => {
    assert.equal(relativeTime(Number.NaN, NOW), null);
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
