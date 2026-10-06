// Shared steps for the E2E journeys. Each test uploads under a unique name,
// because every test in the run shares one container and its database.
import { randomBytes, randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';

/** @typedef {import('@playwright/test').Page} Page */

// Matches FLASK_USER_1 in tests/e2e/e2e.env.
export const USER = { username: 'e2e', password: 'e2e-login-password' };

/**
 * A share password strong enough for the index page's check, unique per call.
 * @returns {string}
 */
export function sharePassword() {
    return `amber-orchard-${randomBytes(6).toString('hex')}-velvet-comet`;
}

/**
 * A file with every byte value, under a unique name, so a decrypt that is
 * off by one byte, a text decoding or a truncation shows up.
 * @returns {{ name: string, mimeType: string, buffer: Buffer }}
 */
export function uniqueFile() {
    return {
        name: `e2e-${randomUUID()}.txt`,
        mimeType: 'text/plain',
        buffer: Buffer.concat([Buffer.from(Array.from({ length: 256 }, (_, i) => i)), randomBytes(4096)]),
    };
}

/**
 * @param {Page} page
 */
export async function logIn(page) {
    await page.goto('/login');
    await page.locator('#username').fill(USER.username);
    await page.locator('#password').fill(USER.password);
    await page.locator('button[type="submit"]').click();
    await expect(page.locator('#share-action-btn')).toBeVisible();
}

/**
 * Uploads a file from the index page and returns the share link from the
 * success page.
 * @param {Page} page
 * @param {{ name: string, mimeType: string, buffer: Buffer }} file
 * @param {string} password
 * @returns {Promise<string>}
 */
export async function shareFile(page, file, password) {
    await page.locator('#file').setInputFiles(file);
    await page.locator('#shared-password').fill(password);
    await page.locator('#share-action-btn').click();
    const link = page.locator('#share-link');
    await expect(link).toHaveValue(/\/view\//);
    return link.inputValue();
}
