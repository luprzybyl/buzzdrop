import { within } from '@testing-library/dom';
import { describe, expect, it, vi } from 'vitest';
import { EXPIRES_AT, TOKEN, openUsersPage, screen } from '../support/pages/users.js';

const card = () => within(screen.getByRole('region', { name: 'testuser' }));

describe('users page', () => {
    it('Generate shows the token and its expiry, and re-enables the button', async () => {
        const users = openUsersPage();

        await users.startGeneratingToken('testuser');
        expect(card().getByRole('button', { name: 'Generate token' })).toBeDisabled();
        await users.finishTokenRequest('testuser');

        expect(card().getByRole('textbox', { name: 'New API token' })).toHaveValue(TOKEN);
        expect(card().getByText(`Expires ${EXPIRES_AT}. Reload to see it in the list below.`)).toBeVisible();
        expect(card().queryByRole('alert')).toBeNull();
    });

    it('a server error shows its message', async () => {
        const users = openUsersPage({ server: 'forbidden' });

        await users.generateToken('testuser');

        expect(card().getByRole('alert')).toHaveTextContent('Admin access required');
        expect(card().getByRole('textbox', { name: 'New API token' })).toHaveValue('');
        expect(card().getByRole('button', { name: 'Generate token' })).toBeEnabled();
    });

    it('the request carries the CSRF header', async () => {
        const users = openUsersPage();

        await users.generateToken('testuser');

        expect(users.requestsSent()).toEqual([{
            url: '/api/token',
            method: 'POST',
            headers: expect.objectContaining({ 'X-CSRF-Token': 'fixture-csrf-token' }),
            body: { username: 'testuser' },
        }]);
    });

    it('Copy copies the token and shows "Copied!"', async () => {
        const users = openUsersPage();
        await users.generateToken('testuser');
        vi.useFakeTimers();

        await users.copyToken('testuser');

        expect(await users.clipboardText()).toBe(TOKEN);
        const copy = card().getByRole('button', { name: 'Copy token' });
        expect(copy).toHaveTextContent('Copied!');

        vi.advanceTimersByTime(2000);

        expect(copy).toHaveTextContent('Copy');
    });
});
