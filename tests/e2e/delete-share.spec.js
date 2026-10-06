// Journey 6 (docs/frontend-test-strategy.md §7): the uploader deletes a file
// from the index list, and its share link is dead: the page, the ciphertext
// and the key share are all gone.
import { randomBytes } from 'node:crypto';
import { test, expect } from './fixtures.js';
import { expectDeadLink, flash, logIn, shareFile, shareUrl, uniqueFile, verifierStatus } from './support.js';

test('the uploader deletes a file and the link is dead', async ({ page, recipient, sharePassword }) => {
    const file = uniqueFile();

    await logIn(page);
    const link = await shareFile(page, file, sharePassword());

    // Other tests' files share the list, so search for this one's own row.
    await page.goto('/');
    await page.locator('#shared-files-search').fill(file.name);
    const row = page.locator('.shared-file-row', { hasText: file.name });
    await expect(row).toHaveCount(1);

    page.once('dialog', (dialog) => dialog.accept());
    await row.getByRole('button', { name: 'Delete' }).click();
    await expect(flash(page)).toHaveText('File deleted successfully');
    await expect(row).toHaveCount(0);

    await expectDeadLink(recipient, link);

    await recipient.goto(shareUrl(link, 'download'));
    await expect(flash(recipient)).toHaveText('File not found');

    // With the file deleted no salt is left to derive V from, so any
    // well-formed verifier will do. A key share that outlived its file would
    // count it as a wrong guess (403 or 429) instead of answering 404.
    expect(await verifierStatus(recipient, link, randomBytes(32).toString('hex'))).toBe(404);
});
