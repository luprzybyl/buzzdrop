// Journey 1 (docs/frontend-test-strategy.md §7): upload a file, open the
// share link in a fresh context, decrypt, and get back the original bytes.
import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import { decryptShare, logIn, shareFile, sharePassword, uniqueFile } from './support.js';

test('a shared file decrypts to the original bytes', async ({ page, browser }) => {
    const file = uniqueFile();
    const password = sharePassword();

    await logIn(page);
    const link = await shareFile(page, file, password);

    // The recipient has no session: a separate context, as in real use.
    const recipient = await browser.newContext();
    try {
        const view = await recipient.newPage();
        const download = await decryptShare(view, link, password);

        expect(download.suggestedFilename()).toBe(file.name);
        expect((await readFile(await download.path())).equals(file.buffer)).toBe(true);
        await expect(view.locator('#status')).toHaveText('Download complete.');
    } finally {
        // Downloads live until their context closes.
        await recipient.close();
    }
});
