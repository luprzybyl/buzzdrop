// Shared steps for the E2E journeys. Each test uploads under a unique name,
// because every test in the run shares one container and its database.
import { randomBytes, randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import { open } from '../../static/js/lib/crypto.js';
import { bytesToHex } from '../../static/js/lib/hex.js';

/** @typedef {import('@playwright/test').Page} Page */
/** @typedef {import('../../static/js/lib/crypto.js').Bytes} Bytes */
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
    await page.getByLabel('Username').fill(USER.username);
    await page.getByLabel('Password').fill(USER.password);
    await page.getByRole('button', { name: 'Login' }).click();
    // Module scripts run before DOMContentLoaded: from then on the composer's
    // listeners are wired, and a click is not lost on a half-booted page.
    await page.waitForURL((url) => url.pathname === '/', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('button', { name: 'Share file' })).toBeVisible();
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
    await page.getByLabel('Drop a file here, or browse').setInputFiles(file);
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Share file' }).click();
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
    await page.getByRole('tab', { name: 'Text note' }).click();
    await page.getByLabel('Secret text').fill(text);
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Share note' }).click();
    return shareLink(page);
}

/**
 * @param {Page} page - the success page, or on its way there
 * @returns {Promise<string>}
 */
async function shareLink(page) {
    const link = page.getByLabel('Link', { exact: true });
    await expect(link).toHaveValue(/\/view\//);
    return link.inputValue();
}

/**
 * The one-click link the success page builds, password in the fragment.
 * @param {Page} page - the success page
 * @returns {Promise<string>}
 */
export async function oneClickLink(page) {
    // The page shows the link with its password masked, so the link is taken
    // the way the sender takes it: from the Copy button. Reading the system
    // clipboard back needs permissions not every browser grants, so the write
    // is observed on its way there; the real writeText still runs, and the
    // button only says "Copied!" if the browser accepted it.
    await page.evaluate(() => {
        const { clipboard } = window.navigator;
        const writeText = clipboard.writeText.bind(clipboard);
        /** @type {string | undefined} */
        let copied;
        clipboard.writeText = (text) => { copied = text; return writeText(text); };
        Object.defineProperty(window, 'lastCopied', { get: () => copied });
    });
    // success.js enables Copy once it has built the link from the fragment.
    const copy = page.getByRole('button', { name: 'Copy one-click link' });
    await copy.click();
    await expect(copy).toHaveText('Copied!');
    return page.evaluate(() => /** @type {string} */ (/** @type {any} */ (window).lastCopied));
}

/**
 * Presses Proceed on the confirm page, which consumes the share. Returns the
 * ciphertext the view page then fetches, for tests that go on to talk to
 * /release themselves.
 * @param {Page} page - the confirm page
 * @returns {Promise<Bytes>}
 */
export async function proceedToView(page) {
    const [download] = await Promise.all([
        page.waitForResponse((response) => new URL(response.url()).pathname.startsWith('/download/')),
        page.getByRole('button', { name: /^Proceed to / }).click(),
    ]);
    return new Uint8Array(await download.body());
}

/**
 * Opens a share link and proceeds, which consumes the share. Returns the
 * ciphertext, as proceedToView does.
 * @param {Page} page
 * @param {string} link
 * @returns {Promise<Bytes>}
 */
export async function openShare(page, link) {
    await page.goto(link);
    return proceedToView(page);
}

/**
 * The view page's password field.
 * @param {Page} page
 */
export function passwordField(page) {
    return page.getByLabel('Password');
}

/**
 * The view page's Decrypt button, for files and notes alike.
 * @param {Page} page
 */
export function decryptButton(page) {
    return page.getByRole('button', { name: /^Decrypt and / });
}

/**
 * The view page's status line, which reports each outcome.
 * @param {Page} page
 */
export function shareStatus(page) {
    return page.getByRole('status');
}

/**
 * Types the password and presses Decrypt.
 * @param {Page} page - the view page
 * @param {string} password
 */
export async function decryptWithPassword(page, password) {
    await passwordField(page).fill(password);
    await decryptButton(page).click();
}

/**
 * Types the password and presses Enter in the field.
 * @param {Page} page - the view page
 * @param {string} password
 */
export async function decryptWithEnter(page, password) {
    await passwordField(page).fill(password);
    await passwordField(page).press('Enter');
}

/**
 * Decrypts a file and returns the download it triggers. Without a password,
 * presses Decrypt with the field as it is (a one-click link filled it in).
 * @param {Page} page - the view page
 * @param {string} [password]
 * @returns {Promise<import('@playwright/test').Download>}
 */
export async function decryptFile(page, password) {
    const [download] = await Promise.all([
        page.waitForEvent('download'),
        password === undefined ? decryptButton(page).click() : decryptWithPassword(page, password),
    ]);
    return download;
}

/**
 * Decrypts a note, submitting the password with Enter, and returns the text
 * the page shows. Exact, not whitespace-normalised, so a decoding or
 * trimming slip shows.
 * @param {Page} page - the view page
 * @param {string} password
 * @returns {Promise<string | null>}
 */
export async function decryptMessage(page, password) {
    await decryptWithEnter(page, password);
    await expect(shareStatus(page)).toHaveText('Text decrypted successfully.');
    return page.getByRole('region', { name: 'Decrypted text' }).textContent();
}

/**
 * Opens a share link, proceeds, and decrypts with the password. Returns the
 * download the decrypt triggers.
 * @param {Page} page
 * @param {string} link
 * @param {string} password
 * @returns {Promise<import('@playwright/test').Download>}
 */
export async function decryptShare(page, link, password) {
    await openShare(page, link);
    return decryptFile(page, password);
}

/**
 * Proves a password to /release the way the view page does, from outside the
 * page: for asking again once the page has given up on the share. Derives V
 * with the app's own lib/crypto.js, under Node's Web Crypto.
 * @param {Page} page - its request context carries the call
 * @param {string} link
 * @param {Bytes} blob - the ciphertext from openShare
 * @param {string} password
 * @returns {Promise<number>} the response status
 */
export async function releaseStatus(page, link, blob, password) {
    const { verifier } = await open(blob).unlock(password);
    return verifierStatus(page, link, bytesToHex(verifier));
}

/**
 * Posts a verifier to the share's /release as it is, without deriving it.
 * @param {Page} page - its request context carries the call
 * @param {string} link
 * @param {string} v - the verifier as hex
 * @returns {Promise<number>} the response status
 */
export async function verifierStatus(page, link, v) {
    const response = await page.request.post(shareUrl(link, 'release'), { data: { v } });
    return response.status();
}

/**
 * Another route of the share a link points at.
 * @param {string} link - the /view/<id> share link
 * @param {'download' | 'release'} route
 * @returns {string}
 */
export function shareUrl(link, route) {
    return link.replace('/view/', `/${route}/`);
}

/**
 * The flash message the next page shows after a redirect, e.g. when a
 * spent /download link bounces to the index.
 * @param {Page} page
 * @returns {import('@playwright/test').Locator}
 */
export function flash(page) {
    // A success flash is a status, an error flash an alert; the page's own
    // live regions are the same roles, and empty until something happens.
    return page.getByRole('status').or(page.getByRole('alert')).filter({ hasText: /\S/ });
}

/**
 * The share link leads nowhere: it answers 404 with the "drop is gone" page
 * and offers no way to proceed.
 * @param {Page} page
 * @param {string} link
 */
export async function expectDeadLink(page, link) {
    const response = await page.goto(link);
    expect(response?.status()).toBe(404);
    await expect(page.getByRole('heading', { name: 'This drop is gone' })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Proceed to / })).toHaveCount(0);
}
