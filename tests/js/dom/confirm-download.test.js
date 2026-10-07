import { describe, expect, it } from 'vitest';
import { SHARE_PATH, openConfirmPage } from '../support/pages/confirm.js';

const CONFIRM_URL = `http://localhost${SHARE_PATH}/confirm`;

describe('confirm-download page', () => {
    it('carries the fragment password across the confirm POST', async () => {
        const confirm = openConfirmPage({ link: 'one-click', password: 'correct horse' });

        expect(await confirm.proceedToView()).toBe(`${CONFIRM_URL}#correct%20horse`);
    });

    it('posts without a fragment when the link carries none', async () => {
        const confirm = openConfirmPage();

        expect(await confirm.proceedToView()).toBe(CONFIRM_URL);
    });

    it('scrubs the fragment from the URL without adding a history entry', () => {
        const confirm = openConfirmPage({ link: 'one-click', query: 'x=1' });

        expect(confirm.url()).toBe(`http://localhost${SHARE_PATH}?x=1`);
        expect(confirm.historyLength()).toBe(1);
    });
});
