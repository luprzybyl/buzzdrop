// Journey 6 (docs/frontend-test-strategy.md §7): the uploader deletes a file
// from the index list, and its share link is dead.
import { test, expect } from './fixtures.js';
import { flash, logIn, shareFile, uniqueFile } from './support.js';

test('the uploader deletes a file and the link is dead', async ({ page, browser, sharePassword }) => {
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
    await expect(page.locator('.shared-file-row', { hasText: file.name })).toHaveCount(0);

    const recipient = await browser.newContext();
    try {
        const view = await recipient.newPage();
        await view.goto(link);
        await expect(flash(view)).toHaveText('File not found');
        await expect(view.locator('#confirm-form')).toHaveCount(0);
    } finally {
        await recipient.close();
    }
});
