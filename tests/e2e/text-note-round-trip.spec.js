// Journey 2 (docs/frontend-test-strategy.md §7): share a text note, open it
// in a fresh context, and read the plaintext on the page.
import { randomUUID } from 'node:crypto';
import { test, expect } from './fixtures.js';
import { decryptMessage, logIn, openShare, shareNote } from './support.js';

test('a shared note decrypts to the original text on the page', async ({ page, recipient, sharePassword }) => {
    // Several lines and non-ASCII text, so a decoding or trimming slip shows.
    const note = `Note ${randomUUID()}\n  zażółć gęślą jaźń 🐝\n\tlast line`;
    const password = sharePassword();

    await logIn(page);
    const link = await shareNote(page, note, password);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Note is in the hive');

    await openShare(recipient, link);
    // Enter in the field submits, as on any form (#227).
    expect(await decryptMessage(recipient, password)).toBe(note);
});
