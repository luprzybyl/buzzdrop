# Frontend test strategy

The locked test strategy for Buzzdrop's browser JS (`static/js/`). The code itself is layered into `lib/`, `features/` and `pages/` ([#251](https://github.com/buzzdrop/buzzdrop/issues/251); the rules are in `static/js/CLAUDE.md`, enforced by `tests/js/architecture.test.js`); paths below are relative to `static/js/`. Every tooling, layering, fixture, test-profile and CI decision is here, so the harnesses and tests can be built without re-deciding anything. Each section states the decision as it stands now and links to the ticket that holds its reasoning. Charted on the map [Wayfinder: frontend & JS test strategy](https://github.com/buzzdrop/buzzdrop/issues/154).

## 1. Layers

Each behaviour is tested **once**, at the **lowest layer that can show it**.

| Layer | What it tests | Runner | Environment |
|---|---|---|---|
| **Unit** | Pure modules on their own | `node --test` | Node |
| **DOM** | One page module against its real markup, crypto stubbed, network on the protocol fake | Vitest | happy-dom |
| **JS integration** | Page modules + real `lib/crypto.js` against the protocol fake | Vitest | happy-dom |
| **E2E** | What needs a real browser *and* the real server | Playwright | Chromium, Firefox, WebKit against the Buzzdrop Docker image |

"Integration" means the JS-integration layer and nothing else. The Python suite (`tests/`) is not changed by this strategy, except for the generators and CI steps named below.

## 2. Runners and tooling

From [Choose the runner and DOM environment for DOM + JS-integration tests](https://github.com/buzzdrop/buzzdrop/issues/155).

- **Unit:** keep `node --test` for `tests/js/*.test.js`. These files don't run under Vitest.
- **DOM + integration:** Vitest with happy-dom, pinned at **>= 20.8.9** (security advisories). Vitest's `include` covers only `tests/js/dom/**` and `tests/js/integration/**`.
- **jsdom is rejected.** It puts byte arrays in two realms, so `TextEncoder`/`subtle` output fails `instanceof Uint8Array`, which breaks `lib/crypto.js`. It also has no navigation, and `new Response(blob)` throws.
- Real 600k-iteration PBKDF2 runs in happy-dom at acceptable cost. Tests don't stub the KDF.
- **Node 24** via a committed `.nvmrc`.
- **npm scripts:** `test:unit` (today's `test:js`, renamed), `test:dom` (`vitest run --coverage`), `test` (both), `fixtures` (regenerates the DOM fixtures and the protocol contract), `typecheck` (`tsc -p jsconfig.json`).
- **Type checking** (from [#203](https://github.com/buzzdrop/buzzdrop/issues/203)): `tsc --checkJs` under `strict` checks `static/js/` and `tests/js/` from their JSDoc, with no build step and no `.ts` files (`noEmit`; the browser loads the same `.js`). Config: root `jsconfig.json`; devDeps `typescript` and `@types/node`. Its `include` is all of `static/js/**/*.js` and `tests/js/**/*.js`. No `@ts-ignore`/`@ts-nocheck`; an `@ts-expect-error` carries a one-line reason.
- **Typed DOM tests:** page modules are typed against lib.dom, happy-dom's window against its own classes. The page drivers (§7a) open each page through `browserView(window)` from `tests/js/support/dom-fixture.js`, the one bridge between the two.
- **Testing Library** (from [#235](https://github.com/buzzdrop/buzzdrop/issues/235)): devDeps `@testing-library/dom` (queries), `@testing-library/jest-dom` (matchers such as `toBeDisabled`, `toBeVisible`, `toHaveAccessibleName`) and `@testing-library/user-event` (typing, clicking, keys, file upload), plus `dom-accessibility-api` for the accessible names a driver lists. `tests/js/support/setup.js` is Vitest's `setupFiles` entry: it registers the jest-dom matchers and, after each test, restores timers and mocks and closes every page a driver opened. Queries go through the driver's page, never Testing Library's own `screen`, which is bound to the global document rather than to a fixture's window.
- **happy-dom and visibility:** happy-dom ignores CSS inside `@layer`, which is all Tailwind v4 emits, and has no built-in style for `[hidden]`. Testing Library and jest-dom do check the `hidden` attribute themselves, and inline `style="display: none"` is honoured. So page scripts show and hide with the `hidden` attribute (Tailwind's preflight hides `[hidden]` with `!important` in the browser) or inline `display`, never by toggling the `.hidden` class. One exception: elements that overlap in a shared grid cell so the cell keeps the taller one's height (the index page's File and Text note panels) hide with inline `visibility: hidden`, which keeps their space. Testing Library and jest-dom honour it too, and it removes the element from the tab order and the accessibility tree. A test that has to see an element appear or disappear depends on this.
- **Coverage** is reported, not gated.

## 3. Testability refactor of page scripts

From [What shape should the testability refactor of page scripts take?](https://github.com/buzzdrop/buzzdrop/issues/158). Production JS may be refactored to make it testable, as long as behaviour doesn't change.

- **Split:** each page gets a side-effect-free module (`pages/<page>/<page>-page.js` for `index`, `view`, `success`, `confirm-download`, `hero-flow`, `users` and `how-it-works`) exporting `init<Page>(root, deps)` and `browserDeps()`. Each page's `pages/<page>/entry.js` is only `init<Page>(document, browserDeps())`. Template `<script>` tags, SRI attributes and JSON config blocks stay as they are. **Tests import the page module, never the entry.**
- **State lives in the `init` closure** (e.g. `uploadInProgress`, `activeShareMode`, parsed config, CSRF token). Every `init()` is a fresh page, and no `vi.resetModules()` is needed.
- **Dependencies (`deps`):**

  | Passed in | Why |
  |---|---|
  | `fetch`, `XMLHttpRequest` | Network-level seams, so the protocol fake sees real URLs, headers and bodies. The XHR class also supplies `upload.onprogress`, which happy-dom never fires. |
  | `navigate(url)`, `alert(msg)` | Effects the tests observe |
  | `crypto` (`ShareCrypto` from `lib/crypto.js`: `seal`, `open`, `receiptHash`) | Integration tests pass the real one. DOM tests may stub it. |

  **Not passed in:** the DOM (it comes in as `root`), `history`, `clipboard`, and reads of `location`. happy-dom models these, and tests assert on them directly.
- **The success and confirm-download scripts become ES modules** (`type="module"` in their templates).
- **Template-guaranteed elements** are looked up with `required(parent, selector, tag)` / `requiredClosest(element, selector, tag)` from `lib/required.js`: a missing element or wrong tag throws a named error, and the tag gives the element's type with no cast. Elements a template may really lack keep a plain null check. This is page code only; tests and drivers find elements by role, label or text (§7b).
- **Upload `FormData`:** built in one place, `createShare` in `features/share-protocol/`, for files and notes alike.

### Pure-module extraction

From [Which page-script logic is extracted into pure, unit-tested modules?](https://github.com/buzzdrop/buzzdrop/issues/167).

**Rule:** extract logic only when it is duplicated across pages, or when it has an edge-case table that a DOM test would handle clumsily. Everything else stays in the page module. This rule also applies to future page logic.

| Module | Exports | Unit cases |
|---|---|---|
| `lib/one-click-link.js` | `readFragmentPassword(hash) → string \| null`, `takeFragmentPassword(window)`, `buildOneClickLink(shareUrl, password)` | `""`, `#`, `#abc`, `#%E2%9C%93`, `#a%20b`, malformed `#%ZZ` → `null`; encode↔decode round trip |
| `lib/file-extensions.js` | `isAllowedFile(name, allowedExtensions)` | No dot, trailing dot, dotfile, double extension, uppercase. **Pins current behaviour** (`README` → `readme`). |
| `features/shared-files/shared-files.js` | `getSharedFilesPage`, `buildSharedFilesUrl`, `relativeTime`, `rowSearchText(searchBase, file)`, `compareRows(sort)` | Paging and search; relative-time rounding; null IP or missing display; sort by instant, rows without the time last |

The fragment scrub lives in `takeFragmentPassword(window)`, so every page that reads a one-click password scrubs it the same way (#251 reversed the earlier "an effect, so it stays in each page"). The strength-meter mapping stays in `features/password-gate/` and is DOM-tested through the index page, since `assessPassword` is already unit-tested. Tests live at `tests/js/<name>.test.js`.

## 4. DOM fixtures

From [How are DOM fixtures rendered from the real Jinja templates?](https://github.com/buzzdrop/buzzdrop/issues/157). Fixtures are rendered from the real templates and are never copied by hand.

- **Generator:** `tests/fixtures/render_dom_fixtures.py` requests the **real routes** through `test_client` (`GET /`, `POST /view/<id>/confirm`, the upload → success path, …). It seeds the database with fixed IDs and timestamps and logs in as the conftest test users. It saves the full response HTML, including `base.html` (nav, flashes, `<meta name="csrf-token">`).
- **Output:** `tests/js/fixtures/html/<template>--<state>.html`, committed. `npm run fixtures` regenerates them (and the protocol contract, §6), and the pre-commit hook in `.githooks/` does it automatically for commits that touch `templates/`, `db/`, a root `*.py`, `.env.example` or anything under `tests/fixtures/` (the generators and the protocol scenarios).
- **Determinism:** fixed users, seed IDs, timestamps and session CSRF token; expiry dates far in the past or future, so nothing rendered depends on the current time (no `freezegun` needed). The drop list's relative times are computed in the browser from the page's injected clock (`IndexDeps.now`), which the index driver fixes at its `NOW`. The developer's `.env` is ignored. The generator fails if two renders differ. Only values that can't be controlled at the source are rewritten afterwards (e.g. `sha384-…` → `sha384-FIXTURE`).
- **Stripped:** `<script src>` tags and the import map, which was added by [#166](https://github.com/buzzdrop/buzzdrop/issues/166) (tests import or `init()` the module themselves; `test_sri_in_templates.py` keeps covering script references). **Kept:** the JSON config blocks (`allowed-extensions-json`, `upload-endpoints-json`, `view-config-json`).
- **States** (fixture names in brackets):
  - `index`: anonymous (`anonymous`); logged-in with no files (`empty`); logged-in with files in each status: active, downloaded, expired, with private note, shared with them (`files`); admin (`admin`); user with `configured_notification_email` (`notification-email`)
  - `view`: file, text
  - `confirm_download`: file, text
  - `success`: file, text
  - `users`: admin, with one existing token (`admin`)
  - `how_it_works`: anonymous, the default view (`default`); other views are opened by address, which the page script reads

  `login.html` is excluded (it has no JS). Flash-message variants are added only when a DOM test needs one.

## 5. Protocol fake

From [What does the JS-integration layer's protocol fake look like?](https://github.com/buzzdrop/buzzdrop/issues/159), amended by [How is the protocol fake kept honest against the real server?](https://github.com/buzzdrop/buzzdrop/issues/168).

**One stateful, hand-written fake that enforces what the server enforces and answers the way the server answers.** No library.

- **Shape:** `makeProtocolFake(opts)` → `{ handle, fetch, XMLHttpRequest, state, log, failNext, seedShare }`.
  - **`handle(request) → { status, headers, body }`** is the raw core that holds all protocol logic.
  - **`fetch` and the XHR class** are thin adapters that add browser behaviour: following a 302 (`redirected: true`, final URL) and firing `upload.onprogress`.
- **State** is what the server would hold: the pending share (H, owner, bound V), the stored blob, `downloaded`, `released_at`, the download-ticket digest the release stores, `attempts`, `receipt_hash`, `decryption_success`.
- **One instance spans upload → view**, which gives a browser-only round trip. `seedShare({ password, plaintext })` builds a valid share directly for view-only tests.
- **Routes:** exactly five: `/upload/begin`, `/upload`, `/download/<id>`, `/release/<id>`, `/report_decryption/<id>`. **Any other request throws.** The shared-files status poll and `/api/token` are answered by their page drivers (§7a); `/delete` is a native form POST, which the page harness records and stops.
- **Enforces:**
  - the CSRF header on `/upload/begin` and `/upload`
  - owner and `file_id` binding
  - the format of `file_id`, `key_verifier` and `receipt_hash`
  - the V match on release
  - one-time release, then a one-time download that needs the ticket derived from the released H (`X-Download-Ticket`)
  - the receipt on `/report_decryption`

  A failed check returns **the server's own status and body**. It never throws.

  **Deliberately stricter than the server** where the page never takes the other path, so a page change that would take it fails loudly: CSRF only via the `X-CSRF-Token` header (no form/JSON field, no `Authorization` exemption), a `/upload` without `X-Requested-With` or a multipart body throws instead of getting the server's HTML redirect, and `/upload/begin` or `/upload` with no logged-in user throws instead of meeting the login check. **Not enforced:** the file-extension allow-list on `/upload` (the page checks it before sending; DOM-tested), and a malformed configured account email (a server-config error). The header of `protocol-fake.js` lists these.
- **Options** mirror the server config: `maxAttempts`, `burnOnLockout`, `downloadTtlSeconds`, `owner` (the logged-in account; `state.user` switches it mid-test), plus the session's `csrfToken` (defaults to the DOM fixtures' token), `notificationsConfigured` (SMTP set up) and `accountEmails` (who may ask for open notifications); the contract test takes all of these from the recording.
- **Failures produced by state:**
  - wrong V → 403 + `attempts_remaining`
  - second release → 410
  - exhausted attempts → 429 (burn off) or 404 (burn on)
  - other owner → 403 on `/upload`
  - re-finish → 409
  - download before any release → 403
  - download of a released share without the winner's ticket → 410 (claimed)
  - download after the download window (`downloadTtlSeconds`, from `KEY_RELEASE_DOWNLOAD_TTL_SECONDS`) → 410 (expired)
  - download twice → 410 (302 to `/` for a request without `X-Requested-With`)
- **Injected failures:** `failNext(route, { status, body } | 'network')` is one-shot. For 413 and rate-limit 429 the body defaults to the **recorded** one (see §6). 500, malformed JSON and network errors are hand-specified.
- **Request log:** every request is recorded (method, URL, headers, body). The security invariants assert on it.
- **Source of truth:** `app.py`, not `CLAUDE.md`.
- **Module:** shared test support, e.g. `tests/js/support/protocol-fake.js`.

## 6. Protocol contract (keeping the fake honest)

From [How is the protocol fake kept honest against the real server?](https://github.com/buzzdrop/buzzdrop/issues/168).

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
- **Coverage:** every response the fake produces from state, plus the recorded 413 and rate-limit 429. **Completeness rule:** the fake declares what it can emit in a table (`EMITS`), as `(route, status, source)` with source `state` or `injected`, so a lockout 429 and a rate-limit 429 are separate entries. The contract test fails on any entry that no scenario covers, and on any replayed response missing from the table.
- **Contract test:** `tests/js/integration/protocol-contract.test.js` replays each scenario against `handle()` and compares raw responses. One adapter test checks that `fetch` follows the 302.
- **Workflow:** after changing a protocol response in `app.py`, run `npm run fixtures`. `js-fast` stays red until the fake matches.

## 7. Scenario catalogue

From [Which behaviours and journeys must each layer cover?](https://github.com/buzzdrop/buzzdrop/issues/161), amended by [Which page-script logic is extracted into pure, unit-tested modules?](https://github.com/buzzdrop/buzzdrop/issues/167). Each scenario gets one test.

**Granularity.** A test earns its place by catching a mistake that would weaken security or break a journey; the mutation table below names those mistakes. File and note run as separate cases only where their code differs: they share `createShare`, so the error paths run once, in file mode. Which message the UI shows for which status is a DOM concern, not an integration one.

### Unit (`node --test`)
- Existing: `crypto`, `passphrase`, `shared-files` (the crypto fixtures are byte-identical to `tests/unit/test_cli_crypto.py`).
- New: `one-click-link.test.js`, `file-extensions.test.js`, `hex.test.js`, `architecture.test.js` (the layer rules, #251); `shared-files.test.js` gains the search-text and `compareRows` cases (§3).
- `required.test.js`: the element lookups (§3) return the match, and throw on a missing element, a wrong tag or a windowless document.

### DOM (Vitest + happy-dom, against the template fixtures)
- **Index page (`pages/index/`):**
  - Tab switching, including arrow/Home/End keys and ARIA state.
  - Strength meter (`role="meter"`): one scenario per level (weak/fair/strong, its `aria-valuetext`, `aria-valuenow` and the bar's fill); empty → hidden; capped at 100 for ≥90 bits. The meter carries the fill as `--strength-fill` for the bar's width; jest-dom's `toHaveStyle` can't check a custom property, so the driver reads it (`strengthBarFill()`).
  - The generate-passphrase button.
  - The password's Show/Hide and Copy: both disabled while the field is empty; Show reveals and Hide masks; a generated passphrase is shown; Copy flashes "Copied!", or "Failed" when the clipboard is blocked or missing, and its status region announces it.
  - Missing input refused inline, with no dialog and no request: an empty note, a missing password, no file chosen.
  - Open notifications: an account without an email has the box disabled and is told why; with one, the account email shows once the box is ticked.
  - Dropzone: a disallowed extension shows the error and no chip; the selected-file chip; the error regions.
  - Copy-to-clipboard status.
  - Delete confirmation via `data-confirm-message`.
  - Shared files: search, sort (newest upload first by default), pagination and their URL sync; the page controls hidden while everything fits on one page. Each status's label; a note titled by its private note, or by its time; plain words for a missing expiry, opening or address; times relative to the driver's fixed clock, with the full timestamp in the title. Copy link offered only on an active drop. Status refresh updates the row (status, opened time, address, Copy link withdrawn) and its search text (one row, answered by the driver).
- **View page (`pages/view/`):** the plaintext view for text notes, the copy-text button, the error messages (including those for 410, 429 and 404 from `/release`), the field filled from a well-formed fragment, Enter in the field decrypting without navigating, Decrypt enabled at once with no request sent before the password is proven (the ciphertext downloads only after a winning release), the attempts warning (and the field's description of it) going after the first try, the status line as a live region.
- **Success page (`pages/success/`):** copy link, password and one-click link (with "Failed" when the clipboard is blocked or missing, while Copy link, which copies by selection, still works without a Clipboard API), password visibility toggle, the fields filled from a well-formed fragment and the one-click link shown with its fragment masked.
- **Confirm page (`pages/confirm-download/`):** the fragment password carried across the confirm POST (one well-formed case).
- **Hero flow (`pages/hero-flow/`):** reduced motion means no autoplay; the toggle pauses it. The stage on screen is the list item with `aria-current="step"`.
- **How it works (`pages/how-it-works/`, #245):** Next/Previous and the step list move the step on screen (the one visible `article`, its list button `aria-current="step"`), Previous and Next disabled at the ends; a `#step-…` address, on load or followed later, opens that step; Play advances on a timer, also under reduced motion (which only drops the animation), stops at the last step and starts over from it, Pause keeps the time left for Play to resume, and stepping by hand stops it; nothing moves until Play. Each switch changes the step on screen in place (actor, auth, upload field, end of decryption, the filename caveat) and writes `?sender=…&content=…` to the address, keeping its fragment; CLI disables Text with its reason as the radio's description and moves Text to File, also when the address asks for CLI + text; the choice is announced in a status line.
- **Users page (`pages/users/`, admin):** Generate shows the token and its expiry and re-enables the button; a server error shows its message; the request carries the CSRF header; Copy shows "Copied!".

### JS integration (page modules + real `lib/crypto.js` + protocol fake)
- **Two-phase upload, for file and for note:** begin → encrypt under H → upload with `file_id`, verifier and `receipt_hash` → progress updates → redirect to success.
- **Share options sent on upload, for file and for note:** expiry, private note, notify-on-open, notification email. Asserted on the request bodies.
- **Upload error paths, file mode only:** begin fails → the retry runs a fresh begin; upload fails → the retry finishes the newly issued share, not the stale one; 413 shows its message and the UI unlocks.
- **View:** release → ticketed download of the blob → decrypt → report the receipt, plus one upload → view round trip on one fake instance. 403 with `attempts_remaining`. The other `/release` statuses only pick a message and are DOM-tested.
- **Share protocol (`features/share-protocol/`) on its own:** a successful open runs PBKDF2 once; a large note uploads and arrives whole; a server share of the wrong length is a refused handshake.

### E2E journeys (Playwright, against the app container)
1. File: upload → success → share link → confirm → decrypt → downloaded bytes equal the original.
2. Text note round trip, with the plaintext shown on the page; the password is submitted with Enter.
3. A second visit to a consumed link fails (the page says the drop is gone, the download is gone, release returns 410).
4. One wrong password burns the file under the default profile; a later correct password fails.
5. A one-click `#password` link decrypts without typing, and the fragment is gone from the URL afterwards.
6. The uploader deletes the file from the index list, and the link is dead.
7. Login → upload → logout (session and CSRF over real HTTP).
8. The header stays one row at 375px and 320px, logged out and logged in, with no sideways scroll (#232).

Hard-to-produce failures (410 edge cases, 429) are mocked per test with `page.route()`. There is no separate mocked-server E2E mode.

**Always-on invariant fixture.** Every E2E test, in every browser, runs under a Playwright fixture that intercepts all requests and fails if the test's password appears in any URL, header or body, and that fails after the test if `localStorage` or `sessionStorage` holds anything. Journeys added later inherit it.

### Security invariants
| Invariant | Layer |
|---|---|
| The password never reaches the server: no request body, header or URL contains it | Integration (request log) + every E2E test (always-on fixture) |
| Weak passwords are refused before any request is sent | Integration |
| Password fragments are scrubbed from the URL and history on every page (index, view, success, confirm) | DOM |
| The CSRF token is sent on every session-authed mutation | Integration |
| H is never persisted client-side (localStorage/sessionStorage) | Integration + every E2E test (always-on fixture) |
| Web Crypto is only available in a secure context | E2E (happy-dom doesn't model `isSecureContext`) |

### Mutation table
Each row is a small mistake and the layer that must catch it. A test that owns a row is checked by making that mistake in the code and watching the test fail; record the result in the PR. A test may move between layers as long as its rows are still caught. Issues point to the rows they own.

| # | Mutation | Must be caught by |
|---|---|---|
| 1 | Password added to the upload body | Integration + E2E (always-on fixture) |
| 2 | Password sent to `/release` instead of V | Integration (view) + E2E (always-on fixture) |
| 3 | H written to localStorage/sessionStorage | Integration + E2E (always-on fixture) |
| 4 | Weak-password check removed | Integration |
| 5 | A cached begin response reused on retry | Integration |
| 6 | CSRF header dropped from a session-authed mutation | Integration |
| 7 | Share options dropped from the note upload | Integration |
| 8 | Password fragment not scrubbed from the URL/history | DOM |
| 9 | UI left locked after an upload error | Integration (413 case) |
| 10 | Progress display removed | Integration |
| 11 | Key derivation or envelope diverges between browser and CLI | Unit (byte-identical BKV3 fixtures) |
| 12 | Server releases H twice, or skips the lockout | Python (`tests/integration/test_key_release.py`) |

## 7a. Page drivers

From [Frontend tests: drive pages through user-behaviour helpers instead of setup details](https://github.com/buzzdrop/buzzdrop/issues/235).

**Tests say what the user does; one driver per page says how.** A DOM or JS-integration test never loads a fixture, calls `init<Page>()`, stubs `fetch` or crypto, builds an event, or looks an element up by selector. It opens the page through its driver, acts through the driver's verbs, and asserts on what the user can perceive.

- **Where:** `tests/js/support/pages/`, one module per page, on a shared core:

  | Module | Opens | Verbs (examples) |
  |---|---|---|
  | `page.js` | the core: a fixture in its own happy-dom window, Testing Library queries bound to it, a user-event session | `openPage`, `screen`, `waitUntil`, `typeable` |
  | `upload.js` | `openUploadPage(options)` (index, logged in), `openLandingPage(options)` (index, anonymous, with the hero) | `switchToNote`, `writeMessage`, `selectFile`, `dropFile`, `enterPassword`, `generatePassword`, `showPassword`, `hidePassword`, `copyPassword`, `setShareOptions`, `share`, `shareFile`, `shareMessage`, `press`, `searchShares`, `sortSharesBy`, `nextSharesPage`, `copyShareLink`, `deleteShare`; `pauseWalkthrough`, `pointAtWalkthrough` |
  | `success.js` | `openSuccessPage(options)` | `copyShareLink`, `copyOneClickLink`, `revealPassword`, `hidePassword` |
  | `confirm.js` | `openConfirmPage(options)` | `proceedToView` |
  | `view.js` | `openShare(options)` | `decryptWithPassword`, `decryptWithEnter`, `copyMessage`, `finishDownload` |
  | `users.js` | `openUsersPage(options)` | `generateToken`, `startGeneratingToken`, `finishTokenRequest`, `copyToken` |
  | `how-it-works.js` | `openHowItWorks(options)` | `nextStep`, `previousStep`, `goToStep`, `changeAddressTo`, `play`, `pause`, `chooseSender`, `chooseContent` |

- **Naming rule:** verbs are what a user does, in the app's own words ("share", "decrypt", "proceed", "Copy one-click link"), not what the code does. Options describe the user's situation in app terms, and the driver turns them into fixtures, fixture edits, protocol-fake state and crypto stubs: `openShare({ type: 'message', link: 'one-click', maxAttempts: 3, server: 'claimed', download: 'in-progress', share: 'unsupported-format' })`, `openUploadPage({ account: 'with-email', sharesPerPage: 2, clipboard: 'blocked' })`, `enterPassword({ strength: 'weak' })`, `share({ server: 'too-large' })`. No test spells out an HTTP status or body.
- **Server situations come from the protocol fake** (§5–§6). The view and upload drivers put the page in front of a fake in both layers; a situation is produced by the fake's own state where it can be (a wrong password, a share someone already claimed or burned, a lockout) and by `failNext` otherwise (500, network, 413, rate limits). Drivers add no hand-written responses for the five protocol routes. Routes outside the fake (the shared-files status poll, `/api/token`) are answered by their driver.
- **One driver, two layers.** A driver takes `crypto: 'stub' | 'real'`: DOM tests run the stub (`tests/js/support/stub-crypto.js`: no PBKDF2, but a verifier the fake can check and a receipt matching the share's `receipt_hash`), JS-integration tests run the real `lib/crypto.js`. An integration test can hand one fake from the upload driver to `openShare({ uploaded: { backend, fileId } })` for a browser-only round trip.
- **What a driver returns:** verbs, plus the outcomes a test can't see on screen: `url()`, `historyLength()`, `clipboardText()`, `formsSubmitted()` (submissions the page let through, which would navigate), `storage()`, `reportsSent()`, `requestsSent()`, `navigatedTo()`, `alerts()`, `sharesIssued()`, `progressShown()`, `savedFile()`, and the fake itself (`backend`) for checks on server state. It hands out **no element handles**: everything on screen is asserted through Testing Library (§7b).
- **Lifecycle:** each `open…` call is a fresh page; `screen` queries the page opened last; the setup file closes them all after each test.
- Drivers are JSDoc-typed and pass `npm run typecheck`.

## 7b. Querying through accessibility

From [#235](https://github.com/buzzdrop/buzzdrop/issues/235). Tests and drivers find elements the way a user or a screen reader does, and assert what that user perceives.

- **Query order:** role first (`getByRole('button', { name: 'Decrypt and view' })`, `getByRole('tab', { name: 'Text note' })`, `getByRole('status')`, `getByRole('region', { name: 'Decrypted text' })`, `getByRole('article', { name })` for a share row), label next (`getByLabelText('Password')`), text last, and only for plain prose with no role (`getByText('Page 1 of 2')`). **Never** by `#id`, `data-testid`, class or `querySelector`; `within(element)` scopes a query to a row or card.
- **Assertions on perceivable state:** `toBeDisabled`/`toBeEnabled`, `toBeVisible`, `toHaveFocus`, `toHaveValue`, `toHaveTextContent`, `toHaveAccessibleName`, `toHaveAccessibleDescription`, `toHaveAttribute('aria-…')`. **Not** `.disabled`, `.style.display`, `.classList`, `.hidden` or `.textContent` on elements found by id. Role queries leave out hidden elements, so "no longer shown" is `queryByRole(…)` returning null, or `not.toBeVisible()` for text.
- **When a query can't find something, fix the page, not the test.** #235 gave the pages the semantics the tests (and users) rely on: live regions with a role (the view page's `status`, the named `Clipboard` status on index, success and users, with copies on the view page announced through its status line, `alert` for the token error), a `meter` for password strength and a `progressbar` for uploads, named regions for the decrypted note, the walkthrough, the drop list and each token card, named share rows, real `<button>`s for copying a share link, stable names for copy buttons (`Copy link`, `Copy password`, `Copy one-click link`, `Copy token`), errors tied to their fields with `aria-describedby`, and `aria-current="step"` on the walkthrough. Page scripts may keep looking elements up by id internally; this is about what the page exposes.
- **Visual-only state** (a badge's colour, which icon a toggle shows) has nothing to perceive beyond its text or name, and is asserted through those.
- **E2E** uses Playwright's equivalents (`getByRole`, `getByLabel`, `getByText`), never `page.locator('#…')` or a class, and the recipient's steps go through the verbs in `tests/e2e/support.js` (`proceedToView`, `decryptWithPassword`, `decryptWithEnter`, `decryptFile`, `decryptMessage`, `oneClickLink`).

## 8. E2E harness and test profile

From [Pin down E2E harness facts: Playwright against the Buzzdrop Docker image](https://github.com/buzzdrop/buzzdrop/issues/156) and [Define the E2E test profile for the app container](https://github.com/buzzdrop/buzzdrop/issues/160).

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
  | `FLASK_USER_1` | `e2e:<password>:false` | Single non-admin user (the admin token UI is covered in the DOM layer, not E2E) |
  | `FLASK_SECRET_KEY` | fixed dummy | Deterministic; silences the temporary-key warning |
  | `STORAGE_BACKEND` | `local` | No mounts; state disappears with `--rm` |
  | `DATABASE_URL` | `sqlite:////tmp/e2e/buzzdrop.db` | |
  | `UPLOAD_FOLDER` | `/tmp/e2e/uploads` | |
  | `EXPIRY_SWEEP_INTERVAL_SECONDS` | `0` | Expiry isn't tested in E2E |
  | `SMTP_*` | empty | No notification mail |

  Lockout keeps its defaults (`KEY_RELEASE_MAX_ATTEMPTS=1`, burn on), so journey 4 tests it for real.
- **`.dockerignore`:** at least `.env`, `buzzdrop.db*`, `uploads/`, `node_modules/`, `.venv/`, `__pycache__/`; the file itself is the full list ([#163](https://github.com/buzzdrop/buzzdrop/issues/163)). Without it, `COPY . .` bakes a developer's `.env` and DB into the image, and `load_dotenv` fills in anything the profile leaves unset.
- **Isolation:** one fresh container per `playwright test` run, shared by all browser projects and workers. **No test-only reset or seed hooks.** Each test uploads under a unique filename and finds its own row.
- **Downloads:** `page.waitForEvent('download')` + `download.path()` captures the Blob save byte-exact. PBKDF2 costs about 40–90 ms per derivation, which is negligible.
- **Config:** projects Chromium, Firefox and WebKit; `retries: 0`; `trace: 'retain-on-failure'`, `screenshot: 'only-on-failure'`, `video: 'off'`; `reducedMotion: 'reduce'`, because animations moved elements under clicks and lost some of them (the app collapses every animation under `prefers-reduced-motion`).
- **Browser matrix:** every journey runs in all three browsers. After the first failure in Firefox or WebKit that has no real bug behind it, Chromium keeps every journey and the other two run only journeys 1, 2 and 5.

## 9. CI

From [Lay out the two-tier JS CI](https://github.com/buzzdrop/buzzdrop/issues/162) and [How is the protocol fake kept honest against the real server?](https://github.com/buzzdrop/buzzdrop/issues/168).

All gating CI lives in `ci.yml`. **`build-test.yml` is deleted** (it duplicated the Docker pytest run on a different Python). The triggers stay as they are: push to `main` and PRs to `main`. There are **no path filters**. A `concurrency` group with `cancel-in-progress` applies to PR runs.

| Job | Needs | Does |
|---|---|---|
| `js-fast` | — | `setup-node` (`.nvmrc`, `cache: npm`) → `npm ci` → `npm run typecheck` → `npm run test:unit` → `npm run test:dom` |
| `build` | — | plant decoy `.env`/DB/upload files → `docker build -t buzzdrop-test .` → fail if a decoy is in the image (`.dockerignore`, #163) → `docker save` → upload the image as an artifact |
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
- E2E of the admin token UI: the users page is covered in the DOM layer (§7), and nothing in it needs a real browser plus server.
- SRI for ES modules imported by entry scripts. It was fixed outside this strategy by the import map in `base.html` ([SRI does not cover ES modules imported by entry scripts](https://github.com/buzzdrop/buzzdrop/issues/166)), and the DOM fixtures strip that map.
- The `/release` 404-vs-403 mismatch. It was fixed outside this strategy ([Burned share: /release returns 404, CLAUDE.md says 403, view.js shows a generic error](https://github.com/buzzdrop/buzzdrop/issues/169)): 404 is the intended answer for a missing or burned share, `CLAUDE.md` now says so, and `view.js` shows a message for it. The fake and contract follow whatever `app.py` returns.
