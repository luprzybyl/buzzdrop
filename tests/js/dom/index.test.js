import { within } from '@testing-library/dom';
import { describe, expect, it, vi } from 'vitest';
import { openLandingPage, openUploadPage, screen } from '../support/pages/upload.js';

// Six EFF words score ~77.5 bits (strong); seven score ~90.5, past the 90 bits
// that fill the meter.
const SIX_WORDS = 'abacus-abdomen-abdominal-abide-abiding-ability';
const SEVEN_WORDS = `${SIX_WORDS}-ablaze`;

const passwordField = () => screen.getByLabelText('Password');
const fileField = () => screen.getByLabelText('Drop a file here, or browse');
const strengthMeter = () => screen.getByRole('meter', { name: 'Password strength' });
const clipboardStatus = () => screen.getByRole('status', { name: 'Clipboard' });
/** @param {string} name */
const shareRow = (name) => within(screen.getByRole('article', { name }));

describe('index page', () => {
    describe('share mode tabs', () => {
        it('clicking the Note tab shows its panel and moves the ARIA state', async () => {
            const upload = openUploadPage();

            await upload.switchToNote();

            expect(screen.getByRole('tabpanel')).toHaveAccessibleName('Text note');
            expect(screen.getByLabelText('Secret text')).toBeVisible();
            const noteTab = screen.getByRole('tab', { name: 'Text note' });
            const fileTab = screen.getByRole('tab', { name: 'File' });
            expect(noteTab).toHaveAttribute('aria-selected', 'true');
            expect(noteTab).toHaveAttribute('tabindex', '0');
            expect(fileTab).toHaveAttribute('aria-selected', 'false');
            expect(fileTab).toHaveAttribute('tabindex', '-1');
            expect(screen.getByRole('button', { name: 'Share note' })).toHaveTextContent('Share note');
        });

        it('arrow keys move between tabs and wrap; Home and End jump to the ends', async () => {
            const upload = openUploadPage();
            const fileTab = screen.getByRole('tab', { name: 'File' });
            const noteTab = screen.getByRole('tab', { name: 'Text note' });
            await upload.switchToFile();

            expect(await upload.press('ArrowRight')).toBe('handled');
            expect(noteTab).toHaveFocus();
            expect(noteTab).toHaveAttribute('aria-selected', 'true');

            await upload.press('ArrowRight');
            expect(fileTab).toHaveFocus();

            await upload.press('ArrowLeft');
            expect(noteTab).toHaveFocus();

            await upload.press('Home');
            expect(fileTab).toHaveFocus();

            await upload.press('End');
            expect(noteTab).toHaveFocus();

            expect(await upload.press('a')).toBe('ignored');
        });
    });

    describe('password strength meter', () => {
        it.each([
            ['Weak', 'password', '11'],
            ['Fair', 'correct horse', '68'],
            ['Strong', SIX_WORDS, '86'],
        ])('rates a password %s', async (level, password, fill) => {
            const upload = openUploadPage();

            await upload.enterPassword(password);

            expect(strengthMeter()).toHaveAttribute('aria-valuetext', level);
            expect(strengthMeter()).toHaveAttribute('aria-valuenow', fill);
            expect(upload.strengthBarFill()).toBe(`${fill}%`);
        });

        it('hides the meter once the field is emptied', async () => {
            const upload = openUploadPage();

            await upload.enterPassword('correct horse');
            await upload.clearPassword();

            expect(screen.queryByRole('meter', { name: 'Password strength' })).toBeNull();
        });

        it('caps the meter at full past 90 bits', async () => {
            const upload = openUploadPage();

            await upload.enterPassword(SEVEN_WORDS);

            expect(strengthMeter()).toHaveAttribute('aria-valuenow', '100');
            expect(upload.strengthBarFill()).toBe('100%');
        });

        it('Generate fills a visible passphrase rated strong', async () => {
            const upload = openUploadPage();

            await upload.generatePassword();

            expect(passwordField()).not.toHaveValue('');
            expect(passwordField()).toHaveAttribute('type', 'text');
            expect(passwordField()).toHaveFocus();
            expect(strengthMeter()).toHaveAttribute('aria-valuetext', 'Strong');
        });
    });

    describe('file selection', () => {
        it('a disallowed extension shows the error and no chip', async () => {
            const upload = openUploadPage({ account: 'no-shares' });

            await upload.selectFile('setup.exe');

            expect(fileField()).toHaveAccessibleDescription('That file type is not allowed.');
            expect(screen.queryByText('setup.exe')).toBeNull();
            expect(upload.filesChosen()).toEqual([]);
        });

        it('an allowed file shows its chip and clears an earlier error', async () => {
            const upload = openUploadPage({ account: 'no-shares' });

            await upload.selectFile('setup.exe');
            await upload.selectFile('report.pdf');

            expect(screen.getByText('report.pdf')).toBeVisible();
            expect(fileField()).not.toHaveAccessibleDescription();
        });

        it('a dropped file is handed to the file input and shown', async () => {
            const upload = openUploadPage({ account: 'no-shares' });

            upload.dropFile('photo.png');

            expect(upload.filesChosen()).toEqual(['photo.png']);
            expect(screen.getByText('photo.png')).toBeVisible();
        });
    });

    describe('copying a share link', () => {
        it('copies the link and announces it', async () => {
            const upload = openUploadPage();
            vi.useFakeTimers();

            await upload.copyShareLink('report.pdf');

            await vi.waitFor(() => expect(clipboardStatus()).toHaveTextContent('Share link copied to clipboard.'));
            expect(await upload.clipboardText()).toBe('http://localhost/view/00000000-0000-4000-8000-000000000001');
            expect(shareRow('report.pdf').getByText('Copied')).toBeVisible();

            vi.advanceTimersByTime(1800);

            expect(shareRow('report.pdf').getByText('Copied')).not.toBeVisible();
            expect(clipboardStatus()).toBeEmptyDOMElement();
        });

        it('says so when the browser blocks the clipboard', async () => {
            const upload = openUploadPage({ clipboard: 'blocked' });

            await upload.copyShareLink('report.pdf');

            await vi.waitFor(() => expect(clipboardStatus())
                .toHaveTextContent('Your browser blocked clipboard access, so the link was not copied.'));
            expect(shareRow('report.pdf').getByText('Copy failed')).toBeVisible();
        });
    });

    describe('delete confirmation', () => {
        it('cancelling the confirmation stops the delete', async () => {
            const upload = openUploadPage();

            expect(await upload.deleteShare('report.pdf', { confirm: false }))
                .toEqual({ asked: ['Delete this file?'], deleted: false });
        });

        it('accepting the confirmation lets the delete through', async () => {
            const upload = openUploadPage();

            expect(await upload.deleteShare('report.pdf', { confirm: true }))
                .toEqual({ asked: ['Delete this file?'], deleted: true });
        });
    });

    describe('shared files list', () => {
        it('search filters the rows and is kept in the URL', async () => {
            const upload = openUploadPage();

            await upload.searchShares('photo');

            expect(upload.sharesShown()).toEqual(['photo.png']);
            expect(screen.getByText('Showing 1-1 of 1 drops')).toBeVisible();
            expect(new URL(upload.url()).searchParams.get('shared_search')).toBe('photo');
        });

        it('a search with no match shows the empty state', async () => {
            const upload = openUploadPage();

            await upload.searchShares('nothing like this');

            expect(upload.sharesShown()).toEqual([]);
            expect(screen.getByText('No drops match this search.')).toBeVisible();
            expect(screen.getByText('Page 0 of 0')).toBeVisible();
            expect(screen.getByText('No matching drops')).toBeVisible();
            expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
            expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
        });

        it('sorting reorders the rows', async () => {
            const upload = openUploadPage();

            expect(upload.sharesShown()).toEqual(['photo.png', 'report.pdf', 'Secret Note', 'old.txt']);

            await upload.sortSharesBy('Expiry (soonest)');

            expect(upload.sharesShown()).toEqual(['old.txt', 'report.pdf', 'Secret Note', 'photo.png']);
        });

        it('pages through the rows and keeps the page in the URL', async () => {
            const upload = openUploadPage({ sharesPerPage: 2 });

            expect(upload.sharesShown()).toEqual(['photo.png', 'report.pdf']);
            expect(screen.getByText('Page 1 of 2')).toBeVisible();
            expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();

            await upload.nextSharesPage();

            expect(upload.sharesShown()).toEqual(['Secret Note', 'old.txt']);
            expect(screen.getByText('Page 2 of 2')).toBeVisible();
            expect(screen.getByText('Showing 3-4 of 4 drops')).toBeVisible();
            expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
            expect(new URL(upload.url()).searchParams.get('shared_page')).toBe('2');

            await upload.previousSharesPage();

            expect(upload.sharesShown()).toEqual(['photo.png', 'report.pdf']);
            expect(new URL(upload.url()).searchParams.has('shared_page')).toBe(false);
        });

        it('starts from the search and page in the URL', () => {
            const upload = openUploadPage({ path: '/?shared_search=cet&shared_page=2', sharesPerPage: 2 });

            expect(screen.getByRole('searchbox', { name: 'Quick search' })).toHaveValue('cet');
            expect(screen.getByText('Page 2 of 2')).toBeVisible();
            expect(upload.sharesShown()).toHaveLength(2);
        });

        it('a page change refreshes its rows\' status and re-renders', async () => {
            const upload = openUploadPage({
                sharesPerPage: 2,
                openedMeanwhile: [{ name: 'Secret Note', openedAt: '2025-03-01 10:00:00 CET', openedFrom: '198.51.100.9' }],
            });

            await upload.nextSharesPage();

            // Now the newest download, the note sorts onto page 1.
            await vi.waitFor(() => expect(upload.sharesShown()).toEqual(['report.pdf', 'old.txt']));
            expect(upload.statusChecks()).toEqual([['Secret Note', 'old.txt']]);

            await upload.previousSharesPage();

            expect(upload.sharesShown()).toEqual(['Secret Note', 'photo.png']);
            expect(shareRow('Secret Note').getByText('Downloaded')).toBeVisible();
            expect(shareRow('Secret Note').getByText('2025-03-01 10:00:00 CET')).toBeVisible();
            expect(shareRow('Secret Note').getByText('198.51.100.9')).toBeVisible();
        });
    });

    it('scrubs a stray fragment from the URL without adding a history entry', () => {
        const landing = openLandingPage({ path: '/?x=1#leaked%20password' });

        expect(landing.url()).toBe('http://localhost/?x=1');
        expect(landing.historyLength()).toBe(1);
    });
});
