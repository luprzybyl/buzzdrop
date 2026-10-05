// --- Users page logic ---
// "Generate token" buttons on /users POST /api/token and render the raw token
// inline. The token is returned exactly once and is never stored server-side,
// so the result panel stays visible until the page is reloaded.
import { required, requiredClosest } from './required.js';

/**
 * @typedef {object} UsersDeps
 * @property {typeof fetch} fetch
 */

/**
 * What POST /api/token answers: the raw token (shown once) and its expiry on
 * success, `{error}` otherwise.
 * @typedef {object} TokenResponse
 * @property {string} [token]
 * @property {string} [expires_at]
 * @property {string} [error]
 */

/**
 * `fetch` is bound to the window: called unbound, as deps.fetch(...), the
 * browser's fetch throws "Illegal invocation".
 * @returns {UsersDeps}
 */
export function browserDeps() {
    return { fetch: window.fetch.bind(window) };
}

/**
 * @param {Document} root - the users.html document
 * @param {UsersDeps} deps
 */
export function initUsers(root, deps) {
    const csrfToken = /** @type {HTMLMetaElement | null} */ (root.querySelector('meta[name="csrf-token"]'))?.content || '';

    /** @param {HTMLButtonElement} button */
    function flashCopied(button) {
        const label = button.querySelector('.copy-label');
        if (!label) return;
        label.textContent = 'Copied!';
        setTimeout(() => {
            label.textContent = 'Copy';
        }, 2000);
    }

    /** @param {HTMLButtonElement} button */
    async function generateToken(button) {
        const card = requiredClosest(button, '.token-card', 'div');
        const result = required(card, '.token-result', 'div');
        const input = required(card, '.generated-token-input', 'input');
        const expires = required(card, '.token-expires', 'p');
        const error = required(card, '.token-error', 'p');

        button.disabled = true;
        error.hidden = true;
        try {
            const resp = await deps.fetch('/api/token', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': csrfToken,
                },
                body: JSON.stringify({ username: button.dataset.username }),
            });
            /** @type {TokenResponse} */
            const body = await resp.json().catch(() => ({}));
            if (!resp.ok) throw new Error(body.error || `Server returned ${resp.status}`);
            // A 2xx always carries the token.
            input.value = /** @type {string} */ (body.token);
            expires.textContent = `Expires ${body.expires_at}. Reload to see it in the list below.`;
        } catch (err) {
            error.hidden = false;
            error.textContent = /** @type {Error} */ (err).message;
        } finally {
            result.hidden = false;
            button.disabled = false;
        }
    }

    /** @type {NodeListOf<HTMLButtonElement>} */ (root.querySelectorAll('.generate-token-btn')).forEach((button) => {
        button.addEventListener('click', () => generateToken(button));
    });

    /** @type {NodeListOf<HTMLButtonElement>} */ (root.querySelectorAll('.copy-token-btn')).forEach((button) => {
        button.addEventListener('click', () => {
            const input = required(requiredClosest(button, '.copy-field', 'div'), 'input', 'input');
            input.select();
            root.execCommand('copy');
            flashCopied(button);
        });
    });
}
