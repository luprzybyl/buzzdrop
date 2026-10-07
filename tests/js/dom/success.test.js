import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PAGE_PATH, SHARE_LINK, openSuccessPage, screen } from '../support/pages/success.js';

const PAGE_URL = `http://localhost${PAGE_PATH}`;
const copyLinkButton = () => screen.getByRole('button', { name: 'Copy link' });
const passwordField = () => screen.getByLabelText('Password');
const clipboardStatus = () => screen.getByRole('status', { name: 'Clipboard' });

describe('success page', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    it('Copy copies the share link and flashes confirmation', async () => {
        const success = openSuccessPage();

        await success.copyShareLink();

        expect(await success.clipboardText()).toBe(SHARE_LINK);
        expect(copyLinkButton()).toHaveTextContent('Copied!');
        expect(clipboardStatus()).toHaveTextContent('Link copied to clipboard.');

        vi.advanceTimersByTime(2000);

        expect(copyLinkButton()).toHaveTextContent('Copy');
        expect(clipboardStatus()).toBeEmptyDOMElement();
    });

    it('a second Copy mid-flash still restores the original label', async () => {
        const success = openSuccessPage();

        await success.copyShareLink();
        vi.advanceTimersByTime(1000);
        await success.copyShareLink();
        vi.advanceTimersByTime(2000);

        expect(copyLinkButton()).toHaveTextContent('Copy');
    });

    it('Copy on the one-click link copies the link with the password', async () => {
        const success = openSuccessPage({ password: 'correct horse' });

        await success.copyOneClickLink();

        expect(await success.clipboardText()).toBe(`${SHARE_LINK}#correct%20horse`);
        expect(screen.getByRole('button', { name: 'Copy one-click link' })).toHaveTextContent('Copied!');
        expect(clipboardStatus()).toHaveTextContent('One-click link copied to clipboard.');
    });

    it('Show reveals the password, then hides it again', async () => {
        const success = openSuccessPage();

        await success.revealPassword();

        expect(passwordField()).toHaveAttribute('type', 'text');

        await success.hidePassword();

        expect(passwordField()).toHaveAttribute('type', 'password');
        expect(screen.getByRole('button', { name: 'Show' })).toBeVisible();
    });

    it('a revealed password hides itself after five seconds', async () => {
        const success = openSuccessPage();

        await success.revealPassword();
        vi.advanceTimersByTime(5000);

        expect(passwordField()).toHaveAttribute('type', 'password');
        expect(screen.getByRole('button', { name: 'Show' })).toBeVisible();
    });

    it('showing the password again restarts the five seconds', async () => {
        const success = openSuccessPage();

        await success.revealPassword();
        vi.advanceTimersByTime(3000);
        await success.hidePassword();
        await success.revealPassword();
        // The first reveal's five seconds are up; the second's are not.
        vi.advanceTimersByTime(3000);

        expect(passwordField()).toHaveAttribute('type', 'text');
        expect(screen.getByRole('button', { name: 'Hide' })).toBeVisible();
    });

    it('fills the password and one-click link from a well-formed fragment', () => {
        openSuccessPage({ password: 'correct horse' });

        expect(passwordField()).toHaveValue('correct horse');
        expect(screen.getByLabelText('One-click link with password')).toHaveValue(`${SHARE_LINK}#correct%20horse`);
    });

    it('scrubs the fragment from the URL without adding a history entry', () => {
        const success = openSuccessPage({ password: 'correct horse', query: 'x=1' });

        expect(success.url()).toBe(`${PAGE_URL}?x=1`);
        expect(success.historyLength()).toBe(1);
    });

    it('scrubs a mangled fragment and leaves the fields empty', () => {
        const success = openSuccessPage({ mangledFragment: true });

        expect(success.url()).toBe(PAGE_URL);
        expect(passwordField()).toHaveValue('');
        expect(screen.getByLabelText('One-click link with password')).toHaveValue('');
    });
});
