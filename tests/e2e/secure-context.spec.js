// Security invariant (docs/frontend-test-strategy.md §7): Web Crypto is only
// available in a secure context, so the app origin the journeys use must be
// one. happy-dom doesn't model isSecureContext, so this lives here.
import { test, expect } from '@playwright/test';

test('the app origin is a secure context with crypto.subtle', async ({ page }) => {
    await page.goto('/login');
    const origin = await page.evaluate(() => ({
        secure: window.isSecureContext,
        subtle: typeof window.crypto.subtle?.deriveBits,
    }));
    expect(origin).toEqual({ secure: true, subtle: 'function' });
});
