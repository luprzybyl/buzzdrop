// Journey 5 (docs/frontend-test-strategy.md §7): the one-click link carries
// the password in the URL fragment. It decrypts without typing, and the
// fragment is scrubbed from the address bar on the way.
import { readFile } from 'node:fs/promises';
import { test, expect } from './fixtures.js';
import { clickDecryptForDownload, logIn, shareFile, uniqueFile } from './support.js';

test('a one-click link decrypts without typing and loses its fragment', async ({ page, browser, sharePassword }) => {
    const file = uniqueFile();
    const password = sharePassword();

    await logIn(page);
    await shareFile(page, file, password);
    // success.js builds the link from the fragment once the page has loaded.
    const oneClickField = page.locator('#share-link-with-password');
    await expect(oneClickField).toHaveValue(/\/view\/[^#]+#./);
    const oneClickLink = await oneClickField.inputValue();

    const recipient = await browser.newContext();
    try {
        const view = await recipient.newPage();
        await view.goto(oneClickLink);
        await expect(view.locator('#password-hint')).toContainText('This link already carries the key');
        expect(view.url()).not.toContain('#');

        await view.locator('#confirm-form button[type="submit"]').click();
        await expect(view.locator('#password-status')).toBeVisible();
        await expect(view.locator('#password-input')).toHaveValue(password);
        expect(view.url()).not.toContain('#');

        const download = await clickDecryptForDownload(view);
        expect((await readFile(await download.path())).equals(file.buffer)).toBe(true);
        await expect(view.locator('#status')).toHaveText('Download complete.');
        expect(view.url()).not.toContain('#');
    } finally {
        await recipient.close();
    }
});
