// Journey 4 (docs/frontend-test-strategy.md §7): under the default profile
// (KEY_RELEASE_MAX_ATTEMPTS=1, burn on lockout) one wrong password locks the
// share and burns the server's key share, so the right password fails too.
import { test, expect } from './fixtures.js';
import { logIn, openShare, releaseStatus, shareFile, uniqueFile } from './support.js';

test('one wrong password burns the file', async ({ page, recipient, sharePassword }) => {
    const password = sharePassword();
    const wrongPassword = sharePassword();

    await logIn(page);
    const link = await shareFile(page, uniqueFile(), password);

    const blob = await openShare(recipient, link);
    await recipient.locator('#password-input').fill(wrongPassword);
    await recipient.locator('#decrypt-btn').click();

    await expect(recipient.locator('#status')).toHaveText('Too many incorrect attempts — this share is locked.');
    await expect(recipient.locator('#decrypt-btn')).toBeDisabled();

    // The page has given up; ask /release directly. The share is gone, so
    // the right password gets the uniform 404.
    expect(await releaseStatus(recipient, link, blob, password)).toBe(404);
});
