// --- Users page logic ---
// "Generate token" buttons on /users POST /api/token and render the raw token
// inline. The token is returned exactly once and is never stored server-side,
// so the result panel stays visible until the page is reloaded.

// `fetch` is bound to the window: called unbound, as deps.fetch(...), the
// browser's fetch throws "Illegal invocation".
export function browserDeps() {
    return { fetch: window.fetch.bind(window) };
}

export function initUsers(root, deps) {
    const csrfToken = root.querySelector('meta[name="csrf-token"]')?.content || '';

    function flashCopied(button) {
        const label = button.querySelector('.copy-label');
        if (!label) return;
        label.textContent = 'Copied!';
        setTimeout(() => {
            label.textContent = 'Copy';
        }, 2000);
    }

    async function generateToken(button) {
        const card = button.closest('.token-card');
        const result = card.querySelector('.token-result');
        const input = card.querySelector('.generated-token-input');
        const expires = card.querySelector('.token-expires');
        const error = card.querySelector('.token-error');

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
            const body = await resp.json().catch(() => ({}));
            if (!resp.ok) throw new Error(body.error || `Server returned ${resp.status}`);
            input.value = body.token;
            expires.textContent = `Expires ${body.expires_at}. Reload to see it in the list below.`;
        } catch (err) {
            error.hidden = false;
            error.textContent = err.message;
        } finally {
            result.hidden = false;
            button.disabled = false;
        }
    }

    root.querySelectorAll('.generate-token-btn').forEach((button) => {
        button.addEventListener('click', () => generateToken(button));
    });

    root.querySelectorAll('.copy-token-btn').forEach((button) => {
        button.addEventListener('click', () => {
            const input = button.closest('.copy-field').querySelector('input');
            input.select();
            root.execCommand('copy');
            flashCopied(button);
        });
    });
}
