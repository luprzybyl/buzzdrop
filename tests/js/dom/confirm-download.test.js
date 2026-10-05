import { afterEach, describe, expect, it } from 'vitest';
import { initConfirmDownload } from '../../../static/js/confirm-download-page.js';
import { loadFixture } from '../support/dom-fixture.js';

const PAGE_URL = 'http://localhost/view/00000000-0000-4000-8000-0000000000f1';
const CONFIRM_URL = `${PAGE_URL}/confirm`;

describe('confirm-download page', () => {
    let page;

    afterEach(async () => {
        await page?.happyDOM.close();
        page = undefined;
    });

    const start = (url = PAGE_URL) => {
        page = loadFixture('confirm_download--file', {}, url);
        initConfirmDownload(page.document, {});
        const form = page.document.getElementById('confirm-form');
        return {
            form,
            // Submits the way the button does, but stops the navigation itself:
            // the page's listener runs first and the test only reads the action
            // the POST would have gone to.
            submit() {
                form.addEventListener('submit', (event) => event.preventDefault(), { once: true });
                form.requestSubmit();
                return form.action;
            },
        };
    };

    it('carries the fragment password across the confirm POST', () => {
        const { submit } = start(`${PAGE_URL}#correct%20horse`);

        expect(submit()).toBe(`${CONFIRM_URL}#correct%20horse`);
    });

    it('posts without a fragment when the link carries none', () => {
        const { submit } = start();

        expect(submit()).toBe(CONFIRM_URL);
    });

    it('scrubs the fragment from the URL without adding a history entry', () => {
        start(`${PAGE_URL}?x=1#correct%20horse`);

        expect(page.location.href).toBe(`${PAGE_URL}?x=1`);
        expect(page.history.length).toBe(1);
    });
});
