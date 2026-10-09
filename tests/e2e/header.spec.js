// Journey 8 (docs/frontend-test-strategy.md §7): on a phone-width viewport
// the sticky header stays one row, logged out and logged in, and the page
// doesn't scroll sideways (#232). Desktop Chrome's window can't go this
// narrow, so this is the only place it gets checked.
import { test, expect } from './fixtures.js';
import { USER, logIn } from './support.js';

/** @typedef {import('@playwright/test').Page} Page */
/** @typedef {import('@playwright/test').Locator} Locator */

/**
 * Fails unless every control sits on the logo's row of the header.
 * @param {Page} page
 * @param {Locator[]} controls
 */
async function expectOneRow(page, controls) {
    const logo = await page.getByRole('navigation').getByRole('link', { name: /^BuzzDrop/ }).boundingBox();
    if (!logo) throw new Error('logo is not rendered');
    for (const control of controls) {
        const box = await control.boundingBox();
        if (!box) throw new Error('header control is not rendered');
        // Each control's vertical middle falls within the logo's height.
        expect(box.y + box.height / 2).toBeGreaterThan(logo.y);
        expect(box.y + box.height / 2).toBeLessThan(logo.y + logo.height);
    }
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
}

for (const width of [375, 320]) {
    test(`the header stays one row at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 740 });
        const header = page.getByRole('navigation');

        await page.goto('/');
        await expectOneRow(page, [
            header.getByRole('link', { name: /GitHub/ }),
            header.getByRole('link', { name: 'Login' }),
        ]);

        await logIn(page);
        await expectOneRow(page, [
            header.getByText(USER.username, { exact: true }),
            header.getByRole('button', { name: 'Logout' }),
        ]);
    });
}
