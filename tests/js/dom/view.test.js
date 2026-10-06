import { afterEach, describe, expect, it, vi } from 'vitest';
import { required } from '../../../static/js/required.js';
import { initView } from '../../../static/js/view-page.js';
import { browserView, loadFixture } from '../support/dom-fixture.js';

const PAGE_URL = 'http://localhost/view/00000000-0000-4000-8000-0000000000f2/confirm';
const NOTE = 'meet at the hive at noon';
const RECEIPT = new Uint8Array(32).fill(7);
const RECEIPT_HEX = '07'.repeat(32);

/**
 * How the stubbed server answers POST /release: a status and JSON body, or
 * 'network' for a request that never arrives.
 * @typedef {{status: number, body: object} | 'network'} ReleaseAnswer
 */

/**
 * @typedef {object} StartOptions
 * @property {'view--text' | 'view--file'} [fixture]
 * @property {string} [url] - the page's address, fragment included
 * @property {ReleaseAnswer} [release]
 * @property {boolean} [unsupported] - the downloaded blob isn't a BKV3 share
 * @property {Error} [decryptError] - decryption itself fails
 */

describe('view page', () => {
    /** @type {import('happy-dom').Window | undefined} */
    let page;

    afterEach(async () => {
        vi.useRealTimers();
        await page?.happyDOM.close();
        page = undefined;
    });

    // The network and the crypto are stubbed: the DOM layer tests what the page
    // shows for each answer, and the real crypto runs in the integration layer.
    /** @param {StartOptions} [options] */
    const start = async ({
        fixture = 'view--text',
        url = PAGE_URL,
        release = { status: 200, body: { h: 'ab'.repeat(32) } },
        unsupported = false,
        decryptError,
    } = {}) => {
        page = loadFixture(fixture, {}, url);
        const window = browserView(page);
        /** @type {{success: boolean, receipt: string | null}[]} */
        const reports = [];
        const fetch = /** @type {import('vitest').Mock<typeof globalThis.fetch>} */ (vi.fn(async (input, init) => {
            const path = String(input);
            if (path.startsWith('/download/')) {
                return new window.Response(new Uint8Array(100));
            }
            if (path.startsWith('/release/')) {
                if (release === 'network') throw new TypeError('Failed to fetch');
                return new window.Response(JSON.stringify(release.body), { status: release.status });
            }
            if (path.startsWith('/report_decryption/')) {
                reports.push(JSON.parse(String(init?.body)));
                return new window.Response('{}');
            }
            throw new Error(`unexpected request to ${path}`);
        }));
        const crypto = {
            /** @param {Uint8Array} blob */
            parseBlob(blob) {
                if (unsupported) throw new Error('Unsupported share format');
                return { version: 3, salt: new Uint8Array(16), iv: new Uint8Array(12), ciphertext: blob.slice(32) };
            },
            deriveVerifier: async () => new Uint8Array(32),
            decrypt: async () => {
                if (decryptError) throw decryptError;
                return { data: new TextEncoder().encode(NOTE), receipt: RECEIPT };
            },
        };
        await initView(window.document, { fetch, crypto });

        const status = required(window.document, '#status', 'p');
        const input = required(window.document, '#password-input', 'input');
        const decryptBtn = required(window.document, '#decrypt-btn', 'button');
        return {
            window,
            fetch,
            reports,
            status,
            input,
            decryptBtn,
            form: required(window.document, '#decrypt-form', 'form'),
            textDisplay: required(window.document, '#text-display', 'div'),
            textContent: required(window.document, '#text-content', 'pre'),
            copyBtn: required(window.document, '#copy-text-btn', 'button'),
            passwordStatus: required(window.document, '#password-status', 'p'),
            // Types the password, clicks Decrypt and waits for the outcome.
            /** @param {string} password */
            async decrypt(password) {
                const before = status.textContent;
                input.value = password;
                decryptBtn.click();
                await vi.waitFor(() => expect(status.textContent).not.toBe(before));
            },
        };
    };

    it('a text note is shown in the page once decrypted', async () => {
        const { decrypt, status, form, textDisplay, textContent, reports } = await start();

        await decrypt('correct horse');

        expect(textContent.textContent).toBe(NOTE);
        expect(textDisplay.style.display).toBe('block');
        expect(status.textContent).toBe('Text decrypted successfully.');
        expect(form.style.display).toBe('none');
        expect(reports).toEqual([{ success: true, receipt: RECEIPT_HEX }]);
    });

    // happy-dom has no implicit submission, so this submits the form the way
    // Enter in the field does in a browser (the E2E note journey presses Enter).
    it('submitting the form decrypts without navigating away', async () => {
        const { form, input, status, textContent } = await start();
        input.value = 'correct horse';
        // Runs after the page's listener, so it sees whether that one
        // cancelled the navigation (happy-dom wouldn't navigate either way).
        let navigationCancelled = false;
        form.addEventListener('submit', (event) => { navigationCancelled = event.defaultPrevented; });

        form.requestSubmit();

        await vi.waitFor(() => expect(status.textContent).toBe('Text decrypted successfully.'));
        expect(textContent.textContent).toBe(NOTE);
        expect(navigationCancelled).toBe(true);
    });

    it('the status line is a live region, so outcomes are announced', async () => {
        const { status } = await start();

        expect(status.getAttribute('aria-live')).toBe('polite');
    });

    it('Copy copies the note and shows "Copied!"', async () => {
        const { window, decrypt, copyBtn } = await start();
        await decrypt('correct horse');
        vi.useFakeTimers();

        copyBtn.click();

        await vi.waitFor(() => expect(copyBtn.textContent).toBe('Copied!'));
        expect(await window.navigator.clipboard.readText()).toBe(NOTE);

        vi.advanceTimersByTime(2000);

        expect(copyBtn.textContent).toBe('Copy');
    });

    it.each([
        ['a wrong password, with the attempts left', { release: { status: 403, body: { error: 'Incorrect password', attempts_remaining: 2 } } },
            'Incorrect password. 2 attempts remaining.'],
        ['a wrong password, with one attempt left', { release: { status: 403, body: { error: 'Incorrect password', attempts_remaining: 1 } } },
            'Incorrect password. 1 attempt remaining.'],
        ['a share already claimed', { release: { status: 410, body: { error: 'Key already released' } } },
            'This share has already been claimed.'],
        ['a locked share', { release: { status: 429, body: { error: 'Too many attempts' } } },
            'Too many incorrect attempts — this share is locked.'],
        ['a missing or burned share', { release: { status: 404, body: { error: 'Not found' } } },
            'This share no longer exists — it was deleted, has expired, or was locked by wrong password attempts.'],
        ['a refused release', { release: { status: 500, body: { error: 'Internal error' } } },
            'The server refused to release the key.'],
        ['an unreachable server', { release: /** @type {const} */ ('network') },
            'Could not reach the server to release the key.'],
        ['a decryption failure without a message', { decryptError: new Error('') },
            'Incorrect password or corrupted file. Ask the author to upload the file again.'],
    ])('%s shows its message', async (_, options, message) => {
        const { decrypt, status } = await start(options);

        await decrypt('correct horse');

        expect(status.textContent).toBe(message);
    });

    it('a wrong password leaves the form open for another try', async () => {
        const { decrypt, input, decryptBtn, reports } = await start({
            release: { status: 403, body: { error: 'Incorrect password', attempts_remaining: 2 } },
        });

        await decrypt('wrong');

        expect(input.disabled).toBe(false);
        expect(decryptBtn.disabled).toBe(false);
        expect(reports).toEqual([]);
    });

    it('a failed decryption is reported to the server', async () => {
        const { decrypt, input, decryptBtn, reports } = await start({
            release: { status: 410, body: { error: 'Key already released' } },
        });

        await decrypt('correct horse');

        expect(input.disabled).toBe(true);
        expect(decryptBtn.disabled).toBe(true);
        expect(reports).toEqual([{ success: false, receipt: null }]);
    });

    it('an unsupported share format disables the form', async () => {
        const { status, input, decryptBtn } = await start({ unsupported: true });

        expect(status.textContent).toBe(
            'This share uses an unsupported format. Ask the author to upload it again.');
        expect(input.disabled).toBe(true);
        expect(decryptBtn.disabled).toBe(true);
    });

    it('fills the password from a well-formed fragment', async () => {
        const { window, input, decryptBtn, passwordStatus } = await start({ url: `${PAGE_URL}#correct%20horse` });

        expect(input.value).toBe('correct horse');
        expect(passwordStatus.style.display).toBe('flex');
        expect(window.document.activeElement).toBe(decryptBtn);
    });

    it('scrubs the fragment from the URL without adding a history entry', async () => {
        const { window } = await start({ url: `${PAGE_URL}?x=1#correct%20horse` });

        expect(window.location.href).toBe(`${PAGE_URL}?x=1`);
        expect(window.history.length).toBe(1);
    });

    it('scrubs a malformed fragment and leaves the field empty', async () => {
        const { window, input, passwordStatus } = await start({ url: `${PAGE_URL}#%ZZ` });

        expect(window.location.href).toBe(PAGE_URL);
        expect(input.value).toBe('');
        expect(passwordStatus.style.display).toBe('none');
    });
});
