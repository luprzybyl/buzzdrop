// Journey 7 (docs/frontend-test-strategy.md §7): log in, upload, log out,
// with the session cookie and CSRF token going over real HTTP. The upload's
// two POSTs and the logout POST are all CSRF-gated.
import { test, expect } from './fixtures.js';
import { flash, logIn, shareFile, uniqueFile } from './support.js';

test('log in, upload, log out', async ({ page, sharePassword }) => {
    await logIn(page);
    await expect(flash(page)).toHaveText('Logged in successfully');

    await shareFile(page, uniqueFile(), sharePassword());
    const successPage = page.url();

    await page.getByRole('button', { name: 'Logout' }).click();
    await expect(flash(page)).toHaveText('Logged out successfully');
    await expect(page.getByRole('link', { name: 'Login' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Share file' })).toHaveCount(0);

    // The session is gone, not just hidden: a login-only page sends us back.
    await page.goto(successPage);
    await expect(page).toHaveURL(/\/login/);
});
