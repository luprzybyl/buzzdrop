// Journey 4 (docs/frontend-test-strategy.md §7): under the default profile
// (KEY_RELEASE_MAX_ATTEMPTS=1, burn on lockout) one wrong password locks the
// share and burns the server's key share, so the right password fails too.
import { test, expect } from './fixtures.js';
import { randomBytes } from 'node:crypto';
import { decryptButton, decryptWithPassword, logIn, openShare, shareFile, shareStatus, uniqueFile, verifierStatus } from './support.js';

test('one wrong password burns the file', async ({ page, recipient, sharePassword }) => {
    const password = sharePassword();
    const wrongPassword = sharePassword();

    await logIn(page);
    const link = await shareFile(page, uniqueFile(), password);

    await openShare(recipient, link);
    await decryptWithPassword(recipient, wrongPassword);

    await expect(shareStatus(recipient)).toHaveText('Too many incorrect attempts — this share is locked.');
    await expect(decryptButton(recipient)).toBeDisabled();

    // The page has given up; ask /release directly. The share is burned, so
    // any verifier — the ciphertext never downloaded, so none can be derived
    // — gets the uniform 404.
    expect(await verifierStatus(recipient, link, randomBytes(32).toString('hex'))).toBe(404);
});
