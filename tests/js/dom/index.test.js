import { afterEach, describe, expect, it, vi } from 'vitest';
import { initIndex } from '../../../static/js/index-page.js';
import { required } from '../../../static/js/required.js';
import { browserView, loadFixture } from '../support/dom-fixture.js';

// The index--files fixture's rows, by data-file-id. Sorted newest-download
// first (the default), they run photo, report, note, old.
const REPORT = '00000000-0000-4000-8000-000000000001';
const NOTE = '00000000-0000-4000-8000-000000000002';
const PHOTO = '00000000-0000-4000-8000-000000000003';
const OLD = '00000000-0000-4000-8000-000000000004';

// Six EFF words score ~77.5 bits (strong); seven score ~90.5, past the 90 bits
// that fill the meter.
const SIX_WORDS = 'abacus-abdomen-abdominal-abide-abiding-ability';
const SEVEN_WORDS = `${SIX_WORDS}-ablaze`;

/**
 * @typedef {object} StartOptions
 * @property {'index--files' | 'index--empty' | 'index--anonymous'} [fixture]
 * @property {string} [url]
 * @property {number} [pageSize] - overrides the list's data-page-size, so four rows can paginate
 * @property {object[]} [statuses] - what the shared-files status endpoint answers with
 */

describe('index page', () => {
    /** @type {import('happy-dom').Window | undefined} */
    let page;

    afterEach(async () => {
        vi.useRealTimers();
        await page?.happyDOM.close();
        page = undefined;
    });

    // Uploads belong to the JS-integration layer, so the crypto and XHR here
    // are never reached; the network is the shared-files status endpoint only.
    /** @param {StartOptions} [options] */
    const start = ({ fixture = 'index--files', url = 'http://localhost/', pageSize, statuses = [] } = {}) => {
        page = loadFixture(fixture, {}, url);
        const window = browserView(page);
        const { document } = window;
        if (pageSize) {
            required(document, '#shared-files-list', 'div').dataset.pageSize = String(pageSize);
        }
        const fetch = /** @type {import('vitest').Mock<typeof globalThis.fetch>} */ (vi.fn(async (input) => {
            if (String(input).startsWith('/api/user/files/status?')) {
                return new window.Response(JSON.stringify({ files: statuses }));
            }
            throw new Error(`unexpected request to ${input}`);
        }));
        const unreachable = async () => {
            throw new Error('uploads are tested in the JS-integration layer');
        };
        initIndex(document, {
            fetch,
            XMLHttpRequest: window.XMLHttpRequest,
            navigate: vi.fn(),
            alert: vi.fn(),
            crypto: { encrypt: unreachable, receiptHash: unreachable },
        });

        /** @param {string} id */
        const row = (id) => required(document, `[data-file-id="${id}"]`, 'article');
        return {
            window,
            document,
            fetch,
            row,
            // The ids of the rows on screen, in order.
            visibleRows: () => Array.from(document.querySelectorAll('.shared-file-row'))
                .filter((r) => /** @type {HTMLElement} */ (r).style.display !== 'none')
                .map((r) => /** @type {HTMLElement} */ (r).dataset.fileId),
        };
    };

    describe('share mode tabs', () => {
        it('clicking the Note tab shows its panel and moves the ARIA state', () => {
            const { document } = start();
            const fileTab = required(document, '#file-tab', 'button');
            const textTab = required(document, '#text-tab', 'button');

            textTab.click();

            expect(required(document, '#text-note-section', 'div').style.display).toBe('block');
            expect(required(document, '#file-upload-section', 'div').style.display).toBe('none');
            expect(textTab.getAttribute('aria-selected')).toBe('true');
            expect(textTab.tabIndex).toBe(0);
            expect(fileTab.getAttribute('aria-selected')).toBe('false');
            expect(fileTab.tabIndex).toBe(-1);
            expect(required(document, '#share-action-label', 'span').textContent).toBe('Share note');
            expect(required(document, '#share-action-btn', 'button').getAttribute('aria-label')).toBe('Share note');
        });

        it('arrow keys move between tabs and wrap; Home and End jump to the ends', () => {
            const { window, document } = start();
            const fileTab = required(document, '#file-tab', 'button');
            const textTab = required(document, '#text-tab', 'button');
            /** @param {string} key */
            const press = (key) => {
                const event = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
                /** @type {HTMLElement} */ (document.activeElement ?? fileTab).dispatchEvent(event);
                return event;
            };
            fileTab.focus();

            expect(press('ArrowRight').defaultPrevented).toBe(true);
            expect(document.activeElement).toBe(textTab);
            expect(textTab.getAttribute('aria-selected')).toBe('true');

            press('ArrowRight');
            expect(document.activeElement).toBe(fileTab);

            press('ArrowLeft');
            expect(document.activeElement).toBe(textTab);

            press('Home');
            expect(document.activeElement).toBe(fileTab);

            press('End');
            expect(document.activeElement).toBe(textTab);

            expect(press('a').defaultPrevented).toBe(false);
        });
    });

    describe('password strength meter', () => {
        /** @param {Document} document @param {string} value */
        const typePassword = (document, value) => {
            const input = required(document, '#shared-password', 'input');
            input.value = value;
            input.dispatchEvent(new (/** @type {Window & typeof globalThis} */ (document.defaultView)).Event('input'));
        };

        it.each([
            ['weak', 'password', '11%'],
            ['fair', 'correct horse', '68%'],
            ['strong', SIX_WORDS, '86%'],
        ])('shows a %s password', (level, password, width) => {
            const { document } = start();

            typePassword(document, password);

            expect(required(document, '#password-strength', 'div').classList.contains('hidden')).toBe(false);
            const bar = required(document, '#password-strength-bar', 'div');
            expect(bar.className).toBe(`pw-fill pw-fill-${level}`);
            expect(bar.style.width).toBe(width);
            expect(required(document, '#password-strength-text', 'p').className).toBe(`field-help pw-text-${level}`);
        });

        it('hides the meter once the field is emptied', () => {
            const { document } = start();

            typePassword(document, 'correct horse');
            typePassword(document, '');

            expect(required(document, '#password-strength', 'div').classList.contains('hidden')).toBe(true);
        });

        it('caps the bar at 100% past 90 bits', () => {
            const { document } = start();

            typePassword(document, SEVEN_WORDS);

            expect(required(document, '#password-strength-bar', 'div').style.width).toBe('100%');
        });

        it('Generate fills a visible six-word passphrase rated strong', () => {
            const { document } = start();
            const input = required(document, '#shared-password', 'input');

            required(document, '#generate-password-btn', 'button').click();

            expect(input.value.split('-').length).toBeGreaterThanOrEqual(6);
            expect(input.type).toBe('text');
            expect(document.activeElement).toBe(input);
            expect(required(document, '#password-strength-bar', 'div').className).toBe('pw-fill pw-fill-strong');
        });
    });

    describe('file selection', () => {
        /** @param {Window & typeof globalThis} window @param {string} name */
        const filesNamed = (window, name) => {
            const transfer = new window.DataTransfer();
            transfer.items.add(new window.File(['x'], name));
            return transfer.files;
        };
        /** @param {Window & typeof globalThis} window @param {string} name */
        const choose = (window, name) => {
            const input = required(window.document, '#file', 'input');
            input.files = filesNamed(window, name);
            input.dispatchEvent(new window.Event('change'));
        };

        it('a disallowed extension shows the error and no chip', () => {
            const { window, document } = start();

            choose(window, 'setup.exe');

            expect(required(document, '#file-error', 'p').textContent).toBe('That file type is not allowed.');
            expect(required(document, '#file-selected', 'p').classList.contains('hidden')).toBe(true);
            expect(required(document, '#file', 'input').value).toBe('');
        });

        it('an allowed file shows its chip and clears an earlier error', () => {
            const { window, document } = start();

            choose(window, 'setup.exe');
            choose(window, 'report.pdf');

            expect(required(document, '#file-selected', 'p').classList.contains('hidden')).toBe(false);
            expect(required(document, '#file-selected-name', 'span').textContent).toBe('report.pdf');
            expect(required(document, '#file-error', 'p').textContent).toBe('');
        });

        it('a dropped file is handed to the file input and shown', () => {
            const { window, document } = start();
            const dropzone = required(document, '#dropzone', 'label');
            const transfer = new window.DataTransfer();
            transfer.items.add(new window.File(['x'], 'photo.png'));

            // happy-dom's DragEvent ignores a dataTransfer passed to its constructor.
            const drop = new window.DragEvent('drop', { bubbles: true, cancelable: true });
            Object.defineProperty(drop, 'dataTransfer', { value: transfer });
            dropzone.dispatchEvent(drop);

            expect(required(document, '#file', 'input').files?.[0]?.name).toBe('photo.png');
            expect(required(document, '#file-selected-name', 'span').textContent).toBe('photo.png');
        });
    });

    describe('copying a share link', () => {
        it('copies the link and announces it', async () => {
            const { window, document, row } = start();
            const link = required(row(REPORT), '.copy-url', 'a');
            const flash = required(link, '.copy-flash', 'span');
            vi.useFakeTimers();

            link.click();

            await vi.waitFor(() => expect(required(document, '#copy-status', 'p').textContent)
                .toBe('Share link copied to clipboard.'));
            expect(await window.navigator.clipboard.readText()).toBe(`http://localhost/view/${REPORT}`);
            expect(flash.textContent).toBe('Copied');
            expect(flash.classList.contains('hidden')).toBe(false);

            vi.advanceTimersByTime(1800);

            expect(flash.classList.contains('hidden')).toBe(true);
            expect(required(document, '#copy-status', 'p').textContent).toBe('');
        });

        it('says so when the browser blocks the clipboard', async () => {
            const { window, document, row } = start();
            vi.spyOn(window.navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
            const link = required(row(REPORT), '.copy-url', 'a');
            const flash = required(link, '.copy-flash', 'span');

            link.click();

            await vi.waitFor(() => expect(required(document, '#copy-status', 'p').textContent)
                .toBe('Your browser blocked clipboard access, so the link was not copied.'));
            expect(flash.textContent).toBe('Copy failed');
            expect(flash.classList.contains('copy-flash-error')).toBe(true);
        });
    });

    describe('delete confirmation', () => {
        /** @param {Window & typeof globalThis} window @param {HTMLFormElement} form */
        const submit = (window, form) => {
            /** @type {boolean | undefined} */
            let prevented;
            // Runs after the page's listener; stops the navigation itself.
            form.addEventListener('submit', (event) => {
                prevented = event.defaultPrevented;
                event.preventDefault();
            }, { once: true });
            form.requestSubmit();
            return prevented;
        };

        it('cancelling the confirmation stops the delete', () => {
            const { window, row } = start();
            const confirm = vi.fn(() => false);
            window.confirm = confirm;

            expect(submit(window, required(row(REPORT), 'form[data-confirm-message]', 'form'))).toBe(true);
            expect(confirm).toHaveBeenCalledWith('Delete this file?');
        });

        it('accepting the confirmation lets the delete through', () => {
            const { window, row } = start();
            window.confirm = vi.fn(() => true);

            expect(submit(window, required(row(REPORT), 'form[data-confirm-message]', 'form'))).toBe(false);
        });
    });

    describe('shared files list', () => {
        it('search filters the rows and is kept in the URL', () => {
            const { window, document, visibleRows } = start();
            const search = required(document, '#shared-files-search', 'input');

            search.value = 'photo';
            search.dispatchEvent(new window.Event('input'));

            expect(visibleRows()).toEqual([PHOTO]);
            expect(required(document, '#shared-files-summary', 'div').textContent).toBe('Showing 1-1 of 1 drops');
            expect(new window.URL(window.location.href).searchParams.get('shared_search')).toBe('photo');
        });

        it('a search with no match shows the empty state', () => {
            const { window, document, visibleRows } = start();
            const search = required(document, '#shared-files-search', 'input');

            search.value = 'nothing like this';
            search.dispatchEvent(new window.Event('input'));

            expect(visibleRows()).toEqual([]);
            expect(required(document, '#shared-files-empty-state', 'p').style.display).toBe('block');
            expect(required(document, '#shared-files-page', 'span').textContent).toBe('Page 0 of 0');
            expect(required(document, '#shared-files-summary', 'div').textContent).toBe('No matching drops');
            expect(required(document, '#shared-files-prev', 'button').disabled).toBe(true);
            expect(required(document, '#shared-files-next', 'button').disabled).toBe(true);
        });

        it('sorting reorders the rows', () => {
            const { window, document, visibleRows } = start();
            const sort = required(document, '#shared-files-sort', 'select');

            expect(visibleRows()).toEqual([PHOTO, REPORT, NOTE, OLD]);

            sort.value = 'expiry:asc';
            sort.dispatchEvent(new window.Event('change'));

            expect(visibleRows()).toEqual([OLD, REPORT, NOTE, PHOTO]);
        });

        it('pages through the rows and keeps the page in the URL', () => {
            const { window, document, visibleRows } = start({ pageSize: 2 });
            const prev = required(document, '#shared-files-prev', 'button');
            const next = required(document, '#shared-files-next', 'button');
            const pageLabel = required(document, '#shared-files-page', 'span');

            expect(visibleRows()).toEqual([PHOTO, REPORT]);
            expect(pageLabel.textContent).toBe('Page 1 of 2');
            expect(prev.disabled).toBe(true);

            next.click();

            expect(visibleRows()).toEqual([NOTE, OLD]);
            expect(pageLabel.textContent).toBe('Page 2 of 2');
            expect(required(document, '#shared-files-summary', 'div').textContent).toBe('Showing 3-4 of 4 drops');
            expect(next.disabled).toBe(true);
            expect(new window.URL(window.location.href).searchParams.get('shared_page')).toBe('2');

            prev.click();

            expect(visibleRows()).toEqual([PHOTO, REPORT]);
            expect(new window.URL(window.location.href).searchParams.has('shared_page')).toBe(false);
        });

        it('starts from the search and page in the URL', () => {
            const { document, visibleRows } = start({
                url: 'http://localhost/?shared_search=cet&shared_page=2',
                pageSize: 2,
            });

            expect(required(document, '#shared-files-search', 'input').value).toBe('cet');
            expect(required(document, '#shared-files-page', 'span').textContent).toBe('Page 2 of 2');
            expect(visibleRows()).toHaveLength(2);
        });

        it('a page change refreshes its rows\' status and re-renders', async () => {
            const { document, fetch, row, visibleRows } = start({
                pageSize: 2,
                statuses: [{
                    id: NOTE,
                    status: 'active',
                    status_display: 'Downloaded',
                    downloaded_at: '2025-03-01 10:00:00 CET',
                    downloaded_by_ip: '198.51.100.9',
                }],
            });

            required(document, '#shared-files-next', 'button').click();

            await vi.waitFor(() => expect(required(row(NOTE), '[data-file-status]', 'span').textContent)
                .toBe('Downloaded'));
            expect(String(fetch.mock.calls[0][0])).toBe(`/api/user/files/status?id=${NOTE}&id=${OLD}`);
            expect(required(row(NOTE), '[data-file-downloaded-at]', 'dd').textContent).toBe('2025-03-01 10:00:00 CET');
            expect(required(row(NOTE), '[data-file-downloaded-by]', 'dd').textContent).toBe('198.51.100.9');
            expect(required(row(NOTE), '[data-file-status]', 'span').classList.contains('status-badge-green')).toBe(true);
            // Now the newest download, the note sorts onto page 1.
            expect(visibleRows()).toEqual([REPORT, OLD]);
        });
    });

    it('scrubs a stray fragment from the URL without adding a history entry', () => {
        const { window } = start({ fixture: 'index--anonymous', url: 'http://localhost/?x=1#leaked%20password' });

        expect(window.location.href).toBe('http://localhost/?x=1');
        expect(window.history.length).toBe(1);
    });
});
