// Journey 5 (docs/frontend-test-strategy.md §7): the one-click link carries
// the password in the URL fragment. It decrypts without typing, and the
// fragment is scrubbed from the address bar on the way.
import { readFile } from 'node:fs/promises';
import { test, expect } from './fixtures.js';
import { decryptFile, logIn, oneClickLink, passwordField, proceedToView, shareFile, shareStatus, uniqueFile } from './support.js';

test('a one-click link decrypts without typing and loses its fragment', async ({ page, recipient, sharePassword }) => {
    const file = uniqueFile();
    const password = sharePassword();

    await logIn(page);
    await shareFile(page, file, password);
    const link = await oneClickLink(page);

    await recipient.goto(link);
    await expect(recipient.getByText('This link already carries the key', { exact: false })).toBeVisible();
    expect(recipient.url()).not.toContain('#');

    await proceedToView(recipient);
    await expect(recipient.getByText('Your link included the password', { exact: false })).toBeVisible();
    await expect(passwordField(recipient)).toHaveValue(password);
    expect(recipient.url()).not.toContain('#');

    const download = await decryptFile(recipient);
    expect((await readFile(await download.path())).equals(file.buffer)).toBe(true);
    await expect(shareStatus(recipient)).toHaveText('Download complete.');
    expect(recipient.url()).not.toContain('#');
});
