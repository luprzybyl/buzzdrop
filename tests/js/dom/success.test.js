import { within } from '@testing-library/dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PAGE_PATH, SHARE_LINK, openSuccessPage, screen } from '../support/pages/success.js';

const PAGE_URL = `http://localhost${PAGE_PATH}`;
const copyLinkButton = () => screen.getByRole('button', { name: 'Copy link' });
const copyOneClickButton = () => screen.getByRole('button', { name: 'Copy one-click link' });
const copyPasswordButton = () => screen.getByRole('button', { name: 'Copy password' });
const passwordField = () => screen.getByLabelText('Password');
const clipboardStatus = () => screen.getByRole('status', { name: 'Clipboard' });
const oneClickSection = () => within(screen.getByRole('region', { name: 'One-click link' }));

describe('success page', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    it('Copy copies the share link and flashes confirmation', async () => {
        const success = openSuccessPage();

        await success.copyShareLink();

        await vi.waitFor(() => expect(copyLinkButton()).toHaveTextContent('Copied!'));
        expect(await success.clipboardText()).toBe(SHARE_LINK);
        expect(clipboardStatus()).toHaveTextContent('Link copied to clipboard.');

        vi.advanceTimersByTime(2000);

        expect(copyLinkButton()).toHaveTextContent('Copy');
        expect(clipboardStatus()).toBeEmptyDOMElement();
    });

    it('a second Copy mid-flash still restores the original label', async () => {
        const success = openSuccessPage();

        await success.copyShareLink();
        await vi.waitFor(() => expect(copyLinkButton()).toHaveTextContent('Copied!'));
        vi.advanceTimersByTime(1000);
        await success.copyShareLink();
        await vi.waitFor(() => expect(clipboardStatus()).toHaveTextContent('Link copied to clipboard.'));
        vi.advanceTimersByTime(2000);

        expect(copyLinkButton()).toHaveTextContent('Copy');
    });

    it('Copy on the one-click link copies the link with the password', async () => {
        const success = openSuccessPage({ link: 'one-click', password: 'correct horse' });

        await success.copyOneClickLink();

        await vi.waitFor(() => expect(copyOneClickButton()).toHaveTextContent('Copied!'));
        expect(await success.clipboardText()).toBe(`${SHARE_LINK}#correct%20horse`);
        expect(clipboardStatus()).toHaveTextContent('One-click link copied to clipboard.');
    });

    it('Copy on the password copies the password and flashes confirmation', async () => {
        const success = openSuccessPage({ link: 'one-click', password: 'correct horse' });

        await success.copyPassword();

        await vi.waitFor(() => expect(copyPasswordButton()).toHaveTextContent('Copied!'));
        expect(await success.clipboardText()).toBe('correct horse');
        expect(clipboardStatus()).toHaveTextContent('Password copied to clipboard.');
        // Copying leaves the password masked on screen.
        expect(passwordField()).toHaveAttribute('type', 'password');

        vi.advanceTimersByTime(2000);

        expect(copyPasswordButton()).toHaveTextContent('Copy');
        expect(clipboardStatus()).toBeEmptyDOMElement();
    });

    it('flashes "Failed" when the browser blocks the clipboard', async () => {
        const success = openSuccessPage({ link: 'one-click', clipboard: 'blocked' });

        await success.copyPassword();

        await vi.waitFor(() => expect(copyPasswordButton()).toHaveTextContent('Failed'));
        expect(clipboardStatus())
            .toHaveTextContent('Your browser blocked clipboard access, so the password was not copied.');

        vi.advanceTimersByTime(4000);

        expect(copyPasswordButton()).toHaveTextContent('Copy');
    });

    it('flashes "Failed" when the browser has no clipboard at all', async () => {
        const success = openSuccessPage({ link: 'one-click', clipboard: 'unavailable' });

        await success.copyOneClickLink();

        await vi.waitFor(() => expect(copyOneClickButton()).toHaveTextContent('Failed'));
        expect(clipboardStatus())
            .toHaveTextContent('Your browser blocked clipboard access, so the one-click link was not copied.');
    });

    it('Copy link still works without a Clipboard API, as over plain HTTP', async () => {
        const success = openSuccessPage({ clipboard: 'unavailable' });

        await success.copyShareLink();

        expect(copyLinkButton()).toHaveTextContent('Copied!');
        expect(clipboardStatus()).toHaveTextContent('Link copied to clipboard.');
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

    it('fills the password from a well-formed fragment', () => {
        openSuccessPage({ link: 'one-click', password: 'correct horse' });

        expect(passwordField()).toHaveValue('correct horse');
        expect(copyPasswordButton()).toBeEnabled();
        expect(copyOneClickButton()).toBeEnabled();
    });

    it('shows the one-click link with its password masked, so it differs from the plain link', () => {
        openSuccessPage({ link: 'one-click', password: 'correct horse' });

        // The tail is what tells the two links apart; the password itself
        // stays off the screen, as it does in the password field.
        expect(oneClickSection().getByText(SHARE_LINK)).toBeVisible();
        expect(oneClickSection().getByText('#••••••')).toBeVisible();
        expect(screen.queryByText(/correct/)).toBeNull();
    });

    it('scrubs the fragment from the URL without adding a history entry', () => {
        const success = openSuccessPage({ link: 'one-click', query: 'x=1' });

        expect(success.url()).toBe(`${PAGE_URL}?x=1`);
        expect(success.historyLength()).toBe(1);
    });

    it('scrubs a mangled fragment and has no password or one-click link to copy', () => {
        const success = openSuccessPage({ link: 'mangled' });

        expect(success.url()).toBe(PAGE_URL);
        expect(passwordField()).toHaveValue('');
        expect(oneClickSection().getByText(SHARE_LINK)).not.toBeVisible();
        expect(copyPasswordButton()).toBeDisabled();
        expect(copyOneClickButton()).toBeDisabled();
    });
});
