// Page driver for the users page, where an admin issues API tokens
// (docs/frontend-test-strategy.md §7a). POST /api/token is not one of the
// protocol fake's routes, so the driver answers it itself, the way app.py does.
import { within } from '@testing-library/dom';
import { expect } from 'vitest';
import { initUsers } from '../../../../static/js/users-page.js';
import { openPage, waitUntil } from './page.js';

export { screen } from './page.js';

export const TOKEN = 'a'.repeat(64);
export const EXPIRES_AT = '2099-01-01T00:00:00+00:00';

/**
 * A request the page sent, as fetch received it.
 * @typedef {object} SentRequest
 * @property {string} url
 * @property {string} method
 * @property {Record<string, string>} headers
 * @property {unknown} body - parsed JSON
 */

/**
 * @typedef {object} UsersOptions
 * @property {'ok' | 'forbidden'} [server] - forbidden: the server refuses the
 *   token, as it does a session that is no longer an admin's
 */

/**
 * Open the users page as the admin. Token requests are held until the driver
 * lets them through, so a test can look at the page while one is in flight.
 * @param {UsersOptions} [options]
 */
export function openUsersPage({ server = 'ok' } = {}) {
    const page = openPage('users--admin', { path: '/users' });
    const { window, screen, user } = page;
    /** @type {SentRequest[]} */
    const sent = [];
    /** @type {Array<() => void>} */
    const held = [];
    /** @type {typeof globalThis.fetch} */
    const fetch = async (input, init = {}) => {
        sent.push({
            url: String(input),
            method: init.method ?? 'GET',
            // The page sends plain-object headers and a JSON string body.
            headers: { .../** @type {Record<string, string>} */ (init.headers) },
            body: JSON.parse(String(init.body)),
        });
        await new Promise((resolve) => { held.push(() => resolve(undefined)); });
        const [status, body] = server === 'ok'
            ? [201, { token: TOKEN, expires_at: EXPIRES_AT }]
            : [403, { error: 'Admin access required' }];
        return new window.Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    };
    initUsers(window.document, { fetch });

    /** @param {string} username */
    const card = (username) => within(screen.getByRole('region', { name: username }));
    /** @param {string} username */
    const generateButton = (username) => card(username).getByRole('button', { name: 'Generate token' });

    /**
     * Let the held token request through and wait for the page to settle.
     * @param {string} username
     */
    async function finishTokenRequest(username) {
        await waitUntil(() => expect(held).not.toHaveLength(0));
        held.splice(0).forEach((release) => release());
        await waitUntil(() => expect(generateButton(username)).toBeEnabled());
    }

    return {
        clipboardText: page.clipboardText,
        requestsSent: () => [...sent],
        /**
         * Press Generate token on a user's card and leave the request in
         * flight; finishTokenRequest() lets it through.
         * @param {string} username
         */
        startGeneratingToken: (username) => user.click(generateButton(username)),
        finishTokenRequest,
        /**
         * Press Generate token on a user's card and wait for the answer.
         * @param {string} username
         */
        async generateToken(username) {
            await user.click(generateButton(username));
            await finishTokenRequest(username);
        },
        /** @param {string} username */
        copyToken: (username) => user.click(card(username).getByRole('button', { name: 'Copy token' })),
    };
}
