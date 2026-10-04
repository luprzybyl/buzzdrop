// PROTOTYPE — exercises the init(root, deps) shape from
// static/js/PROTOTYPE-index-page.mjs: real crypto.js + a protocol fake at the
// transport seam. Run: npx vitest run
import { describe, it, expect, beforeEach } from 'vitest';
import { initIndexPage } from '../../../static/js/PROTOTYPE-index-page.mjs';
import { CryptoService, bytesToHex, hexToBytes } from '../../../static/js/crypto.js';

// Stand-in for tests/js/fixtures/html/index--logged-in-empty.html (the
// generator from the DOM-fixtures decision doesn't exist yet). Only the ids
// the slice touches.
const FIXTURE = `
  <meta name="csrf-token" content="FIXTURE-CSRF">
  <textarea id="note-text"></textarea>
  <input id="shared-password" type="password">
  <input id="shared-expiry" type="datetime-local">
  <button id="share-action-btn" type="button">Share</button>
  <div id="share-progress-container" style="display:none">
    <div id="share-progress-bar" style="width:0%"></div>
    <span id="share-progress-text">0%</span>
  </div>
  <script id="upload-endpoints-json" type="application/json">
    {"uploadBeginUrl": "/upload/begin", "uploadUrl": "/upload"}
  </script>`;

/** Minimal protocol fake: speaks /upload/begin (fetch) and /upload (XHR). */
function makeProtocolFake({ uploadStatus = 200, uploadBody } = {}) {
    const h = crypto.getRandomValues(new Uint8Array(32));
    const log = []; // every request, for the security-invariant assertions
    const fake = {
        h, log,
        fetch: async (url, init = {}) => {
            log.push({ via: 'fetch', url, headers: init.headers ?? {} });
            if (url === '/upload/begin') {
                return new Response(JSON.stringify({ file_id: 'f-1', h: bytesToHex(h) }));
            }
            return new Response('{}', { status: 404 });
        },
        // happy-dom's interceptor never fires upload.onprogress, so the
        // fake supplies its own XHR class through the same deps seam.
        XMLHttpRequest: class FakeXHR {
            constructor() { this.upload = {}; this.headers = {}; }
            open(method, url) { this.url = url; }
            setRequestHeader(k, v) { this.headers[k] = v; }
            send(body) {
                log.push({ via: 'xhr', url: this.url, headers: this.headers, body });
                queueMicrotask(() => {
                    this.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 2 });
                    fake.progressSeen = document.getElementById('share-progress-text').textContent;
                    this.status = uploadStatus;
                    this.responseText = uploadBody ?? JSON.stringify({ file_id: 'f-1' });
                    this.onload();
                });
            }
        },
    };
    return fake;
}

function setup(fakeOpts) {
    document.body.innerHTML = FIXTURE;
    const fake = makeProtocolFake(fakeOpts);
    const effects = { navigated: [], alerts: [] };
    let done;
    const settled = new Promise((r) => { done = r; });
    const deps = {
        fetch: fake.fetch,
        XMLHttpRequest: fake.XMLHttpRequest,
        crypto: new CryptoService(), // real crypto, real 600k PBKDF2
        navigate: (url) => { effects.navigated.push(url); done(); },
        alert: (msg) => { effects.alerts.push(msg); done(); },
    };
    initIndexPage(document, deps);
    return { fake, effects, settled };
}

const fill = (note, pw) => {
    document.getElementById('note-text').value = note;
    document.getElementById('shared-password').value = pw;
};
const click = () => document.getElementById('share-action-btn').click();
const PASSWORD = 'correct-horse-battery-staple';

describe('note upload (prototype slice)', () => {
    it('runs the two-phase upload and hands the password to /success via the fragment', async () => {
        const { fake, effects, settled } = setup();
        fill('top secret', PASSWORD);
        click();
        await settled;

        expect(effects.navigated).toEqual([`/success/f-1#${encodeURIComponent(PASSWORD)}`]);
        expect(fake.progressSeen).toBe('50%');

        const upload = fake.log.find((r) => r.via === 'xhr');
        expect(upload.headers['X-CSRF-Token']).toBe('FIXTURE-CSRF');
        expect(upload.body.get('file_id')).toBe('f-1');
        expect(upload.body.get('type')).toBe('text');

        // The blob really decrypts under the H the fake handed out.
        const blob = Uint8Array.from(atob(upload.body.get('note_text')), (c) => c.charCodeAt(0));
        const { data } = await new CryptoService().decrypt(blob, PASSWORD, fake.h);
        expect(new TextDecoder().decode(data)).toBe('top secret');
    });

    it('never sends the password in any request (security invariant)', async () => {
        const { fake, settled } = setup();
        fill('top secret', PASSWORD);
        click();
        await settled;

        const wire = JSON.stringify(fake.log.map((r) => ({
            url: r.url, headers: r.headers,
            body: r.body ? [...r.body.entries()] : null,
        })));
        expect(wire).not.toContain(PASSWORD);
    });

    it('surfaces a 403 and restores the share button for a retry', async () => {
        const { effects, settled } = setup({ uploadStatus: 403, uploadBody: '{"error":"Not your share"}' });
        fill('top secret', PASSWORD);
        click();
        await settled;

        expect(effects.alerts).toEqual(['Not your share']);
        expect(effects.navigated).toEqual([]);
        const btn = document.getElementById('share-action-btn');
        expect(btn.disabled).toBe(false);
        expect(document.getElementById('share-progress-container').style.display).toBe('none');
    });
});
