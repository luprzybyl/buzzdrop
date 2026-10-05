import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initSuccess } from '../../../static/js/success-page.js';
import { loadFixture } from '../support/dom-fixture.js';

const SHARE_LINK = 'http://localhost/view/00000000-0000-4000-8000-0000000000f1';
const PAGE_URL = 'http://localhost/success/00000000-0000-4000-8000-0000000000f1';

describe('success page', () => {
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
        // happy-dom doesn't implement the copy command; the spy stands in for
        // it and records what was selected when it ran. happy-dom's select()
        // doesn't focus the input either, so the last one selected is tracked.
        const copied = [];
        let selected = null;
        const select = page.HTMLInputElement.prototype.select;
        page.HTMLInputElement.prototype.select = function () {
            selected = this;
            return select.call(this);
        };
        page.document.execCommand = vi.fn((command) => {
            copied.push([command, selected.value.substring(selected.selectionStart, selected.selectionEnd)]);
            return true;
        });
        initSuccess(page.document, {});
        const byId = (id) => page.document.getElementById(id);
        return {
            copied,
            byId,
            label: (buttonId) => byId(buttonId).querySelector('.copy-label').textContent,
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
        const { byId } = start();
        const input = byId('password-display');
        const toggle = byId('toggle-password');

        toggle.click();

        expect(input.type).toBe('text');
        expect(toggle.textContent).toBe('Hide');

        toggle.click();

        expect(input.type).toBe('password');
        expect(toggle.textContent).toBe('Show');
    });

    it('a revealed password hides itself after five seconds', () => {
        const { byId } = start();

        byId('toggle-password').click();
        vi.advanceTimersByTime(5000);

        expect(byId('password-display').type).toBe('password');
        expect(byId('toggle-password').textContent).toBe('Show');
    });

    it('showing the password again restarts the five seconds', () => {
        const { byId } = start();
        const toggle = byId('toggle-password');

        toggle.click();
        vi.advanceTimersByTime(3000);
        toggle.click();
        toggle.click();
        // The first reveal's five seconds are up; the second's are not.
        vi.advanceTimersByTime(3000);

        expect(byId('password-display').type).toBe('text');
        expect(toggle.textContent).toBe('Hide');
    });

    it('fills the password and one-click link from a well-formed fragment', () => {
        const { byId } = start(`${PAGE_URL}#correct%20horse`);

        expect(byId('password-display').value).toBe('correct horse');
        expect(byId('share-link-with-password').value).toBe(`${SHARE_LINK}#correct%20horse`);
    });

    it('scrubs the fragment from the URL without adding a history entry', () => {
        start(`${PAGE_URL}?x=1#correct%20horse`);

        expect(page.location.href).toBe(`${PAGE_URL}?x=1`);
        expect(page.history.length).toBe(1);
    });

    it('scrubs a malformed fragment and leaves the fields empty', () => {
        const { byId } = start(`${PAGE_URL}#%ZZ`);

        expect(page.location.href).toBe(PAGE_URL);
        expect(byId('password-display').value).toBe('');
        expect(byId('share-link-with-password').value).toBe('');
    });
});
