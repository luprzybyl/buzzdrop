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
const passwordCopyStatus = () => screen.getByRole('status', { name: 'Password clipboard' });
/** @param {string} name */
const shareRow = (name) => within(screen.getByRole('article', { name }));
/** @param {string} name */
const copyLinkButton = (name) => shareRow(name).getByRole('button', { name: `Copy link for ${name}` });
/** @param {string} name */
const queryCopyLinkButton = (name) => shareRow(name).queryByRole('button', { name: `Copy link for ${name}` });

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

    describe('password field controls', () => {
        it('Copy puts the generated passphrase on the clipboard and flashes "Copied!"', async () => {
            const upload = openUploadPage();
            vi.useFakeTimers({ shouldAdvanceTime: true });

            await upload.generatePassword();
            await upload.copyPassword();

            // The button keeps its name, so the flash on it is visual; the
            // status region announces the copy.
            const copy = screen.getByRole('button', { name: 'Copy password' });
            await vi.waitFor(() => expect(copy).toHaveTextContent('Copied!'));
            expect(passwordCopyStatus()).toHaveTextContent('Password copied to clipboard.');
            expect(passwordField()).toHaveValue(await upload.clipboardText());

            vi.advanceTimersByTime(2000);

            expect(copy).toHaveTextContent('Copy');
            expect(passwordCopyStatus()).toBeEmptyDOMElement();
        });

        it('flashes "Failed" when the browser blocks the clipboard', async () => {
            const upload = openUploadPage({ clipboard: 'blocked' });
            vi.useFakeTimers({ shouldAdvanceTime: true });

            await upload.enterPassword(SIX_WORDS);
            await upload.copyPassword();

            const copy = screen.getByRole('button', { name: 'Copy password' });
            await vi.waitFor(() => expect(copy).toHaveTextContent('Failed'));
            expect(passwordCopyStatus())
                .toHaveTextContent('Your browser blocked clipboard access, so the password was not copied.');

            vi.advanceTimersByTime(4000);

            expect(copy).toHaveTextContent('Copy');
        });

        it('flashes "Failed" when the browser has no clipboard at all', async () => {
            const upload = openUploadPage({ clipboard: 'unavailable' });

            await upload.enterPassword(SIX_WORDS);
            await upload.copyPassword();

            await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Copy password' })).toHaveTextContent('Failed'));
            expect(passwordCopyStatus())
                .toHaveTextContent('Your browser blocked clipboard access, so the password was not copied.');
        });

        it('Copy is unavailable while the field is empty', async () => {
            const upload = openUploadPage();

            expect(screen.getByRole('button', { name: 'Copy password' })).toBeDisabled();

            await upload.enterPassword('correct horse');
            expect(screen.getByRole('button', { name: 'Copy password' })).toBeEnabled();

            await upload.clearPassword();
            expect(screen.getByRole('button', { name: 'Copy password' })).toBeDisabled();
        });

        it('Show is unavailable while the field is empty', async () => {
            const upload = openUploadPage();

            expect(screen.getByRole('button', { name: 'Show password' })).toBeDisabled();

            await upload.enterPassword('correct horse');
            expect(screen.getByRole('button', { name: 'Show password' })).toBeEnabled();

            await upload.clearPassword();
            expect(screen.getByRole('button', { name: 'Show password' })).toBeDisabled();
        });

        it('Show reveals a typed password and Hide masks it again', async () => {
            const upload = openUploadPage();
            await upload.enterPassword('correct horse');
            expect(passwordField()).toHaveAttribute('type', 'password');

            await upload.showPassword();
            expect(passwordField()).toHaveAttribute('type', 'text');
            expect(screen.getByRole('button', { name: 'Hide password' })).toBeVisible();

            await upload.hidePassword();
            expect(passwordField()).toHaveAttribute('type', 'password');
            expect(screen.getByRole('button', { name: 'Show password' })).toBeVisible();
        });

        it('a generated passphrase is shown, so the toggle offers Hide', async () => {
            const upload = openUploadPage();

            await upload.generatePassword();

            expect(screen.getByRole('button', { name: 'Hide password' })).toBeVisible();
        });
    });

    describe('missing input', () => {
        it('an empty note is refused inline, not with a dialog', async () => {
            const upload = openUploadPage({ account: 'no-shares' });

            await upload.shareMessage('');

            expect(screen.getByLabelText('Secret text')).toHaveAccessibleDescription('Write the note you want to share.');
            expect(upload.alerts()).toEqual([]);
            expect(upload.requestsSent()).toEqual([]);
        });

        it('writing the note clears the refusal', async () => {
            const upload = openUploadPage({ account: 'no-shares' });
            await upload.shareMessage('');

            await upload.writeMessage('the gate code');

            expect(screen.getByLabelText('Secret text')).not.toHaveAccessibleDescription();
        });

        it('a missing password is refused inline', async () => {
            const upload = openUploadPage({ account: 'no-shares' });

            await upload.shareMessage('the gate code', '');

            expect(passwordField()).toHaveAccessibleDescription('Enter a password, or press Generate.');
            expect(passwordField()).toHaveFocus();
            expect(upload.alerts()).toEqual([]);
            expect(upload.requestsSent()).toEqual([]);
        });

        it('sharing with no file chosen is refused inline', async () => {
            const upload = openUploadPage({ account: 'no-shares' });
            await upload.enterPassword(SIX_WORDS);

            await upload.share();

            expect(fileField()).toHaveAccessibleDescription('Choose a file to share.');
            expect(upload.requestsSent()).toEqual([]);
        });
    });

    describe('open notifications', () => {
        it('an account without an email cannot ask for them and is told why', () => {
            openUploadPage({ account: 'no-shares' });

            const checkbox = screen.getByRole('checkbox', { name: /^Notify me when this is opened/ });
            expect(checkbox).toBeDisabled();
            expect(checkbox).toHaveAccessibleDescription('Notifications need an email on your account — ask your admin.');
            expect(screen.queryByLabelText('Account email')).toBeNull();
            expect(screen.queryByText(/FLASK_USER/)).toBeNull();
        });

        it('an account with an email shows where they go once the box is ticked', async () => {
            const upload = openUploadPage({ account: 'with-email' });

            expect(screen.getByRole('checkbox', { name: /^Notify me when this is opened/ })).toBeEnabled();
            expect(screen.getByLabelText('Account email')).not.toBeVisible();

            await upload.setShareOptions({ notify: true });

            expect(screen.getByLabelText('Account email')).toBeVisible();
            expect(screen.getByLabelText('Account email')).toHaveValue('notify@example.test');
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
            expect(shareRow('report.pdf').getByText('Copied!')).toBeVisible();

            vi.advanceTimersByTime(1800);

            expect(shareRow('report.pdf').queryByText('Copied!')).toBeNull();
            expect(shareRow('report.pdf').getByText('Copy link')).toBeVisible();
            expect(clipboardStatus()).toBeEmptyDOMElement();
        });

        it('says so when the browser blocks the clipboard', async () => {
            const upload = openUploadPage({ clipboard: 'blocked' });

            await upload.copyShareLink('report.pdf');

            await vi.waitFor(() => expect(clipboardStatus())
                .toHaveTextContent('Your browser blocked clipboard access, so the link was not copied.'));
            expect(shareRow('report.pdf').getByText('Failed')).toBeVisible();
        });

        it('offers the link only while the drop can still be opened', () => {
            openUploadPage({ sharesPerPage: 10 });

            expect(copyLinkButton('report.pdf')).toBeVisible();
            expect(copyLinkButton('Text note · 21:35')).toBeVisible();
            expect(queryCopyLinkButton('photo.png')).toBeNull();
            expect(queryCopyLinkButton('old.txt')).toBeNull();
            expect(queryCopyLinkButton('locked.zip')).toBeNull();
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
        it('names each status for what happened to the drop', () => {
            openUploadPage({ sharesPerPage: 10 });

            expect(shareRow('report.pdf').getByText('Active')).toBeVisible();
            expect(shareRow('photo.png').getByText('Decrypted')).toBeVisible();
            expect(shareRow('old.txt').getByText('Expired')).toBeVisible();
            expect(shareRow('locked.zip').getByText('Locked out')).toBeVisible();
        });

        it('titles a text note by its private note, or else by its time', () => {
            const upload = openUploadPage({ sharesPerPage: 10 });

            expect(upload.sharesShown()).toContain('For the auditor');
            expect(upload.sharesShown()).toContain('Text note · 21:35');
            // The note is the title, so it isn't repeated under it.
            expect(shareRow('For the auditor').getAllByText('For the auditor')).toHaveLength(1);
        });

        it('says plainly when there is no expiry, opening or address yet', () => {
            openUploadPage();

            expect(shareRow('Text note · 21:35').getByText('No expiry')).toBeVisible();
            expect(shareRow('report.pdf').getByText('Not yet')).toBeVisible();
            expect(shareRow('report.pdf').getByText('—')).toBeVisible();
        });

        it('shows times relative to now, with the full timestamp on hover', () => {
            openUploadPage();

            expect(shareRow('Text note · 21:35').getByText('14 h ago'))
                .toHaveAttribute('title', '2025-01-06 21:35:00 CET');
            expect(shareRow('report.pdf').getByText('2 days ago'))
                .toHaveAttribute('title', '2025-01-05 12:00:00 CET');
            expect(shareRow('report.pdf').getByText('in 74 years'))
                .toHaveAttribute('title', '2099-01-01 00:00:00 CET');
            expect(shareRow('photo.png').getByText('yesterday'))
                .toHaveAttribute('title', '2025-01-06 09:30:00 CET');
        });

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
            expect(screen.getByText('No matching drops')).toBeVisible();
            expect(screen.queryByRole('button', { name: 'Next' })).toBeNull();
        });

        it('lists the newest upload first, and sorting reorders the rows', async () => {
            const upload = openUploadPage({ sharesPerPage: 10 });

            expect(screen.getByRole('combobox', { name: 'Sort by' })).toHaveDisplayValue('Uploaded (newest)');
            expect(upload.sharesShown()).toEqual(
                ['Text note · 21:35', 'report.pdf', 'For the auditor', 'photo.png', 'old.txt', 'locked.zip']);

            await upload.sortSharesBy('Expiry (soonest)');

            expect(upload.sharesShown().slice(0, 2)).toEqual(['old.txt', 'report.pdf']);

            await upload.sortSharesBy('Downloaded (newest)');

            expect(upload.sharesShown()[0]).toBe('photo.png');
        });

        it('hides the page controls when everything fits on one page', async () => {
            const upload = openUploadPage();

            expect(screen.getByText('Page 1 of 2')).toBeVisible();

            await upload.searchShares('photo');

            expect(screen.getByText(/^Page \d/)).not.toBeVisible();
            expect(screen.queryByRole('button', { name: 'Previous' })).toBeNull();
            expect(screen.queryByRole('button', { name: 'Next' })).toBeNull();
        });

        it('pages through the rows and keeps the page in the URL', async () => {
            const upload = openUploadPage({ sharesPerPage: 2 });

            expect(upload.sharesShown()).toEqual(['Text note · 21:35', 'report.pdf']);
            expect(screen.getByText('Page 1 of 3')).toBeVisible();
            expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();

            await upload.nextSharesPage();
            await upload.nextSharesPage();

            expect(upload.sharesShown()).toEqual(['old.txt', 'locked.zip']);
            expect(screen.getByText('Page 3 of 3')).toBeVisible();
            expect(screen.getByText('Showing 5-6 of 6 drops')).toBeVisible();
            expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
            expect(new URL(upload.url()).searchParams.get('shared_page')).toBe('3');

            await upload.previousSharesPage();
            await upload.previousSharesPage();

            expect(upload.sharesShown()).toEqual(['Text note · 21:35', 'report.pdf']);
            expect(new URL(upload.url()).searchParams.has('shared_page')).toBe(false);
        });

        it('starts from the search and page in the URL', () => {
            const upload = openUploadPage({ path: '/?shared_search=cet&shared_page=2', sharesPerPage: 2 });

            expect(screen.getByRole('searchbox', { name: 'Quick search' })).toHaveValue('cet');
            expect(screen.getByText('Page 2 of 3')).toBeVisible();
            expect(upload.sharesShown()).toHaveLength(2);
        });

        it('a page change refreshes its rows\' status and re-renders', async () => {
            const upload = openUploadPage({
                sharesPerPage: 2,
                openedMeanwhile: [{ name: 'For the auditor', openedAt: '2025-01-07T10:00:00+01:00', openedFrom: '198.51.100.9' }],
            });

            await upload.nextSharesPage();

            await vi.waitFor(() => expect(shareRow('For the auditor').getByText('Downloaded')).toBeVisible());
            expect(upload.statusChecks()).toEqual([['For the auditor', 'photo.png']]);
            expect(shareRow('For the auditor').getByText('2 h ago'))
                .toHaveAttribute('title', '2025-01-07 10:00:00 CET');
            expect(shareRow('For the auditor').getByText('198.51.100.9')).toBeVisible();
            expect(queryCopyLinkButton('For the auditor')).toBeNull();

            // The refreshed address is searchable.
            await upload.searchShares('198.51.100.9');

            expect(upload.sharesShown()).toEqual(['For the auditor']);
        });
    });

    it('scrubs a stray fragment from the URL without adding a history entry', () => {
        const landing = openLandingPage({ path: '/?x=1#leaked%20password' });

        expect(landing.url()).toBe('http://localhost/?x=1');
        expect(landing.historyLength()).toBe(1);
    });
});
