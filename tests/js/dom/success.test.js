import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initSuccess } from '../../../static/js/success-page.js';
import { browserView, loadFixture } from '../support/dom-fixture.js';

const SHARE_LINK = 'http://localhost/view/00000000-0000-4000-8000-0000000000f1';
const PAGE_URL = 'http://localhost/success/00000000-0000-4000-8000-0000000000f1';

describe('success page', () => {
    /** @type {import('happy-dom').Window | undefined} */
    let page;

    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(async () => {
        vi.useRealTimers();
        await page?.happyDOM.close();
        page = undefined;
    });

    const start = (url = PAGE_URL) => {
        page = loadFixture('success--file', {}, url);
        const window = browserView(page);
        // happy-dom doesn't implement the copy command; the spy stands in for
        // it and records what was selected when it ran. happy-dom's select()
        // doesn't focus the input either, so the last one selected is tracked.
        /** @type {[string, string][]} */
        const copied = [];
        /** @type {HTMLInputElement | null} */
        let selected = null;
        const select = window.HTMLInputElement.prototype.select;
        window.HTMLInputElement.prototype.select = function () {
            selected = this;
            return select.call(this);
        };
        window.document.execCommand = vi.fn((/** @type {string} */ command) => {
            // The page always selects an input before copying.
            const input = /** @type {HTMLInputElement} */ (selected);
            copied.push([command, input.value.substring(
                /** @type {number} */ (input.selectionStart), /** @type {number} */ (input.selectionEnd))]);
            return true;
        });
        initSuccess(window.document, {});
        // Every id the tests look up is in the fixture.
        const byId = (/** @type {string} */ id) => /** @type {HTMLElement} */ (window.document.getElementById(id));
        // ...and these ones are <input>s.
        const field = (/** @type {string} */ id) => /** @type {HTMLInputElement} */ (byId(id));
        return {
            window,
            copied,
            byId,
            field,
            label: (/** @type {string} */ buttonId) => byId(buttonId).querySelector('.copy-label')?.textContent,
            status: () => byId('copy-status').textContent,
        };
    };

    it('Copy copies the share link and flashes confirmation', () => {
        const { copied, byId, label, status } = start();

        byId('copy-link-btn').click();

        expect(copied).toEqual([['copy', SHARE_LINK]]);
        expect(label('copy-link-btn')).toBe('Copied!');
        expect(status()).toBe('Link copied to clipboard.');

        vi.advanceTimersByTime(2000);

        expect(label('copy-link-btn')).toBe('Copy');
        expect(status()).toBe('');
    });

    it('a second Copy mid-flash still restores the original label', () => {
        const { byId, label } = start();

        byId('copy-link-btn').click();
        vi.advanceTimersByTime(1000);
        byId('copy-link-btn').click();
        vi.advanceTimersByTime(2000);

        expect(label('copy-link-btn')).toBe('Copy');
    });

    it('Copy on the one-click link copies the link with the password', () => {
        const { copied, byId, label, status } = start(`${PAGE_URL}#correct%20horse`);

        byId('copy-one-click-btn').click();

        expect(copied).toEqual([['copy', `${SHARE_LINK}#correct%20horse`]]);
        expect(label('copy-one-click-btn')).toBe('Copied!');
        expect(status()).toBe('One-click link copied to clipboard.');
    });

    it('Show reveals the password, then hides it again', () => {
        const { byId, field } = start();
        const input = field('password-display');
        const toggle = byId('toggle-password');

        toggle.click();

        expect(input.type).toBe('text');
        expect(toggle.textContent).toBe('Hide');

        toggle.click();

        expect(input.type).toBe('password');
        expect(toggle.textContent).toBe('Show');
    });

    it('a revealed password hides itself after five seconds', () => {
        const { byId, field } = start();

        byId('toggle-password').click();
        vi.advanceTimersByTime(5000);

        expect(field('password-display').type).toBe('password');
        expect(byId('toggle-password').textContent).toBe('Show');
    });

    it('showing the password again restarts the five seconds', () => {
        const { byId, field } = start();
        const toggle = byId('toggle-password');

        toggle.click();
        vi.advanceTimersByTime(3000);
        toggle.click();
        toggle.click();
        // The first reveal's five seconds are up; the second's are not.
        vi.advanceTimersByTime(3000);

        expect(field('password-display').type).toBe('text');
        expect(toggle.textContent).toBe('Hide');
    });

    it('fills the password and one-click link from a well-formed fragment', () => {
        const { field } = start(`${PAGE_URL}#correct%20horse`);

        expect(field('password-display').value).toBe('correct horse');
        expect(field('share-link-with-password').value).toBe(`${SHARE_LINK}#correct%20horse`);
    });

    it('scrubs the fragment from the URL without adding a history entry', () => {
        const { window } = start(`${PAGE_URL}?x=1#correct%20horse`);

        expect(window.location.href).toBe(`${PAGE_URL}?x=1`);
        expect(window.history.length).toBe(1);
    });

    it('scrubs a malformed fragment and leaves the fields empty', () => {
        const { window, field } = start(`${PAGE_URL}#%ZZ`);

        expect(window.location.href).toBe(PAGE_URL);
        expect(field('password-display').value).toBe('');
        expect(field('share-link-with-password').value).toBe('');
    });
});
