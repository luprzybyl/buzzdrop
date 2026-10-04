# Copilot Instructions

## Commands

```bash
# Setup
python -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt

# Run app
python app.py

# Run all tests
pytest -v

# Run a single test file
pytest tests/unit/test_db.py -v

# Run a single test function
pytest tests/integration/test_app.py::test_function_name -v
```

## Architecture

Buzzdrop is a one-time self-destructing file-sharing app where files are encrypted client-side (AES-GCM) under a **server-gated key release** scheme (`docs/true-one-time.md` §6): `file_key = HKDF(Kp ‖ H)` where `Kp` derives from the password and `H` is a server-held share released exactly once. The server never handles plaintext data.

**Module layout** — the app was refactored from a single-file monolith; responsibilities are now split:
- `app.py` — Flask routes, `get_backend()`/`get_files_store()` helpers, SRI context processor, startup logic
- `db/` — swappable storage backends: `base.py` defines `FileStore`/`TokenStore`/`Backend`, `sqlite_backend.py` implements them over raw `sqlite3`, `create_backend(DATABASE_URL)` selects by URL scheme
- `models.py` — `FileRepository`: domain facade delegating to the injected `FileStore`
- `storage.py` — `StorageBackend` ABC with `LocalStorage` and `S3Storage` implementations
- `auth.py` — user loading from env vars, `@login_required`/`@admin_required` decorators
- `config.py` — `Config`/`DevelopmentConfig`/`TestingConfig`/`ProductionConfig`; selected via `FLASK_ENV`
- `tokens.py` — `generate_api_token`, `validate_api_token`, `revoke_api_token`; token hashes stored via `TokenStore` (`api_tokens` table)
- `utils.py` — shared helpers: `enhance_file_display()` (formats timestamps + adds `status_display`), `allowed_file()`, `get_client_ip()` (proxy-aware), `cleanup_orphaned_files()`. `DEFAULT_TIMEZONE = 'Europe/Warsaw'`.
- `cli/buzz` — standalone CLI script (install to `$PATH`; deps in `requirements-cli.txt`)
- `static/js/main.js` — client-side encryption on upload
- `static/js/view.js` — client-side decryption on download

**File lifecycle:**
1. Browser calls `POST /upload/begin` → server mints `{file_id, h}` (random 32-byte share, hex); a pending row lands in the `file_keys` table
2. Browser derives `file_key = HKDF(Kp ‖ H)`, encrypts plaintext `BKP-FILE ‖ receipt(32B) ‖ data`, then `POST /upload` with `file_id` + `key_verifier` (hex verifier V) + `receipt_hash` (SHA-256 of the receipt) → V is bound to the pending share atomically (owner-checked via `created_by`, 403 for another account), blob stored (local path or S3 key), `files` entry created: `status: active`, `downloaded_at: null`
3. Recipient visits `/view/<id>` → confirms → `/view/<id>/confirm` renders decryption UI
4. Browser fetches `/download/<id>` → ciphertext streamed once, then deleted from storage; `downloaded_at` set
5. Browser `POST /release/<id>` `{v}` → `attempt_key_release` runs the whole read/compare/count/release in ONE transaction, returns `h` exactly once (later calls → 410; wrong V → 403; lockout → 429; missing/pending → 404). Misses increment `file_keys.attempts`; lockout at `KEY_RELEASE_MAX_ATTEMPTS` (with `KEY_RELEASE_BURN_ON_LOCKOUT` — the default — the row — and H — is deleted). `/release` is rate-limited per file_id, not per IP. The client then posts the embedded `receipt` to `/report_decryption` — the server validates it against `receipt_hash` and the NULL-guarded write lets only the first valid report set `decryption_success`
6. Browser derives `file_key` and decrypts client-side
7. Optional expiry: `check_and_handle_expiry()` marks `status: expired`, deletes storage file, and burns the `file_keys` row in the same transaction

**Storage abstraction:** `get_storage_backend(config)` returns either `LocalStorage` or `S3Storage`. Both expose `save(file_id, file_data) -> path`, `retrieve(path) -> Iterator[bytes]`, `delete(path)`. The `path` stored in DB is a local filesystem path for local storage and an S3 key (`uploads/{uuid}`) for S3.

**API token auth:** `POST /api/token` (admin-only, JSON `{"username": "..."}`) issues a raw token shown once. The `@api_auth_required` decorator on `/upload` and `/upload/begin` accepts either `Authorization: Bearer <token>` or a session cookie. When a Bearer header is present and invalid → 401 JSON (no session fallback). On success it sets `flask.g.username`; routes read `g.username` not `session['username']`. Tokens are stored as PBKDF2-HMAC-SHA256 digests in the `api_tokens` table via `TokenStore` — never the raw token.

**`buzz` CLI** (`cli/buzz`): encrypts a file with the same `BKV3` format as the browser and runs the same two-phase upload (`/upload/begin` → `/upload`); aborts if begin 404s. Uploads via Bearer token. Reads `~/.buzz_token` as JSON `{"token": "...", "server": "https://..."}`. Requires `cryptography` and `requests` (see `requirements-cli.txt`). Generates a 4-word passphrase if `-p` is omitted.

 All `<script>` tags must include `integrity="{{ sri_hash('js/filename.js') }}" crossorigin="anonymous"`. In development, missing files raise `FileNotFoundError`; in production they log a warning.

## Key Conventions

**Users are environment variables, not a database.** Format: `FLASK_USER_N=username:password:is_admin`. `get_users()` in `auth.py` is decorated with `@lru_cache` — it hashes passwords on first call. In tests, **clearing and re-adding `FLASK_USER_*` env vars requires calling `get_users.cache_clear()`** or the cached result will be stale.

**`FileRepository` resolves its store lazily.** When initialized without a `files_store` argument (the default), the `store` property calls `from app import get_files_store` at access time, which respects the current Flask app context. Tests that supply a store directly bypass this.

**`get_backend()` recreates backends on config change.** It compares the canonicalized `DATABASE_URL` against `backend.url`, closes the displaced backend, and skips closed ones — do not construct `SQLiteBackend` directly in new code; go through `create_backend()`.

**Test isolation:** `conftest.py` sets `FLASK_USER_1`/`FLASK_USER_2` at module level before any imports. The `db_instance` fixture is `scope='function'` and truncates all tables per test. The `app` fixture is `scope='session'` with a shared temp DB file.

**Encrypted binary format (client-side, `BKV3` only):** `BKV3 ‖ salt (16 bytes) ‖ iv (12 bytes) ‖ AES-GCM ciphertext`. Key derivation: `master = PBKDF2-SHA256(password, salt, 600k)`, `Kp = HKDF(master, salt, 'enc')`, `V = HKDF(master, salt, 'ver')`, `file_key = HKDF(Kp ‖ H, salt, 'file')` — `H` is the server share from `file_keys`, `V` the verifier sent on upload/release (both as hex). The plaintext is `BKP-FILE ‖ receipt(32B random) ‖ payload` — the receipt is the decryption proof reported back to `/report_decryption` (server stores only `SHA-256(receipt)` as `receipt_hash`). Legacy v1/v2 blobs are rejected — no backward compatibility (pre-production wipe).

**Key-release config:** `KEY_RELEASE_RATE_LIMIT` (10/min per file_id), `KEY_RELEASE_MAX_ATTEMPTS` (1), `KEY_RELEASE_BURN_ON_LOCKOUT` (default on — lockout deletes the `file_keys` row, H+V destroyed; off keeps the row but permanently refuses releases — currently no unlock path), `KEY_SHARE_PENDING_TTL_SECONDS` (default 3600 — stale pending shares swept at startup and on `/upload/begin`). `/upload/begin` and `/upload` share the `UPLOAD_RATE_LIMIT` bucket. SQLite runs `PRAGMA secure_delete=ON` + WAL `TRUNCATE` checkpoint after burns.

**Type field:** DB entries have `type: 'file'` or `type: 'text'` (text notes). Text note content is base64-encoded encrypted data sent via form field `note_text`; file uploads use `multipart/form-data` with field `file`.

**AJAX detection:** Routes check `request.headers.get('X-Requested-With') == 'XMLHttpRequest'` to decide between JSON and redirect responses.

**CSRF on session-authed mutating routes:** `_session_csrf_required()` gates `POST /upload`, `/upload/begin`, `/api/token` (and the form-based delete/confirm/revoke routes). The token travels as `X-CSRF-Token` header, `csrf_token` form field, or JSON field; templates render `<meta name="csrf-token">` (JS reads it in main.js) and hidden form inputs. Requests carrying an `Authorization` header are exempt — cross-site requests can't set it, so Bearer clients are CSRF-immune. Public POSTs (`/release`, `/report_decryption`) have no CSRF gate by design.

**`sdk/` directory:** Contains a vendored copy of the Dagger Python SDK used by the Dagger-based CI pipeline. It is not part of the web application and should not be modified.

**CLI binary releases:** Pushing to `main` with changes under `cli/` or `requirements-cli.txt` triggers `.github/workflows/release-cli.yml`, which builds a PyInstaller single-file binary and publishes it to GitHub Releases automatically.
