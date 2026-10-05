import { afterEach, describe, expect, it, vi } from 'vitest';
import { initUsers } from '../../../static/js/users-page.js';
import { loadFixture } from '../support/dom-fixture.js';

const TOKEN = 'a'.repeat(64);
const EXPIRES_AT = '2099-01-01T00:00:00+00:00';

describe('users page', () => {
    let page;

    afterEach(async () => {
        vi.useRealTimers();
        await page?.happyDOM.close();
        page = undefined;
    });

    // `status`/`body` are what POST /api/token answers with.
    const start = ({ status = 201, body = { token: TOKEN, expires_at: EXPIRES_AT } } = {}) => {
        page = loadFixture('users--admin', {}, 'http://localhost/users');
        const fetch = vi.fn(async () => new page.Response(JSON.stringify(body), {
            status,
            headers: { 'Content-Type': 'application/json' },
        }));
        initUsers(page.document, { fetch });
        // The first card is testuser's.
        const card = page.document.querySelector('.token-card');
        const generate = card.querySelector('.generate-token-btn');
        return {
            fetch,
            card,
            generate,
            result: card.querySelector('.token-result'),
            input: card.querySelector('.generated-token-input'),
            expires: card.querySelector('.token-expires'),
            error: card.querySelector('.token-error'),
            copy: card.querySelector('.copy-token-btn'),
            // Clicks Generate and waits for the request to finish.
            async clickGenerate() {
                generate.click();
                await vi.waitFor(() => expect(generate.disabled).toBe(false));
            },
        };
    };

    it('Generate shows the token and its expiry, and re-enables the button', async () => {
        const { generate, result, input, expires, error } = start();

        generate.click();
        expect(generate.disabled).toBe(true);
        await vi.waitFor(() => expect(generate.disabled).toBe(false));

        expect(result.hidden).toBe(false);
        expect(input.value).toBe(TOKEN);
        expect(expires.textContent).toBe(
            `Expires ${EXPIRES_AT}. Reload to see it in the list below.`);
        expect(error.hidden).toBe(true);
    });

    it('a server error shows its message', async () => {
        const { result, input, error, generate, clickGenerate } = start({
            status: 403,
            body: { error: 'Admin access required' },
        });

        await clickGenerate();

        expect(result.hidden).toBe(false);
        expect(error.hidden).toBe(false);
        expect(error.textContent).toBe('Admin access required');
        expect(input.value).toBe('');
        expect(generate.disabled).toBe(false);
    });

    it('the request carries the CSRF header', async () => {
        const { fetch, clickGenerate } = start();

        await clickGenerate();

        expect(fetch).toHaveBeenCalledTimes(1);
        const [url, init] = fetch.mock.calls[0];
        expect(url).toBe('/api/token');
        expect(init.method).toBe('POST');
        expect(init.headers['X-CSRF-Token']).toBe('fixture-csrf-token');
        expect(JSON.parse(init.body)).toEqual({ username: 'testuser' });
    });

    it('Copy copies the token and shows "Copied!"', async () => {
        const { copy, clickGenerate } = start();
        await clickGenerate();
        // happy-dom doesn't implement the copy command; the spy stands in for
        // it and records the selected text when it runs.
        const copied = [];
        page.document.execCommand = vi.fn((command) => {
            const input = page.document.querySelector('.generated-token-input');
            copied.push([command, input.value.substring(input.selectionStart, input.selectionEnd)]);
            return true;
        });
        vi.useFakeTimers();

        copy.click();

        expect(copied).toEqual([['copy', TOKEN]]);
        const label = copy.querySelector('.copy-label');
        expect(label.textContent).toBe('Copied!');

        vi.advanceTimersByTime(2000);

        expect(label.textContent).toBe('Copy');
    });
});
