import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_MESSAGE, DEFAULT_PASSWORD, openShare, screen } from '../support/pages/view.js';

const WRONG_PASSWORD = 'wrong horse';
const decryptButton = () => screen.getByRole('button', { name: /^Decrypt and / });
const passwordField = () => screen.getByLabelText('Password');
const decryptedText = () => screen.getByRole('region', { name: 'Decrypted text' });

describe('view page', () => {
    it('a message is shown in the page once decrypted', async () => {
        const share = await openShare();

        await share.decryptWithPassword(DEFAULT_PASSWORD);

        expect(decryptedText()).toHaveTextContent(DEFAULT_MESSAGE);
        expect(screen.getByRole('status')).toHaveTextContent('Text decrypted successfully.');
        expect(passwordField()).not.toBeVisible();
        expect(screen.queryByRole('button', { name: 'Decrypt and view' })).toBeNull();
        expect(await share.decryptionRecorded()).toBe(true);
    });

    it('Enter in the password field decrypts without leaving the page', async () => {
        const share = await openShare();

        await share.decryptWithEnter(DEFAULT_PASSWORD);

        expect(decryptedText()).toHaveTextContent(DEFAULT_MESSAGE);
        expect(share.formsSubmitted()).toEqual([]);
    });

    // A submit before the page's listener exists would navigate natively (a
    // GET of the POST-only confirm page) and lose the share, whose download
    // is served once — so Decrypt stays disabled until the download is in.
    it('Decrypt stays disabled until the share has downloaded', async () => {
        const share = await openShare({ download: 'in-progress' });
        expect(screen.getByRole('button', { name: 'Decrypt and view' })).toBeDisabled();

        await share.finishDownload();

        expect(screen.getByRole('button', { name: 'Decrypt and view' })).toBeEnabled();
    });

    it('the status line is a live region, so outcomes are announced', async () => {
        await openShare();

        expect(screen.getByRole('status')).toHaveTextContent('Enter the password to reveal this note.');
    });

    it('Copy copies the message and shows "Copied!"', async () => {
        const share = await openShare();
        await share.decryptWithPassword(DEFAULT_PASSWORD);
        vi.useFakeTimers();

        await share.copyMessage();

        await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Copied!' })).toBeVisible());
        expect(await share.clipboardText()).toBe(DEFAULT_MESSAGE);

        vi.advanceTimersByTime(2000);

        expect(screen.getByRole('button', { name: 'Copy' })).toBeVisible();
    });

    it.each([
        ['a wrong password, with the attempts left', { maxAttempts: 3 }, WRONG_PASSWORD,
            'Incorrect password. 2 attempts remaining.'],
        ['a wrong password, with one attempt left', { maxAttempts: 2 }, WRONG_PASSWORD,
            'Incorrect password. 1 attempt remaining.'],
        ['a share already claimed', { server: /** @type {const} */ ('claimed') }, DEFAULT_PASSWORD,
            'This share has already been claimed.'],
        ['a wrong password on the last attempt', { maxAttempts: 1 }, WRONG_PASSWORD,
            'Too many incorrect attempts — this share is locked.'],
        ['a burned share', { server: /** @type {const} */ ('burned') }, DEFAULT_PASSWORD,
            'This share no longer exists — it was deleted, has expired, or was locked by wrong password attempts.'],
        ['a refused release', { server: /** @type {const} */ ('error') }, DEFAULT_PASSWORD,
            'The server refused to release the key.'],
        ['an unreachable server', { server: /** @type {const} */ ('unreachable') }, DEFAULT_PASSWORD,
            'Could not reach the server to release the key.'],
        ['a decryption failure without a message', { share: /** @type {const} */ ('corrupted') }, DEFAULT_PASSWORD,
            'Incorrect password or corrupted file. Ask the author to upload the file again.'],
    ])('%s shows its message', async (_, options, password, message) => {
        const share = await openShare(options);

        await share.decryptWithPassword(password);

        expect(screen.getByRole('status')).toHaveTextContent(message);
    });

    it('a wrong password leaves the form open for another try', async () => {
        const share = await openShare({ maxAttempts: 3 });

        await share.decryptWithPassword(WRONG_PASSWORD);

        expect(passwordField()).toBeEnabled();
        expect(decryptButton()).toBeEnabled();
        expect(share.reportsSent()).toEqual([]);
    });

    // The warning counts the attempts before the first one; afterwards the
    // status line reports what is left, or that the share is gone.
    it('the attempts warning goes once a password has been tried', async () => {
        const share = await openShare({ maxAttempts: 3 });
        expect(screen.getByText(/^You have 3 attempts/)).toBeVisible();
        expect(passwordField()).toHaveAccessibleDescription(/^You have 3 attempts/);

        await share.decryptWithPassword(WRONG_PASSWORD);

        expect(screen.getByText(/^You have 3 attempts/)).not.toBeVisible();
        expect(passwordField()).not.toHaveAccessibleDescription();
    });

    it('a failed decryption is reported to the server', async () => {
        const share = await openShare({ server: 'claimed' });

        await share.decryptWithPassword(DEFAULT_PASSWORD);

        expect(passwordField()).toBeDisabled();
        expect(decryptButton()).toBeDisabled();
        expect(share.reportsSent()).toEqual([{ success: false, receipt: null }]);
    });

    it('an unsupported share format disables the form', async () => {
        await openShare({ share: 'unsupported-format' });

        expect(screen.getByText(/^You have one attempt/)).not.toBeVisible();
        expect(screen.getByRole('status')).toHaveTextContent(
            'This share uses an unsupported format. Ask the author to upload it again.');
        expect(passwordField()).toBeDisabled();
        expect(decryptButton()).toBeDisabled();
    });

    it('a one-click link fills the password and says so', async () => {
        await openShare({ type: 'file', link: 'one-click' });

        expect(passwordField()).toHaveValue(DEFAULT_PASSWORD);
        expect(screen.getByText(/Your link included the password/)).toBeVisible();
        expect(screen.getByRole('button', { name: 'Decrypt and download' })).toHaveFocus();
    });

    it('a one-click link to a message fills the password without a press-Decrypt hint', async () => {
        await openShare({ link: 'one-click' });

        expect(passwordField()).toHaveValue(DEFAULT_PASSWORD);
        expect(screen.queryByText(/Your link included the password/)).toBeNull();
        expect(screen.getByRole('button', { name: 'Decrypt and view' })).toHaveFocus();
    });

    it('scrubs the fragment from the URL without adding a history entry', async () => {
        const share = await openShare({ link: 'one-click', query: 'x=1' });

        expect(share.url()).toBe(`http://localhost/view/${share.fileId}/confirm?x=1`);
        expect(share.historyLength()).toBe(1);
    });

    it('scrubs a mangled fragment and leaves the field empty', async () => {
        const share = await openShare({ type: 'file', link: 'mangled' });

        expect(share.url()).toBe(`http://localhost/view/${share.fileId}/confirm`);
        expect(passwordField()).toHaveValue('');
        expect(screen.getByText(/Your link included the password/)).not.toBeVisible();
    });
});
