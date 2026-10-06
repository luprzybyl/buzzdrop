// Journey 1 (docs/frontend-test-strategy.md §7): upload a file, open the
// share link in a fresh context, decrypt, and get back the original bytes.
import { readFile } from 'node:fs/promises';
import { test, expect } from './fixtures.js';
import { decryptShare, logIn, shareFile, uniqueFile } from './support.js';

test('a shared file decrypts to the original bytes', async ({ page, recipient, sharePassword }) => {
    const file = uniqueFile();
    const password = sharePassword();

    await logIn(page);
    const link = await shareFile(page, file, password);

    const download = await decryptShare(recipient, link, password);

    expect(download.suggestedFilename()).toBe(file.name);
    expect((await readFile(await download.path())).equals(file.buffer)).toBe(true);
    await expect(recipient.locator('#status')).toHaveText('Download complete.');
});
