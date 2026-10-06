// Journey 2 (docs/frontend-test-strategy.md §7): share a text note, open it
// in a fresh context, and read the plaintext on the page.
import { randomUUID } from 'node:crypto';
import { test, expect } from './fixtures.js';
import { logIn, openShare, shareNote } from './support.js';

test('a shared note decrypts to the original text on the page', async ({ page, browser, sharePassword }) => {
    // Several lines and non-ASCII text, so a decoding or trimming slip shows.
    const note = `Note ${randomUUID()}\n  zażółć gęślą jaźń 🐝\n\tlast line`;
    const password = sharePassword();

    await logIn(page);
    const link = await shareNote(page, note, password);

    const recipient = await browser.newContext();
    try {
        const view = await recipient.newPage();
        await openShare(view, link);
        await view.locator('#password-input').fill(password);
        await view.locator('#decrypt-btn').click();

        await expect(view.locator('#status')).toHaveText('Text decrypted successfully.');
        expect(await view.locator('#text-content').textContent()).toBe(note);
    } finally {
        await recipient.close();
    }
});
