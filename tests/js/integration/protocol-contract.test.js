// Holds the protocol fake to the contract recorded from app.py
// (docs/frontend-test-strategy.md §6). Every scenario in
// tests/js/fixtures/protocol-contract.json is replayed against the fake's raw
// core, handle(), and each response must match the recorded one. When app.py
// changes a response, `npm run fixtures` re-records the contract and this test
// stays red until the fake matches.
import { describe, it, expect } from 'vitest';
import { EMITS, loadContract, makeProtocolFake, routeOf } from '../support/protocol-fake.js';

/**
 * @typedef {import('../support/protocol-fake.js').RecordedRequest} RecordedRequest
 * @typedef {import('../support/protocol-fake.js').RecordedResponse} RecordedResponse
 * @typedef {import('../support/protocol-fake.js').RecordedStep} RecordedStep
 */

const contract = loadContract();

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const HEX64 = /\b[0-9a-f]{64}\b/g;

/**
 * The same normalisation record_protocol_contract.py applies.
 * @param {unknown} value
 * @returns {unknown}
 */
function normalise(value) {
    if (typeof value === 'string') {
        return value.replace(UUID, '<uuid>').replace(HEX64, '<hex64>');
    }
    if (Array.isArray(value)) {
        return value.map(normalise);
    }
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalise(v)]));
    }
    return value;
}

/**
 * Replace `{"$ref": "<step>.<field>"}` with that step's response field, as the
 * fake answered it.
 * @param {unknown} value
 * @param {Record<string, Record<string, unknown>>} responses
 * @returns {unknown}
 */
function resolve(value, responses) {
    if (Array.isArray(value)) {
        return value.map((item) => resolve(item, responses));
    }
    if (value && typeof value === 'object') {
        if ('$ref' in value && typeof value.$ref === 'string') {
            const [step, field] = value.$ref.split('.');
            return responses[step][field];
        }
        return Object.fromEntries(
            Object.entries(value).map(([k, v]) => [k, resolve(v, responses)]));
    }
    return value;
}

/**
 * Build the request the browser would send for a recorded one.
 * @param {RecordedRequest} recorded - with every $ref already resolved
 * @returns {import('../support/protocol-fake.js').FakeRequest}
 */
function toFakeRequest(recorded) {
    /** @type {FormData | string | null} */
    let body = null;
    if (recorded.json != null) {
        body = JSON.stringify(recorded.json);
    }
    if (recorded.form || recorded.files) {
        const formData = new FormData();
        for (const [field, value] of Object.entries(recorded.form ?? {})) {
            formData.append(field, String(value));
        }
        for (const [field, upload] of Object.entries(recorded.files ?? {})) {
            formData.append(field, new File([upload.content], upload.filename));
        }
        body = formData;
    }
    return {
        method: recorded.method,
        url: `http://localhost${recorded.path.join('')}`,
        headers: recorded.headers ?? {},
        body,
    };
}

/**
 * The fake's response in the contract's shape, as _record() builds it.
 * @param {string} path
 * @param {import('../support/protocol-fake.js').FakeResponse} response
 * @returns {RecordedResponse}
 */
function toRecorded(path, response) {
    /** @type {RecordedResponse} */
    const recorded = {
        status: response.status,
        headers: { 'Content-Type': response.headers['Content-Type'] },
    };
    if ('Location' in response.headers) {
        recorded.headers.Location = response.headers.Location;
    }
    if (path.startsWith('/release/')) {
        recorded.headers['Cache-Control'] = response.headers['Cache-Control'];
    }
    const bytes = typeof response.body === 'string'
        ? new TextEncoder().encode(response.body) : response.body;
    if (response.headers['Content-Type'] === 'application/json') {
        recorded.json = JSON.parse(new TextDecoder().decode(bytes));
    } else if (response.status < 300 || response.status >= 400) {
        recorded.bodyBase64 = Buffer.from(bytes).toString('base64');
    }
    return /** @type {RecordedResponse} */ (normalise(recorded));
}

/**
 * Whether the fake answers a step from its state or by injection.
 * @param {RecordedStep} step
 * @returns {'state' | 'injected'}
 */
function source(step) {
    return step.injected ? 'injected' : 'state';
}

describe('protocol fake replays the recorded contract', () => {
    for (const scenario of contract.scenarios) {
        it(scenario.name, async () => {
            const fake = makeProtocolFake({
                maxAttempts: scenario.config.KEY_RELEASE_MAX_ATTEMPTS,
                burnOnLockout: scenario.config.KEY_RELEASE_BURN_ON_LOCKOUT,
                owner: contract.defaultUser,
                csrfToken: contract.csrfToken,
            });
            /** @type {Record<string, Record<string, unknown>>} */
            const responses = {};
            for (const step of scenario.steps) {
                const request = /** @type {RecordedRequest} */ (resolve(step.request, responses));
                const path = request.path.join('');
                fake.state.user = step.as;
                if (step.injected) {
                    fake.failNext(routeOf(path), step.response.status);
                }
                const response = await fake.handle(toFakeRequest(request));
                const recorded = toRecorded(path, response);

                expect(recorded, `${scenario.name}/${step.name}`).toEqual(step.response);
                expect(EMITS, `${scenario.name}/${step.name}: undeclared response`)
                    .toContainEqual([routeOf(path), response.status, source(step)]);
                if (response.headers['Content-Type'] === 'application/json') {
                    responses[step.name] = JSON.parse(String(response.body));
                }
            }
        });
    }
});

describe('the contract covers the fake', () => {
    // The completeness rule: every response the fake can emit has a scenario.
    const recorded = contract.scenarios.flatMap((scenario) => scenario.steps.map(
        (step) => JSON.stringify(
            [routeOf(String(step.request.path[0])), step.response.status, source(step)])));
    for (const [route, status, from] of EMITS) {
        it(`${route} ${status} (${from}) is recorded`, () => {
            expect(recorded).toContain(JSON.stringify([route, status, from]));
        });
    }
});

describe('fetch adapter', () => {
    it('follows the 302 a consumed download answers', async () => {
        const fake = makeProtocolFake();
        const fileId = await fake.seedShare({ password: 'pw', plaintext: 'hello' });

        const first = await fake.fetch(`/download/${fileId}`);
        expect(first.status).toBe(200);
        expect(first.redirected).toBe(false);

        const second = await fake.fetch(`/download/${fileId}`);
        expect(second.status).toBe(200);
        expect(second.redirected).toBe(true);
        expect(second.url).toBe('http://localhost/');
        expect(fake.log.map((r) => r.url)).toEqual([
            `http://localhost/download/${fileId}`, `http://localhost/download/${fileId}`]);
    });

    it('rejects like a dropped connection on an injected network failure', async () => {
        const fake = makeProtocolFake();
        fake.failNext('/upload/begin', 'network');

        await expect(fake.fetch('/upload/begin', { method: 'POST' })).rejects.toThrow(TypeError);
        expect(fake.log).toHaveLength(1);
    });
});

describe('XMLHttpRequest adapter', () => {
    /**
     * Send one request through the fake's XHR class.
     * @param {ReturnType<typeof makeProtocolFake>} fake
     * @param {FormData} body
     */
    function send(fake, body) {
        const xhr = new fake.XMLHttpRequest();
        /** @type {number[]} */
        const progress = [];
        const done = new Promise((resolve) => {
            xhr.upload.onprogress = (e) => progress.push(e.loaded / e.total);
            xhr.onload = () => resolve('load');
            xhr.onerror = () => resolve('error');
        });
        xhr.open('POST', '/upload');
        xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
        xhr.setRequestHeader('X-CSRF-Token', contract.csrfToken);
        xhr.send(body);
        return { xhr, progress, done };
    }

    it('fires upload.onprogress before onload', async () => {
        const fake = makeProtocolFake();
        const { xhr, progress, done } = send(fake, new FormData());

        expect(await done).toBe('load');
        expect(progress).toEqual([0.5, 1]);
        expect(xhr.status).toBe(400);
        expect(JSON.parse(xhr.responseText)).toEqual({ error: 'Invalid key-release upload' });
    });

    it('calls onerror on an injected network failure', async () => {
        const fake = makeProtocolFake();
        fake.failNext('/upload', 'network');
        const { progress, done } = send(fake, new FormData());

        expect(await done).toBe('error');
        expect(progress).toEqual([]);
    });
});

// Write-once state behind identical responses: the contract records the same
// 200 / 429 either way, so these check the fake's state directly.
describe('decryption result', () => {
    const RECEIPT = '33'.repeat(32);
    const V = '11'.repeat(32);

    /**
     * Upload a share through handle() and return its file_id.
     * @param {ReturnType<typeof makeProtocolFake>} fake
     */
    async function uploadShare(fake) {
        const headers = { 'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': contract.csrfToken };
        const begin = await fake.handle({ method: 'POST', url: '/upload/begin', headers });
        const fileId = JSON.parse(String(begin.body)).file_id;
        const digest = await crypto.subtle.digest('SHA-256', Buffer.from(RECEIPT, 'hex'));
        const form = new FormData();
        form.append('file_id', fileId);
        form.append('key_verifier', V);
        form.append('receipt_hash', Buffer.from(digest).toString('hex'));
        form.append('file', new File(['ciphertext'], 'report.pdf'));
        const upload = await fake.handle({ method: 'POST', url: '/upload', headers, body: form });
        expect(upload.status).toBe(200);
        return fileId;
    }

    /**
     * @param {ReturnType<typeof makeProtocolFake>} fake
     * @param {string} fileId
     * @param {boolean} success
     */
    function report(fake, fileId, success) {
        return fake.handle({
            method: 'POST',
            url: `/report_decryption/${fileId}`,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ success, receipt: RECEIPT }),
        });
    }

    it('keeps the first valid report', async () => {
        const fake = makeProtocolFake();
        const fileId = await uploadShare(fake);

        expect((await report(fake, fileId, true)).status).toBe(200);
        expect((await report(fake, fileId, false)).status).toBe(200);
        expect(fake.state.files.get(fileId)?.decryptionSuccess).toBe(true);
    });

    it('records a lockout as a failure that a later report does not overwrite', async () => {
        const fake = makeProtocolFake({ maxAttempts: 1 });
        const fileId = await uploadShare(fake);

        const locked = await fake.handle({
            method: 'POST',
            url: `/release/${fileId}`,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ v: '22'.repeat(32) }),
        });
        expect(locked.status).toBe(429);
        expect(fake.state.files.get(fileId)?.decryptionSuccess).toBe(false);

        expect((await report(fake, fileId, true)).status).toBe(200);
        expect(fake.state.files.get(fileId)?.decryptionSuccess).toBe(false);
    });
});
