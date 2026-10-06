// Shared steps for the E2E journeys. Each test uploads under a unique name,
// because every test in the run shares one container and its database.
import { randomBytes, randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import { CryptoService, bytesToHex } from '../../static/js/crypto.js';

// crypto.js uses `window.crypto`; Node exposes Web Crypto on globalThis.
globalThis.window ??= /** @type {Window & typeof globalThis} */ (globalThis);

/** @typedef {import('@playwright/test').Page} Page */
/** @typedef {import('../../static/js/crypto.js').Bytes} Bytes */
/**
 * The in-memory file shape setInputFiles accepts (Playwright exports no name for it).
 * @typedef {{ name: string, mimeType: string, buffer: Buffer }} FilePayload
 */

// Matches FLASK_USER_1 in tests/e2e/e2e.env.
export const USER = { username: 'e2e', password: 'e2e-login-password' };

/**
 * A file with every byte value, under a unique name, so a decrypt that is
 * off by one byte, a text decoding or a truncation shows up.
 * @returns {FilePayload}
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
    // Module scripts run before DOMContentLoaded: from then on the composer's
    // listeners are wired, and a click is not lost on a half-booted page.
    await page.waitForURL((url) => url.pathname === '/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#share-action-btn')).toBeVisible();
}

/**
 * Uploads a file from the index page and returns the share link from the
 * success page.
 * @param {Page} page
 * @param {FilePayload} file
 * @param {string} password
 * @returns {Promise<string>}
 */
export async function shareFile(page, file, password) {
    await page.locator('#file').setInputFiles(file);
    await page.locator('#shared-password').fill(password);
    await page.locator('#share-action-btn').click();
    return shareLink(page);
}

/**
 * Shares a text note from the index page and returns the share link.
 * @param {Page} page
 * @param {string} text
 * @param {string} password
 * @returns {Promise<string>}
 */
export async function shareNote(page, text, password) {
    await page.locator('#text-tab').click();
    await page.locator('#note-text').fill(text);
    await page.locator('#shared-password').fill(password);
    await page.locator('#share-action-btn').click();
    return shareLink(page);
}

/**
 * @param {Page} page - the success page, or on its way there
 * @returns {Promise<string>}
 */
async function shareLink(page) {
    const link = page.locator('#share-link');
    await expect(link).toHaveValue(/\/view\//);
    return link.inputValue();
}

/**
 * Opens a share link and confirms, which consumes the share. Returns the
 * ciphertext the view page fetched, for tests that go on to talk to
 * /release themselves.
 * @param {Page} page
 * @param {string} link
 * @returns {Promise<Bytes>}
 */
export async function openShare(page, link) {
    await page.goto(link);
    const [download] = await Promise.all([
        page.waitForResponse((response) => new URL(response.url()).pathname.startsWith('/download/')),
        page.locator('#confirm-form button[type="submit"]').click(),
    ]);
    return new Uint8Array(await download.body());
}

/**
 * Opens a share link, confirms, and decrypts with the password. Returns the
 * download the decrypt triggers.
 * @param {Page} page
 * @param {string} link
 * @param {string} password
 * @returns {Promise<import('@playwright/test').Download>}
 */
export async function decryptShare(page, link, password) {
    await openShare(page, link);
    await page.locator('#password-input').fill(password);
    return clickDecryptForDownload(page);
}

/**
 * @param {Page} page - the view page, password filled in
 * @returns {Promise<import('@playwright/test').Download>}
 */
export async function clickDecryptForDownload(page) {
    const [download] = await Promise.all([
        page.waitForEvent('download'),
        page.locator('#decrypt-btn').click(),
    ]);
    return download;
}

/**
 * Proves a password to /release the way the view page does, from outside the
 * page: for asking again once the page has given up on the share. Derives V
 * with the app's own crypto.js, under Node's Web Crypto.
 * @param {Page} page - its request context carries the call
 * @param {string} link
 * @param {Bytes} blob - the ciphertext from openShare
 * @param {string} password
 * @returns {Promise<number>} the response status
 */
export async function releaseStatus(page, link, blob, password) {
    const crypto = new CryptoService();
    const v = await crypto.deriveVerifier(password, crypto.parseBlob(blob).salt);
    const response = await page.request.post(link.replace('/view/', '/release/'), {
        data: { v: bytesToHex(v) },
    });
    return response.status();
}

/**
 * The flash message the next page shows after a redirect, e.g. when a dead
 * share link bounces to the index.
 * @param {Page} page
 */
export function flash(page) {
    return page.locator('.alert-banner');
}
