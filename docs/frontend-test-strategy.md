# Frontend test strategy

The locked test strategy for Buzzdrop's browser JS (`static/js/`). Every tooling, layering, fixture, test-profile and CI decision is here, so the harnesses and tests can be built without re-deciding anything. Each section states the decision as it stands now and links to the ticket that holds its reasoning. Charted on the map [Wayfinder: frontend & JS test strategy](https://github.com/luprzybyl/buzzdrop/issues/154).

## 1. Layers

Each behaviour is tested **once**, at the **lowest layer that can show it**.

| Layer | What it tests | Runner | Environment |
|---|---|---|---|
| **Unit** | Pure modules on their own | `node --test` | Node |
| **DOM** | One page module against its real markup, network stubbed | Vitest | happy-dom |
| **JS integration** | Page modules + real `crypto.js` against the protocol fake | Vitest | happy-dom |
| **E2E** | What needs a real browser *and* the real server | Playwright | Chromium, Firefox, WebKit against the Buzzdrop Docker image |

"Integration" means the JS-integration layer and nothing else. The Python suite (`tests/`) is not changed by this strategy, except for the generators and CI steps named below.

## 2. Runners and tooling

From [Choose the runner and DOM environment for DOM + JS-integration tests](https://github.com/luprzybyl/buzzdrop/issues/155).

- **Unit:** keep `node --test` for `tests/js/*.test.mjs`. These files don't run under Vitest.
- **DOM + integration:** Vitest with happy-dom, pinned at **>= 20.8.9** (security advisories). Vitest's `include` covers only `tests/js/dom/**` and `tests/js/integration/**`.
- **jsdom is rejected.** It puts byte arrays in two realms, so `TextEncoder`/`subtle` output fails `instanceof Uint8Array`, which breaks `crypto.js`. It also has no navigation, and `new Response(blob)` throws.
- Real 600k-iteration PBKDF2 runs in happy-dom at acceptable cost. Tests don't stub the KDF.
- **Node 24** via a committed `.nvmrc`.
- **npm scripts:** `test:unit` (today's `test:js`, renamed), `test:dom` (`vitest run`), `test` (both), `fixtures` (regenerates the DOM fixtures and the protocol contract).
- **Coverage** is reported, not gated.

## 3. Testability refactor of page scripts

From [What shape should the testability refactor of page scripts take?](https://github.com/luprzybyl/buzzdrop/issues/158). Production JS may be refactored to make it testable, as long as behaviour doesn't change.

- **Split:** each page gets a side-effect-free module (`index-page.mjs`, `view-page.mjs`, `success-page.mjs`, `confirm-download-page.mjs`, `hero-flow-page.mjs`) exporting `init<Page>(root, deps)` and `browserDeps()`. The existing entry files (`main.js`, `view.js`, `success.js`, `confirm-download.js`, `hero-flow.js`) shrink to `init<Page>(document, browserDeps())`. Template `<script>` tags, SRI attributes and JSON config blocks stay as they are. **Tests import the page module, never the entry.**
- **State lives in the `init` closure** (e.g. `uploadInProgress`, `activeShareMode`, parsed config, CSRF token). Every `init()` is a fresh page, and no `vi.resetModules()` is needed.
- **Dependencies (`deps`):**

  | Passed in | Why |
  |---|---|
  | `fetch`, `XMLHttpRequest` | Network-level seams, so the protocol fake sees real URLs, headers and bodies. The XHR class also supplies `upload.onprogress`, which happy-dom never fires. |
  | `navigate(url)`, `alert(msg)` | Effects the tests observe |
  | `crypto` (`CryptoService`) | Integration tests pass the real one. DOM tests may stub it. |

  **Not passed in:** the DOM (it comes in as `root`), `history`, `clipboard`, and reads of `location`. happy-dom models these, and tests assert on them directly.
- **`success.js` and `confirm-download.js` become ES modules** (`type="module"` in their templates).
- **Upload `FormData`:** the file and note copies in the index page are merged into one local `appendShareOptions(formData, opts)`.

### Pure-module extraction

From [Which page-script logic is extracted into pure, unit-tested modules?](https://github.com/luprzybyl/buzzdrop/issues/167).

**Rule:** extract logic only when it is duplicated across pages, or when it has an edge-case table that a DOM test would handle clumsily. Everything else stays in the page module. This rule also applies to future page logic.

| Module | Exports | Unit cases |
|---|---|---|
| `static/js/fragment-password.mjs` (new) | `readFragmentPassword(hash) → string \| null`, `buildOneClickLink(shareUrl, password)` | `""`, `#`, `#abc`, `#%E2%9C%93`, `#a%20b`, malformed `#%ZZ` → `null`; encode↔decode round trip |
| `static/js/file-extensions.mjs` (new) | `isAllowedFile(name, allowedExtensions)` | No dot, trailing dot, dotfile, double extension, uppercase. **Pins current behaviour** (`README` → `readme`). |
| `static/js/shared-files.mjs` (existing) | + `statusBadgeClass(file)`, `rowSearchText(searchBase, file)` | Badge priority downloaded > expired > active; null IP or missing display |

The `history.replaceState` fragment scrub stays in each page, because it's an effect. The strength-meter mapping stays in the index page, since `assessPassword` is already unit-tested. Tests live at `tests/js/<name>.test.mjs`.

## 4. DOM fixtures

From [How are DOM fixtures rendered from the real Jinja templates?](https://github.com/luprzybyl/buzzdrop/issues/157). Fixtures are rendered from the real templates and are never copied by hand.

- **Generator:** `tests/fixtures/render_dom_fixtures.py` requests the **real routes** through `test_client` (`GET /`, `POST /view/<id>/confirm`, the upload → success path, …). It seeds the database with fixed IDs and timestamps and logs in as the conftest test users. It saves the full response HTML, including `base.html` (nav, flashes, `<meta name="csrf-token">`).
- **Output:** `tests/js/fixtures/html/<template>--<state>.html`, committed.
- **Determinism:** fixed seed IDs, frozen time (`freezegun` or an injected clock; if `freezegun`, it is added to `requirements.txt` next to `pytest`), and a fixed CSRF token in the session. Only values that can't be controlled at the source are rewritten afterwards (e.g. `sha384-…` → `sha384-FIXTURE`).
- **Stripped:** `<script src>` tags (tests import or `init()` the module themselves; `test_sri_in_templates.py` keeps covering script references). **Kept:** the JSON config blocks (`allowed-extensions-json`, `upload-endpoints-json`, `view-config-json`).
- **States:**
  - `index`: anonymous; logged-in with no files; logged-in with files in each status (active, downloaded, expired, with private note, shared with them); admin; user with `configured_notification_email`
  - `view`: file, text
  - `confirm_download`: file, text
  - `success`: file, text

  `login.html` and `users.html` are excluded (they have no JS). Flash-message variants are added only when a DOM test needs one.

## 5. Protocol fake

From [What does the JS-integration layer's protocol fake look like?](https://github.com/luprzybyl/buzzdrop/issues/159), amended by [How is the protocol fake kept honest against the real server?](https://github.com/luprzybyl/buzzdrop/issues/168).

**One stateful, hand-written fake that enforces what the server enforces and answers the way the server answers.** No library.

- **Shape:** `makeProtocolFake(opts)` → `{ handle, fetch, XMLHttpRequest, state, log, failNext, seedShare }`.
  - **`handle(request) → { status, headers, body }`** is the raw core that holds all protocol logic.
  - **`fetch` and the XHR class** are thin adapters that add browser behaviour: following a 302 (`redirected: true`, final URL) and firing `upload.onprogress`.
- **State** is what the server would hold: the pending share (H, owner, bound V), the stored blob, `downloaded`, `released_at`, `attempts`, `receipt_hash`, `decryption_success`.
- **One instance spans upload → view**, which gives a browser-only round trip. `seedShare({ password, plaintext })` builds a valid share directly for view-only tests.
- **Routes:** exactly five: `/upload/begin`, `/upload`, `/download/<id>`, `/release/<id>`, `/report_decryption/<id>`. **Any other request throws.** The shared-files status poll and `/delete` are stubbed per test in the DOM layer.
- **Enforces:**
  - the CSRF header on `/upload/begin` and `/upload`
  - owner and `file_id` binding
  - the format of `file_id`, `key_verifier` and `receipt_hash`
  - the V match on release
  - one-time download and one-time release
  - the receipt on `/report_decryption`

  A failed check returns **the server's own status and body**. It never throws.
- **Options** mirror the server config: `maxAttempts`, `burnOnLockout`, `owner`.
- **Failures produced by state:**
  - wrong V → 403 + `attempts_remaining`
  - second release → 410
  - exhausted attempts → 429 (burn off) or 404 (burn on)
  - other owner → 403 on `/upload`
  - re-finish → 409
  - download twice → 302 to `/`
- **Injected failures:** `failNext(route, { status, body } | 'network')` is one-shot. For 413 and rate-limit 429 the body defaults to the **recorded** one (see §6). 500, malformed JSON and network errors are hand-specified.
- **Request log:** every request is recorded (method, URL, headers, body). The security invariants assert on it.
- **Source of truth:** `app.py`, not `CLAUDE.md`.
- **Module:** shared test support, e.g. `tests/js/support/protocol-fake.mjs`.

## 6. Protocol contract (keeping the fake honest)

From [How is the protocol fake kept honest against the real server?](https://github.com/luprzybyl/buzzdrop/issues/168).

**A contract recorded from `app.py` and replayed against the fake's raw core.** Nobody types expected responses by hand.

- **Scenarios:** written once in `tests/fixtures/protocol_scenarios.py`.
  - A scenario is a named request sequence run from a **fresh server**, with optional config overrides (`KEY_RELEASE_MAX_ATTEMPTS`, `KEY_RELEASE_BURN_ON_LOCKOUT`, `MAX_CONTENT_LENGTH`, rate limits).
  - A later step refers to an earlier response with `{"$ref": "<step>.<field>"}` in its URL or body.
  - The server never checks crypto, so `key_verifier`, `receipt_hash` and `v` are fixed 64-hex dummies.
  - The expired case is an upload with a past `expiry`.
- **Generator:** `tests/fixtures/record_protocol_contract.py` replays every scenario through `test_client`, logged in as the conftest test user, with `follow_redirects=False`.
  - It writes `tests/js/fixtures/protocol-contract.json`, which holds **requests and responses**, with random values normalised to `<uuid>` / `<hex64>`.
  - It fails if any step raises, or if two runs differ.
- **What must match:**
  - JSON responses: status plus the **exact JSON body**.
  - `/download`: status, `Content-Type` and `Location`, plus the body bytes on success.
  - `Cache-Control: no-store` on `/release`.
  - No other headers are compared.
- **Coverage:** every response the fake produces from state, plus the recorded 413 and rate-limit 429. **Completeness rule:** the fake declares the `(route, status)` pairs it can emit in a table, and the contract test fails on any pair that no scenario covers.
- **Contract test:** `tests/js/integration/protocol-contract.test.mjs` replays each scenario against `handle()` and compares raw responses. One adapter test checks that `fetch` follows the 302.
- **Workflow:** after changing a protocol response in `app.py`, run `npm run fixtures`. `js-fast` stays red until the fake matches.

## 7. Scenario catalogue

From [Which behaviours and journeys must each layer cover?](https://github.com/luprzybyl/buzzdrop/issues/161), amended by [Which page-script logic is extracted into pure, unit-tested modules?](https://github.com/luprzybyl/buzzdrop/issues/167). Each scenario gets one test.

### Unit (`node --test`)
- Existing: `crypto`, `passphrase`, `shared-files` (the crypto fixtures are byte-identical to `tests/unit/test_cli_crypto.py`).
- New: `fragment-password.test.mjs`, `file-extensions.test.mjs`; `shared-files.test.mjs` gains the badge and search-text cases (§3).

### DOM (Vitest + happy-dom, against the template fixtures)
- **Index page (`main.js`):**
  - Tab switching, including arrow/Home/End keys and ARIA state.
  - Strength meter: one scenario per level (weak/fair/strong); empty → hidden; width capped at 100% for ≥90 bits.
  - The generate-passphrase button.
  - Dropzone: a disallowed extension shows the error and no chip; the selected-file chip; the error regions.
  - Copy-to-clipboard status.
  - Delete confirmation via `data-confirm-message`.
  - Shared files: search, sort, pagination and their URL sync. Status refresh updates the row and re-renders (one row, stubbed `fetch`).
- **View page (`view.js`):** the plaintext view for text notes, the copy-text button, error messages, the field filled from a well-formed fragment.
- **Success page (`success.js`):** copy link and one-click link, password visibility toggle, the field filled from a well-formed fragment.
- **Confirm page (`confirm-download.js`):** the fragment password carried across the confirm POST (one well-formed case).
- **Hero flow (`hero-flow.js`):** reduced motion means no autoplay; the toggle pauses it.

### JS integration (page modules + real `crypto.js` + protocol fake)
- **Two-phase upload, for file and for note:** begin → encrypt under H → upload with `file_id`, verifier and `receipt_hash` → progress updates → redirect to success.
- **Share options sent on upload, for file and for note:** expiry, private note, notify-on-open, notification email. Asserted on the request bodies.
- **Upload error paths:** begin fails (abort), 403, 413, 429, server error. The UI recovers and can be retried, and no stale share is reused.
- **View:** fetch the blob → release → decrypt → report the receipt. Status handling for 403 (`attempts_remaining`), 410 and 429; 404 (missing or burned share) once [the burned-share bug](https://github.com/luprzybyl/buzzdrop/issues/169) gives `view.js` a branch for it.

### E2E journeys (Playwright, against the app container)
1. File: upload → success → share link → confirm → decrypt → downloaded bytes equal the original.
2. Text note round trip, with the plaintext shown on the page.
3. A second visit to a consumed link fails (download gone, release returns 410).
4. One wrong password burns the file under the default profile; a later correct password fails.
5. A one-click `#password` link decrypts without typing, and the fragment is gone from the URL afterwards.
6. The uploader deletes the file from the index list, and the link is dead.
7. Login → upload → logout (session and CSRF over real HTTP).

Hard-to-produce failures (410 edge cases, 429) are mocked per test with `page.route()`. There is no separate mocked-server E2E mode.

### Security invariants
| Invariant | Layer |
|---|---|
| The password never reaches the server: no request body, header or URL contains it | Integration (request log) + once in E2E (request interception) |
| Weak passwords are refused before any request is sent | Integration |
| Password fragments are scrubbed from the URL and history on every page (index, view, success, confirm) | DOM |
| The CSRF token is sent on every session-authed mutation | Integration |
| H is never persisted client-side (localStorage/sessionStorage) | Integration |
| Web Crypto is only available in a secure context | E2E (happy-dom doesn't model `isSecureContext`) |

## 8. E2E harness and test profile

From [Pin down E2E harness facts: Playwright against the Buzzdrop Docker image](https://github.com/luprzybyl/buzzdrop/issues/156) and [Define the E2E test profile for the app container](https://github.com/luprzybyl/buzzdrop/issues/160).

- **Topology:** Playwright and its browsers run on the host or runner. They can't run in the Alpine image. The app runs from the Buzzdrop image and is reached at `http://localhost:<E2E_PORT>`, which is a secure context, so `crypto.subtle` works without TLS. Don't use Docker service-name origins: Chromium's headless shell ignores `--unsafely-treat-insecure-origin-as-secure`.
- **`webServer`** owns the container:
  - Command: `docker run --rm --init --env-file tests/e2e/e2e.env -p 127.0.0.1:${E2E_PORT:-5055}:5000 ${E2E_IMAGE:-buzzdrop-e2e}`
  - `url: /login`
  - `gracefulShutdown: { signal: 'SIGTERM' }`
  - `stdout`/`stderr: 'pipe'`

  Both `--init` and graceful shutdown are required, or the container outlives the run.
- **Host port 5055** (`E2E_PORT`), because 5000 is taken by the macOS AirPlay Receiver. `baseURL` is derived from it.
- **Profile `tests/e2e/e2e.env` (committed):** sets every variable the run relies on explicitly.

  | Variable | Value | Why |
  |---|---|---|
  | `FLASK_ENV` | `testing` | HTTP cookies; limiter on with relaxed limits (all E2E traffic comes from one IP) |
  | `FLASK_USER_1` | `e2e:<password>:false` | Single non-admin user (no admin UI with JS) |
  | `FLASK_SECRET_KEY` | fixed dummy | Deterministic; silences the temporary-key warning |
  | `STORAGE_BACKEND` | `local` | No mounts; state disappears with `--rm` |
  | `DATABASE_URL` | `sqlite:////tmp/e2e/buzzdrop.db` | |
  | `UPLOAD_FOLDER` | `/tmp/e2e/uploads` | |
  | `EXPIRY_SWEEP_INTERVAL_SECONDS` | `0` | Expiry isn't tested in E2E |
  | `SMTP_*` | empty | No notification mail |

  Lockout keeps its defaults (`KEY_RELEASE_MAX_ATTEMPTS=1`, burn on), so journey 4 tests it for real.
- **`.dockerignore`:** `.env`, `buzzdrop.db*`, `uploads/`, `node_modules/`, `.venv/`, `__pycache__/`. Without it, `COPY . .` bakes a developer's `.env` and DB into the image, and `load_dotenv` fills in anything the profile leaves unset.
- **Isolation:** one fresh container per `playwright test` run, shared by all browser projects and workers. **No test-only reset or seed hooks.** Each test uploads under a unique filename and finds its own row.
- **Downloads:** `page.waitForEvent('download')` + `download.path()` captures the Blob save byte-exact. PBKDF2 costs about 40–90 ms per derivation, which is negligible.
- **Config:** projects Chromium, Firefox and WebKit; `retries: 0`; `trace: 'retain-on-failure'`, `screenshot: 'only-on-failure'`, `video: 'off'`.

## 9. CI

From [Lay out the two-tier JS CI](https://github.com/luprzybyl/buzzdrop/issues/162) and [How is the protocol fake kept honest against the real server?](https://github.com/luprzybyl/buzzdrop/issues/168).

All gating CI lives in `ci.yml`. **`build-test.yml` is deleted** (it duplicated the Docker pytest run on a different Python). The triggers stay as they are: push to `main` and PRs to `main`. There are **no path filters**. A `concurrency` group with `cancel-in-progress` applies to PR runs.

| Job | Needs | Does |
|---|---|---|
| `js-fast` | — | `setup-node` (`.nvmrc`, `cache: npm`) → `npm ci` → `npm run test:unit` → `npm run test:dom` |
| `build` | — | `docker build -t buzzdrop-test .` → `docker save` → upload the image as an artifact |
| `pytest` | `build` | `docker load` → pytest in the image → `db.json` migration smoke test → **DOM-fixture drift check** → **protocol-contract drift check** |
| `e2e` | `build` | `docker load` → `setup-node` + `npm ci` → `npx playwright install --with-deps chromium firefox webkit` (no browser cache) → `E2E_IMAGE=buzzdrop-test npx playwright test` |

- **Drift checks:** mount the workspace into the image, run the generators (`render_dom_fixtures.py`, `record_protocol_contract.py`), then `git diff --exit-code tests/js/fixtures/` on the runner.
- **E2E failure artifacts:** `playwright-report/` and `test-results/` are uploaded `if: failure()` and kept for 7 days.
- **Cleanup:** drop the unused `docker:dind` service and the dead `/tmp/.buildx-cache` step.
- **Merge gating:** `js-fast`, `pytest` and `e2e` are required status checks on `main` (a repo setting).

## 10. Out of scope

- Visual regression, accessibility audits, performance and load testing.
- Changes to the Python test suite beyond what this strategy names.
- CLI ↔ browser cross-client E2E: format interop is proven by the shared byte-identical BKV3 fixtures.
- The admin token UI (`users.html` has no JS).
- SRI for ES modules imported by entry scripts. This gap already exists, and it is tracked in [SRI does not cover ES modules imported by entry scripts](https://github.com/luprzybyl/buzzdrop/issues/166).
- The `/release` 404-vs-403 mismatch is a product bug, tracked in [Burned share: /release returns 404, CLAUDE.md says 403, view.js shows a generic error](https://github.com/luprzybyl/buzzdrop/issues/169). The fake and contract follow whatever `app.py` returns.
