// Journey 3 (docs/frontend-test-strategy.md §7): once a share is opened and
// decrypted, its link is spent. The page no longer offers it, the ciphertext
// is gone, and /release answers 410 even to the right password.
import { test, expect } from './fixtures.js';
import { clickDecryptForDownload, flash, logIn, openShare, releaseStatus, shareFile, shareUrl, uniqueFile } from './support.js';

test('a second visit to a consumed link fails', async ({ page, recipient, sharePassword }) => {
    const password = sharePassword();

    await logIn(page);
    const link = await shareFile(page, uniqueFile(), password);

    const blob = await openShare(recipient, link);
    await recipient.locator('#password-input').fill(password);
    await clickDecryptForDownload(recipient);
    await expect(recipient.locator('#status')).toHaveText('Download complete.');

    await recipient.goto(link);
    await expect(flash(recipient)).toHaveText('File not found');
    await expect(recipient.locator('#confirm-form')).toHaveCount(0);

    await recipient.goto(shareUrl(link, 'download'));
    await expect(flash(recipient)).toContainText('This file has already been downloaded');

    expect(await releaseStatus(recipient, link, blob, password)).toBe(410);
});
