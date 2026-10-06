// Journey 3 (docs/frontend-test-strategy.md §7): once a share is opened and
// decrypted, its link is spent. The page no longer offers it, the ciphertext
// is gone, and /release answers 410 even to the right password.
import { test, expect } from './fixtures.js';
import { clickDecryptForDownload, flash, logIn, openShare, releaseStatus, shareFile, uniqueFile } from './support.js';

test('a second visit to a consumed link fails', async ({ page, browser, sharePassword }) => {
    const file = uniqueFile();
    const password = sharePassword();

    await logIn(page);
    const link = await shareFile(page, file, password);

    const recipient = await browser.newContext();
    try {
        const view = await recipient.newPage();
        const blob = await openShare(view, link);
        await view.locator('#password-input').fill(password);
        await clickDecryptForDownload(view);
        await expect(view.locator('#status')).toHaveText('Download complete.');

        await view.goto(link);
        await expect(flash(view)).toHaveText('File not found');
        await expect(view.locator('#confirm-form')).toHaveCount(0);

        await view.goto(link.replace('/view/', '/download/'));
        await expect(flash(view)).toContainText('This file has already been downloaded');

        expect(await releaseStatus(view, link, blob, password)).toBe(410);
    } finally {
        await recipient.close();
    }
});
