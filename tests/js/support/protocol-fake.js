// The protocol fake for the JS-integration layer (docs/frontend-test-strategy.md
// §5): an in-memory stand-in for the five key-release routes of app.py that
// enforces what the server enforces and answers the way it answers. Held to
// app.py by tests/js/integration/protocol-contract.test.js, which replays the
// contract recorded from the real server against handle().
//
// Deliberately stricter than app.py where the page never takes the other path,
// so a page change that would take it fails loudly instead of passing:
// - CSRF is accepted only as the X-CSRF-Token header, not as a csrf_token form
//   or JSON field, and an Authorization header does not exempt a request (the
//   security invariants assert the page sends that header).
// - /upload without X-Requested-With or a multipart body throws; app.py would
//   answer with an HTML redirect the page's XHR code can't parse.
// - A request to a route the fake doesn't serve throws.
// - /upload/begin or /upload with no logged-in user (state.user null) throws;
//   app.py would answer through its login check, which the page never meets.
// And two checks are left out: /upload takes any file extension (the page
// refuses a disallowed one before sending anything, which the DOM tests
// cover), and accountEmails are trusted as given (app.py also rejects a
// malformed configured address, a server-config error).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CryptoService, bytesToHex } from '../../../static/js/crypto.js';

/**
 * @typedef {import('../../../static/js/crypto.js').Bytes} Bytes
 * @typedef {'/upload/begin' | '/upload' | '/download' | '/release' | '/report_decryption'} Route
 * @typedef {{
 *   method: string,
 *   url: string,
 *   headers?: Record<string, string>,
 *   body?: FormData | string | null,
 * }} FakeRequest
 * @typedef {{ status: number, headers: Record<string, string>, body: string | Bytes }} FakeResponse
 * @typedef {{ status: number, body?: unknown, headers?: Record<string, string> }} InjectedResponse
 * @typedef {InjectedResponse | number | 'network'} Failure
 * @typedef {{
 *   h: string | null,
 *   v: string | null,
 *   owner: string,
 *   attempts: number,
 *   releasedAt: string | null,
 * }} KeyRow - a file_keys row: the server share H and the bound verifier V
 * @typedef {{
 *   name: string,
 *   blob: Bytes | null,
 *   expiryAt: Date | null,
 *   status: 'active' | 'expired',
 *   downloaded: boolean,
 *   receiptHash: string,
 *   decryptionSuccess: boolean | null,
 * }} FileRecord - a files row plus its stored blob (null once deleted)
 * @typedef {{
 *   user: string | null,
 *   keys: Map<string, KeyRow>,
 *   files: Map<string, FileRecord>,
 * }} FakeState
 * @typedef {{
 *   maxAttempts?: number,
 *   burnOnLockout?: boolean,
 *   owner?: string | null,
 *   csrfToken?: string,
 *   notificationsConfigured?: boolean,
 *   accountEmails?: Record<string, string>,
 * }} FakeOptions
 * @typedef {string | { $ref: string }} PathPart
 * @typedef {{
 *   method: string,
 *   path: PathPart[],
 *   headers?: Record<string, string>,
 *   json?: unknown,
 *   form?: Record<string, string | { $ref: string }>,
 *   files?: Record<string, { filename: string, content: string }>,
 * }} RecordedRequest
 * @typedef {{
 *   status: number,
 *   headers: Record<string, string>,
 *   json?: unknown,
 *   bodyBase64?: string,
 * }} RecordedResponse
 * @typedef {{
 *   name: string,
 *   as: string | null,
 *   injected?: boolean,
 *   request: RecordedRequest,
 *   response: RecordedResponse,
 * }} RecordedStep
 * @typedef {{
 *   name: string,
 *   config: {
 *     KEY_RELEASE_MAX_ATTEMPTS: number,
 *     KEY_RELEASE_BURN_ON_LOCKOUT: boolean,
 *     NOTIFICATIONS_CONFIGURED: boolean,
 *   },
 *   steps: RecordedStep[],
 * }} RecordedScenario
 * @typedef {{
 *   csrfToken: string,
 *   defaultUser: string,
 *   accountEmails: Record<string, string>,
 *   scenarios: RecordedScenario[],
 * }} Contract
 */

// What the fake's adapters stand in for the page's origin, and the upload
// progress the XHR adapter reports before it loads.
const ORIGIN = 'http://localhost';
const PROGRESS_STEPS = [0.5, 1];

/**
 * Every response the fake can answer with, as `[route, status, source]`:
 * 'state' when the fake produces it from its own state, 'injected' when
 * only failNext can (413, rate-limit 429). The contract test fails on an
 * entry no scenario records, and on a recorded response missing here.
 * @type {Array<[Route, number, 'state' | 'injected']>}
 */
export const EMITS = [
    ['/upload/begin', 200, 'state'], ['/upload/begin', 403, 'state'],
    ['/upload/begin', 429, 'injected'],
    ['/upload', 200, 'state'], ['/upload', 400, 'state'], ['/upload', 403, 'state'],
    ['/upload', 409, 'state'], ['/upload', 413, 'injected'], ['/upload', 429, 'injected'],
    ['/download', 200, 'state'], ['/download', 302, 'state'], ['/download', 429, 'injected'],
    ['/release', 200, 'state'], ['/release', 400, 'state'], ['/release', 403, 'state'],
    ['/release', 404, 'state'], ['/release', 410, 'state'], ['/release', 429, 'state'],
    ['/release', 429, 'injected'],
    ['/report_decryption', 200, 'state'], ['/report_decryption', 400, 'state'],
    ['/report_decryption', 403, 'state'], ['/report_decryption', 404, 'state'],
    ['/report_decryption', 429, 'injected'],
];

/** @type {Array<[Route, RegExp]>} */
const ROUTES = [
    ['/upload/begin', /^\/upload\/begin$/],
    ['/upload', /^\/upload$/],
    ['/download', /^\/download\/([^/]*)$/],
    ['/release', /^\/release\/([^/]*)$/],
    ['/report_decryption', /^\/report_decryption\/([^/]*)$/],
];

/**
 * The path of a logged request, e.g. '/release/<id>'.
 * @param {{ url: string }} request
 * @returns {string}
 */
export function pathOf(request) {
    return new URL(request.url).pathname;
}

/**
 * The protocol route a path belongs to (a recorded path prefix such as
 * '/release/' counts). Throws for anything else.
 * @param {string} path
 * @returns {Route}
 */
export function routeOf(path) {
    const match = ROUTES.find(([, pattern]) => pattern.test(path));
    if (!match) {
        throw new Error(`protocol fake: no route for ${path}`);
    }
    return match[0];
}

// Paths, not URLs: under the happy-dom environment the global URL is happy-dom's.
const CONTRACT_FILE = join(
    dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'protocol-contract.json');

/**
 * The protocol contract recorded from app.py
 * (tests/js/fixtures/protocol-contract.json).
 * @returns {Contract}
 */
export function loadContract() {
    return JSON.parse(readFileSync(CONTRACT_FILE, 'utf8'));
}

/** @type {Map<string, FakeResponse> | undefined} */
let recordedInjections;

/**
 * The injected responses recorded from app.py (413, rate-limit 429), keyed
 * by `<route> <status>`: failNext's default bodies.
 * @returns {Map<string, FakeResponse>}
 */
function recordedInjection() {
    if (!recordedInjections) {
        recordedInjections = new Map();
        for (const step of loadContract().scenarios.flatMap((scenario) => scenario.steps)) {
            if (!step.injected) continue;
            const { status, headers, json, bodyBase64 } = step.response;
            recordedInjections.set(`${routeOf(String(step.request.path[0]))} ${status}`, {
                status,
                headers: { ...headers },
                body: json !== undefined
                    ? JSON.stringify(json)
                    : new Uint8Array(Buffer.from(bodyBase64 ?? '', 'base64')),
            });
        }
    }
    return recordedInjections;
}

/**
 * Whether a Content-Type is JSON the way Flask's `is_json` decides it:
 * `application/json` or `application/*+json`, parameters ignored.
 * @param {string | undefined} contentType
 * @returns {boolean}
 */
export function isJsonContentType(contentType) {
    const mimetype = (contentType ?? '').split(';')[0].trim().toLowerCase();
    return mimetype === 'application/json'
        || (mimetype.startsWith('application/') && mimetype.endsWith('+json'));
}

/**
 * Key material (H, V, receipt hash) travels as 64 lowercase hex chars.
 * @param {unknown} value
 * @returns {value is string}
 */
function isKeyMaterial(value) {
    return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

/**
 * `.strip().lower()` as app.py applies it to submitted key material.
 * @param {unknown} value
 * @returns {unknown}
 */
function canonicalHex(value) {
    return typeof value === 'string' ? value.trim().toLowerCase() : value;
}

/**
 * `datetime.fromisoformat` for the `datetime-local` values the page sends;
 * anything unparseable is ignored, as app.py does.
 * @param {string | null} value
 * @returns {Date | null}
 */
function parseExpiry(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * @param {number} status
 * @param {unknown} body
 * @returns {FakeResponse}
 */
function json(status, body) {
    return { status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

/** @returns {FakeResponse} */
function redirectHome() {
    return {
        status: 302,
        headers: { 'Content-Type': 'text/html; charset=utf-8', Location: '/' },
        body: '',
    };
}

/**
 * Build a protocol fake. One instance holds one server's state, so a share
 * begun on the index page can be released on the view page.
 * @param {FakeOptions} [opts]
 */
export function makeProtocolFake(opts = {}) {
    const maxAttempts = opts.maxAttempts ?? 1;
    const burnOnLockout = opts.burnOnLockout ?? true;
    const csrfToken = opts.csrfToken ?? 'fixture-csrf-token';
    // Defaults mirror the fixture environment: SMTP configured, and only
    // notifyuser has an account email.
    const notificationsConfigured = opts.notificationsConfigured ?? true;
    const accountEmails = opts.accountEmails ?? { notifyuser: 'notify@example.test' };

    /** @type {FakeState} */
    const state = {
        user: opts.owner === undefined ? 'testuser' : opts.owner,
        keys: new Map(),
        files: new Map(),
    };
    /** @type {Array<{ method: string, url: string, headers: Record<string, string>, body: FormData | string | null }>} */
    const log = [];
    /** @type {Map<Route, Failure[]>} */
    const failures = new Map();

    /**
     * Queue a one-shot failure for the next request to `route`. A bare 413 or
     * 429 (or `{ status }` without a body) answers with the body recorded from
     * app.py; 'network' makes the request fail as a dropped connection.
     * @param {Route} route
     * @param {Failure} failure
     */
    function failNext(route, failure) {
        const queue = failures.get(route) ?? [];
        queue.push(failure);
        failures.set(route, queue);
    }

    /**
     * @param {Route} route
     * @param {Failure} failure
     * @returns {FakeResponse}
     */
    function injected(route, failure) {
        if (failure === 'network') {
            throw new TypeError('Failed to fetch');
        }
        const { status, body, headers } = typeof failure === 'number' ? { status: failure } : failure;
        if (body === undefined) {
            const recorded = recordedInjection().get(`${route} ${status}`);
            if (!recorded) {
                throw new Error(`protocol fake: no recorded ${status} body for ${route}; pass one`);
            }
            return { ...recorded, headers: { ...recorded.headers, ...headers } };
        }
        if (typeof body === 'string') {
            return { status, headers: { 'Content-Type': 'text/plain', ...headers }, body };
        }
        const response = json(status, body);
        return { ...response, headers: { ...response.headers, ...headers } };
    }

    /**
     * Create the files row of a finished upload.
     * @param {string} fileId
     * @param {{ name: string, blob: Bytes, expiry: string | null, receiptHash: string }} upload
     */
    function storeFile(fileId, { name, blob, expiry, receiptHash }) {
        state.files.set(fileId, {
            name,
            blob,
            expiryAt: parseExpiry(expiry),
            status: 'active',
            downloaded: false,
            receiptHash,
            decryptionSuccess: null,
        });
    }

    /** @param {FileRecord} file */
    function isExpired(file) {
        return file.status === 'expired' || (file.expiryAt !== null && new Date() >= file.expiryAt);
    }

    /**
     * check_and_handle_expiry: an expired file loses its blob and key share.
     * @param {string} fileId
     * @param {FileRecord} file
     */
    function expire(fileId, file) {
        file.blob = null;
        file.status = 'expired';
        state.keys.delete(fileId);
    }

    /**
     * _get_notification_preferences: an open notification goes only to the
     * account's own configured email, and only when SMTP is set up. Returns
     * the server's error message, or null when the request is acceptable.
     * @param {string} user
     * @param {(field: string) => string | null} field
     * @returns {string | null}
     */
    function notificationPreferenceError(user, field) {
        const requested = ['1', 'true', 'yes', 'on']
            .includes((field('notify_on_open') ?? '').trim().toLowerCase());
        if (!requested) return null;
        if (!notificationsConfigured) {
            return 'Open notifications are not configured on this server';
        }
        const configured = accountEmails[user];
        if (!configured) {
            return 'Configure an account email before enabling open notifications';
        }
        const asked = (field('notification_email') ?? '').trim();
        if (asked && asked !== configured) {
            return 'Open notifications can only be sent to your configured account email';
        }
        return null;
    }

    /** @param {Record<string, string>} headers */
    function hasCsrf(headers) {
        return headers['x-csrf-token'] === csrfToken;
    }

    /** @param {string} route */
    function requireUser(route) {
        if (!state.user) {
            throw new Error(`protocol fake: ${route} needs a logged-in user (state.user)`);
        }
        return state.user;
    }

    /**
     * `request.get_json(silent=True)` checked for a dict, as /release and
     * /report_decryption do: the parsed body only for a JSON Content-Type
     * and a valid JSON object, else null.
     * @param {Record<string, string>} headers
     * @param {FakeRequest['body']} body
     * @returns {Record<string, unknown> | null}
     */
    function jsonObject(headers, body) {
        if (!isJsonContentType(headers['content-type']) || typeof body !== 'string') {
            return null;
        }
        try {
            const data = JSON.parse(body);
            return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
        } catch {
            return null;
        }
    }

    /** @param {Record<string, string>} headers */
    function uploadBegin(headers) {
        const owner = requireUser('/upload/begin');
        if (!hasCsrf(headers)) {
            return json(403, { error: 'CSRF validation failed' });
        }
        const fileId = crypto.randomUUID();
        const h = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
        state.keys.set(fileId, { h, v: null, owner, attempts: 0, releasedAt: null });
        return json(200, { file_id: fileId, h });
    }

    /**
     * @param {Record<string, string>} headers
     * @param {FakeRequest['body']} body
     */
    async function upload(headers, body) {
        const owner = requireUser('/upload');
        if (headers['x-requested-with'] !== 'XMLHttpRequest' || !(body instanceof FormData)) {
            throw new Error('protocol fake: /upload speaks only the XHR multipart form the page sends');
        }
        if (!hasCsrf(headers)) {
            return json(403, { error: 'CSRF validation failed' });
        }
        /** @param {string} field */
        const field = (field) => {
            const value = body.get(field);
            return typeof value === 'string' ? value : null;
        };
        const notificationError = notificationPreferenceError(owner, field);
        if (notificationError) {
            return json(400, { error: notificationError });
        }
        const fileId = field('file_id')?.trim() || null;
        const keyVerifier = canonicalHex(field('key_verifier'));
        const receiptHash = canonicalHex(field('receipt_hash'));
        if (!fileId || !isKeyMaterial(keyVerifier) || !isKeyMaterial(receiptHash)) {
            return json(400, { error: 'Invalid key-release upload' });
        }
        const key = state.keys.get(fileId);
        if (!key || key.v !== null || key.releasedAt !== null || state.files.has(fileId)) {
            return json(409, { error: 'Unknown or already finalized key-release upload' });
        }
        if (key.owner !== owner) {
            return json(403, { error: 'Key-release share belongs to another user' });
        }

        const noteText = field('note_text');
        const isText = field('type') === 'text' && Boolean(noteText);
        /** @type {Bytes} */
        let blob;
        let name;
        if (isText) {
            blob = Uint8Array.from(atob(noteText ?? ''), (c) => c.charCodeAt(0));
            name = 'Secret Note';
        } else {
            const file = body.get('file');
            if (!(file instanceof Blob)) {
                throw new Error('protocol fake: /upload without a file or a note');
            }
            blob = new Uint8Array(await file.arrayBuffer());
            name = file instanceof File ? file.name : 'blob';
        }

        key.v = keyVerifier;
        storeFile(fileId, { name, blob, expiry: field('expiry'), receiptHash });
        return json(200, {
            file_id: fileId,
            share_link: `${ORIGIN}/view/${fileId}`,
            type: isText ? 'text' : 'file',
        });
    }

    /** @param {string} fileId */
    function download(fileId) {
        const file = state.files.get(fileId);
        if (!file || file.downloaded) {
            return redirectHome();
        }
        if (isExpired(file)) {
            expire(fileId, file);
            return redirectHome();
        }
        const blob = file.blob ?? new Uint8Array();
        file.downloaded = true;
        file.blob = null;
        return {
            status: 200,
            headers: {
                'Content-Type': 'application/octet-stream',
                'Content-Disposition': `attachment; filename="${file.name}"`,
            },
            body: blob,
        };
    }

    /** @param {string} fileId */
    function lockOut(fileId) {
        if (burnOnLockout) {
            state.keys.delete(fileId);
        }
        const file = state.files.get(fileId);
        if (file && file.decryptionSuccess === null) {
            file.decryptionSuccess = false;
        }
        return json(429, { error: 'Too many attempts' });
    }

    /**
     * attempt_key_release: the checks in the server's order.
     * @param {string} fileId
     * @param {Record<string, string>} headers
     * @param {FakeRequest['body']} body
     */
    function release(fileId, headers, body) {
        const data = jsonObject(headers, body);
        if (!data) {
            return json(400, { error: 'Invalid request' });
        }
        const v = canonicalHex(data.v);
        if (!isKeyMaterial(v)) {
            return json(400, { error: 'Invalid request' });
        }

        const file = state.files.get(fileId);
        const key = state.keys.get(fileId);
        if (!file) {
            return json(404, { error: 'Not found' });
        }
        if (key && key.releasedAt !== null) {
            return json(410, { error: 'Key already released' });
        }
        if (!key || key.v === null) {
            return json(404, { error: 'Not found' });
        }
        if (key.attempts >= maxAttempts) {
            return lockOut(fileId);
        }
        if (isExpired(file)) {
            expire(fileId, file);
            return json(410, { error: 'File has expired' });
        }
        if (key.v === v) {
            const h = /** @type {string} */ (key.h);
            key.releasedAt = new Date().toISOString();
            key.h = null;
            key.v = null;
            return json(200, { h });
        }
        key.attempts += 1;
        if (key.attempts >= maxAttempts) {
            return lockOut(fileId);
        }
        return json(403, {
            error: 'Incorrect password',
            attempts_remaining: maxAttempts - key.attempts,
        });
    }

    /**
     * @param {string} fileId
     * @param {Record<string, string>} headers
     * @param {FakeRequest['body']} body
     */
    async function reportDecryption(fileId, headers, body) {
        const file = state.files.get(fileId);
        if (!file) {
            return json(404, { error: 'File not found' });
        }
        const report = jsonObject(headers, body);
        if (!report) {
            return json(400, { error: 'Invalid request' });
        }
        const receipt = canonicalHex(report.receipt);
        if (!('success' in report) || typeof report.success !== 'boolean' || !isKeyMaterial(receipt)) {
            return json(400, { error: 'Invalid request' });
        }
        const receiptBytes = Uint8Array.from(receipt.match(/../g) ?? [], (byte) => parseInt(byte, 16));
        const digest = bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', receiptBytes)));
        if (digest !== file.receiptHash) {
            return json(403, { error: 'Invalid receipt' });
        }
        if (file.decryptionSuccess === null) {
            file.decryptionSuccess = report.success;
        }
        return json(200, { status: 'recorded' });
    }

    /**
     * The raw core: one request in, the server's response out. Logs the
     * request first, so even an injected network failure is on record.
     * @param {FakeRequest} request
     * @returns {Promise<FakeResponse>}
     */
    async function handle(request) {
        /** @type {Record<string, string>} */
        const headers = {};
        for (const [name, value] of Object.entries(request.headers ?? {})) {
            headers[name.toLowerCase()] = value;
        }
        const method = request.method.toUpperCase();
        const body = request.body ?? null;
        const url = new URL(request.url, ORIGIN);
        log.push({ method, url: url.href, headers: { ...request.headers }, body });

        const route = routeOf(url.pathname);
        const expected = route === '/download' ? 'GET' : 'POST';
        if (method !== expected) {
            throw new Error(`protocol fake: ${method} ${url.pathname} (only ${expected} is served)`);
        }
        const fileId = decodeURIComponent(url.pathname.match(/[^/]*$/)?.[0] ?? '');

        const failure = failures.get(route)?.shift();
        /** @type {FakeResponse} */
        let response;
        if (failure !== undefined) {
            response = injected(route, failure);
        } else if (route === '/upload/begin') {
            response = uploadBegin(headers);
        } else if (route === '/upload') {
            response = await upload(headers, body);
        } else if (route === '/download') {
            response = download(fileId);
        } else if (route === '/release') {
            response = release(fileId, headers, body);
        } else {
            response = await reportDecryption(fileId, headers, body);
        }
        // H-carrying endpoints are never cached (no_store_key_release_responses).
        if (route === '/upload/begin' || route === '/release') {
            response.headers['Cache-Control'] = 'no-store';
        }
        return response;
    }

    /**
     * A browser-style fetch over handle(): follows a 302 the way the browser
     * does (the fake doesn't serve the target, so it stands in an empty page).
     * @param {RequestInfo | URL} input
     * @param {RequestInit} [init]
     * @returns {Promise<Response>}
     */
    async function fakeFetch(input, init = {}) {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        /** @type {Record<string, string>} */
        const headers = {};
        new Headers(init.headers).forEach((value, name) => { headers[name] = value; });
        const body = init.body ?? null;
        if (body !== null && typeof body !== 'string' && !(body instanceof FormData)) {
            throw new Error('protocol fake: only string and FormData bodies are supported');
        }
        const response = await handle({ method: init.method ?? 'GET', url, headers, body });
        if (response.status >= 300 && response.status < 400 && response.headers.Location) {
            return browserResponse(new Response('', {
                status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' },
            }), new URL(response.headers.Location, ORIGIN).href, true);
        }
        return browserResponse(
            new Response(response.body.length === 0 ? null : response.body,
                { status: response.status, headers: response.headers }),
            new URL(url, ORIGIN).href, false);
    }

    /**
     * A browser-style XMLHttpRequest over handle(), firing upload.onprogress
     * (happy-dom's own XHR never does) at each of PROGRESS_STEPS.
     */
    class FakeXMLHttpRequest {
        constructor() {
            /** @type {{ onprogress: ((event: { lengthComputable: boolean, loaded: number, total: number }) => void) | null }} */
            this.upload = { onprogress: null };
            /** @type {(() => void) | null} */
            this.onload = null;
            /** @type {(() => void) | null} */
            this.onerror = null;
            this.status = 0;
            this.responseText = '';
            this.method = 'GET';
            this.url = '';
            /** @type {Record<string, string>} */
            this.headers = {};
        }

        /**
         * @param {string} method
         * @param {string} url
         */
        open(method, url) {
            this.method = method;
            this.url = url;
        }

        /**
         * @param {string} name
         * @param {string} value
         */
        setRequestHeader(name, value) {
            this.headers[name] = value;
        }

        /** @param {FormData | string | null} [body] */
        send(body = null) {
            const request = { method: this.method, url: this.url, headers: this.headers, body };
            (async () => {
                let response;
                try {
                    response = await handle(request);
                } catch (err) {
                    if (!(err instanceof TypeError)) throw err;
                    this.onerror?.();
                    return;
                }
                for (const step of PROGRESS_STEPS) {
                    await Promise.resolve();
                    this.upload.onprogress?.({ lengthComputable: true, loaded: step * 100, total: 100 });
                }
                this.status = response.status;
                this.responseText = typeof response.body === 'string'
                    ? response.body : new TextDecoder().decode(response.body);
                this.onload?.();
            })();
        }
    }

    /**
     * Build a valid, uploaded share directly — for view-only tests, which
     * start where the index page left off. Returns its file_id. The DOM
     * layer passes its stub crypto, so the share matches what its page derives.
     * @param {{ password: string, plaintext: string | Bytes, name?: string, expiry?: string }} share
     * @param {Pick<CryptoService, 'encrypt' | 'receiptHash'>} [cryptoService]
     * @returns {Promise<string>}
     */
    async function seedShare({ password, plaintext, name = 'report.pdf', expiry }, cryptoService = new CryptoService()) {
        /** @type {Bytes} */
        const h = crypto.getRandomValues(new Uint8Array(32));
        const data = typeof plaintext === 'string' ? new TextEncoder().encode(plaintext) : plaintext;
        const { blob, verifier, receipt } = await cryptoService.encrypt(data, password, h);
        const fileId = crypto.randomUUID();
        state.keys.set(fileId, {
            h: bytesToHex(h), v: bytesToHex(verifier),
            owner: state.user ?? 'testuser', attempts: 0, releasedAt: null,
        });
        storeFile(fileId, {
            name, blob, expiry: expiry ?? null, receiptHash: await cryptoService.receiptHash(receipt),
        });
        return fileId;
    }

    return {
        handle,
        fetch: fakeFetch,
        // The page types its dependency as the browser's XMLHttpRequest; the
        // fake implements the part of it the page uses.
        XMLHttpRequest: /** @type {typeof XMLHttpRequest} */ (/** @type {unknown} */ (FakeXMLHttpRequest)),
        state,
        log,
        failNext,
        seedShare,
    };
}

/**
 * Give a constructed Response the `url` and `redirected` a fetched one has.
 * @param {Response} response
 * @param {string} url
 * @param {boolean} redirected
 * @returns {Response}
 */
function browserResponse(response, url, redirected) {
    Object.defineProperty(response, 'url', { value: url });
    Object.defineProperty(response, 'redirected', { value: redirected });
    return response;
}
