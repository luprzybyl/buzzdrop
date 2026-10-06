// Journey 5 (docs/frontend-test-strategy.md §7): the one-click link carries
// the password in the URL fragment. It decrypts without typing, and the
// fragment is scrubbed from the address bar on the way.
import { readFile } from 'node:fs/promises';
import { test, expect } from './fixtures.js';
import { clickDecryptForDownload, logIn, shareFile, uniqueFile } from './support.js';

test('a one-click link decrypts without typing and loses its fragment', async ({ page, recipient, sharePassword }) => {
    const file = uniqueFile();
    const password = sharePassword();

    await logIn(page);
    await shareFile(page, file, password);
    // success.js builds the link from the fragment once the page has loaded.
    const oneClickField = page.locator('#share-link-with-password');
    await expect(oneClickField).toHaveValue(/\/view\/[^#]+#./);
    const oneClickLink = await oneClickField.inputValue();

    await recipient.goto(oneClickLink);
    await expect(recipient.locator('#password-hint')).toContainText('This link already carries the key');
    expect(recipient.url()).not.toContain('#');

    await recipient.locator('#confirm-form button[type="submit"]').click();
    await expect(recipient.locator('#password-status')).toBeVisible();
    await expect(recipient.locator('#password-input')).toHaveValue(password);
    expect(recipient.url()).not.toContain('#');

    const download = await clickDecryptForDownload(recipient);
    expect((await readFile(await download.path())).equals(file.buffer)).toBe(true);
    await expect(recipient.locator('#status')).toHaveText('Download complete.');
    expect(recipient.url()).not.toContain('#');
});
