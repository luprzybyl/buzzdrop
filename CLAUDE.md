# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Buzzdrop is a one-time, self-destructing file-sharing Flask application with client-side encryption. Files are encrypted in the browser before upload and can only be downloaded once before being automatically deleted.

## Development Commands

### Setup
```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### Running the Application
```bash
# Local development
python app.py

# Docker
docker-compose build
docker-compose up
```

### Testing
```bash
# Run all tests with verbose output
pytest -v

# Run specific test file
pytest tests/unit/test_db.py -v

# Run specific test function
pytest tests/unit/test_db.py::test_function_name -v
```

## Architecture

### Core Components

**Single-File Flask Application** (`app.py`): All backend logic is in one file handling routes, authentication, file storage, database operations, and security features.

**Subresource Integrity (SRI)**: Flask context processor (`sri_hash_processor`) generates SHA-384 hashes for JavaScript files at runtime. All `<script>` tags include `integrity` and `crossorigin` attributes to verify file integrity before execution.

**Client-Side Encryption** (`static/js/crypto.js`, driven by `static/js/main.js`): Files are encrypted in the browser using Web Crypto API under a **server-gated key release** scheme (see `docs/true-one-time.md` §6). The file key is split — one half derives from the password, the other half (`H`, 32 random bytes) lives in the `file_keys` table and is released exactly once — so a stolen ciphertext alone is not brute-forceable offline. Upload is always two-phase:

1. `POST /upload/begin` → server mints `file_id` and a random share `H`, returns `{file_id, h}` (H as hex)
2. `master = PBKDF2-SHA256(password, salt, 600k)`; `Kp = HKDF(master, salt, 'enc')`, `V = HKDF(master, salt, 'ver')`
3. `file_key = HKDF(Kp ‖ H, salt, 'file')`; plaintext is `BKP-FILE ‖ receipt(32B random) ‖ data` (the receipt is the decryption proof — the server stores only its SHA-256), then AES-GCM encrypted
4. Envelope: `BKV3 ‖ salt(16) ‖ iv(12) ‖ ciphertext`, uploaded with `file_id` + `key_verifier` (hex V) + `receipt_hash` — the server binds V to the pending share atomically (only the account that ran `begin` may finish: `created_by` check, 403 otherwise)

Decryption in `static/js/view.js`: fetch the blob, derive `V` from the password, `POST /release/<file_id>` `{v}` → the server returns `H` exactly once (the whole read→check→count→release cycle is one transaction, `attempt_key_release`); the client derives `file_key`, decrypts, extracts the receipt, and reports it to `/report_decryption` — which validates `SHA-256(receipt)` and writes `decryption_success` once (first valid report wins). **`BKV3` is the only supported format** — legacy v1/v2 shares are rejected (deliberate pre-production format break, no backward compatibility).

### Storage Architecture

**Dual Storage Backend**: Configurable via `.env` `STORAGE_BACKEND` variable:
- `local`: Files stored in `uploads/` directory with UUID filenames
- `s3`: Files stored in S3 bucket under `uploads/{uuid}` keys

Storage abstraction is handled inline in `app.py` with conditional checks on `STORAGE_BACKEND` throughout upload/download/delete routes.

### Database

**SQLite** (stdlib `sqlite3` via the `db/` package): Swappable-backend storage selected by `DATABASE_URL` (default `sqlite:///buzzdrop.db`). `db/base.py` defines the `FileStore`/`TokenStore` interfaces and `Backend` container; `db/sqlite_backend.py` is the SQLite implementation over raw DB-API with typed columns (plus an `extra` JSON overflow column). `db.create_backend(url)` picks the backend by URL scheme. New engines (PostgreSQL/MySQL/…) implement the two stores, register a scheme, and must pass `tests/contract/test_backend_contract.py`. Two tables:

`files` table tracks:
- `id` (UUID), `original_name`, `path` (local or S3 key)
- `created_at`, `downloaded_at`, `expiry_at` timestamps
- `uploaded_by` (username), `status` (active/expired)
- `downloaded_by_ip` (IP address of client who downloaded the file)
- `decryption_success` (bool, written once via `record_decryption_result` — NULL-guarded so the first receipt-backed report wins)
- `receipt_hash` (SHA-256 of the in-plaintext decryption receipt — `/report_decryption` must present a matching receipt)
- `type` (`'file'` or `'text'` for text notes)

`api_tokens` table tracks:
- `token_hash` (PBKDF2-HMAC-SHA256 fingerprint of the raw token — raw token is never stored)
- `username`, `created_at`, `last_used_at`, `expires_at`

`file_keys` table tracks the server-held key-release material (one row per share; kept off `files` because the share must exist before the file record does, and because deleting the row burns H):
- `file_id` (UUID minted by `/upload/begin`, unique), `h` (server key share, 32 bytes as hex)
- `v` (password verifier, hex — NULL until `/upload` binds it atomically)
- `created_by` (uploader username — only that account may finish the pending share)
- `attempts` (failed-release counter), `released_at` (set once by the atomic `attempt_key_release` transaction, which also wipes `h`/`v`), `created_at`
- `FileRepository.delete()` drops the row with the file; `burn_key_share()` deletes it alone (crypto-shredding H — SQLite runs `secure_delete=ON` + WAL `TRUNCATE` checkpoint); expiry burns the share; stale pending shares are swept after `KEY_SHARE_PENDING_TTL_SECONDS` (startup + each `/upload/begin`)

**Database Helper Functions**:
- `get_backend()`: Returns the `Backend` (.files/.tokens stores), recreating it when DATABASE_URL changed (important for tests)
- `get_files_store()`: Returns the FileStore using current app context

### Authentication

**Environment-Based Users**: No database for users. Configured via `.env`:
```
FLASK_USER_N=username:password:is_admin
```

Passwords are hashed with PBKDF2-SHA256 via Werkzeug. `get_users()` function reads all `FLASK_USER_*` environment variables at runtime and is decorated with `@lru_cache`.

**Decorators**:
- `@login_required`: Checks session for username
- `@admin_required`: Checks both login and admin flag
- `@api_auth_required`: Accepts `Authorization: Bearer <token>` header **or** session cookie. If Bearer is present and invalid → 401 JSON (no session fallback). Sets `flask.g.username` on success; routes must read `g.username` not `session['username']`.

**CSRF**: Session-authed mutating routes (`/upload`, `/upload/begin`, `/api/token`, `/delete/<id>`, `/view/<id>/confirm`, token revocation) call `_session_csrf_required()` — it accepts the token via `X-CSRF-Token` header, `csrf_token` form field, or JSON field; a request carrying an `Authorization` header is exempt (cross-site requests can't set one — Bearer clients are CSRF-immune). Public unauthenticated POSTs (`/release`, `/report_decryption`) intentionally have no CSRF gate. JS clients read the token from `<meta name="csrf-token">` in base.html.

### API Token Management

`tokens.py` provides:
- `generate_api_token(username)` → stores a PBKDF2-HMAC-SHA256 fingerprint in `api_tokens` table, returns raw 64-char token (shown once)
- `validate_api_token(raw_token)` → returns username or None, updates `last_used_at`
- `revoke_api_token(raw_token)` → removes entry from table

**Generate a token** (admin only):
```bash
POST /api/token
Content-Type: application/json
{"username": "targetuser"}
# Response: {"token": "<64-char hex>"}  ← store immediately, never shown again
```

### CLI Tool (`cli/buzz`)

Standalone Python script. Requires `cryptography` and `requests` (see `requirements-cli.txt`). Reads `~/.buzz_token` as JSON `{"token": "...", "server": "https://..."}`.

```bash
buzz file.pdf                  # generates 4-word passphrase
buzz file.pdf -p mypassword
buzz file.pdf --expiry 2025-12-31T23:59
```

Encrypts files using the same `BKV3` format as the browser client and runs the same two-phase upload (`/upload/begin` → `/upload`); aborts if the server does not answer begin (i.e. doesn't speak the key-release protocol). Uploads via Bearer token auth. A binary release is automatically built and published to GitHub Releases on every change to `cli/` (see `.github/workflows/release-cli.yml`).

### Key Routes

- `/upload/begin` (POST): Mints `file_id` + server share `H` for the two-phase key-release upload; 404 when `KEY_RELEASE_ENABLED` is off. Shares the `UPLOAD_RATE_LIMIT` bucket with `/upload`
- `/upload` (POST): Completes the key-release upload — requires `file_id` + `key_verifier` + `receipt_hash` form fields, refuses to finish another account's share (403), binds V to the pending share atomically, stores the encrypted blob, returns share link. On storage/DB failure the pending share is burned
- `/view/<file_id>` (GET): Shows download confirmation page
- `/view/<file_id>/confirm` (POST): Shows decryption interface
- `/download/<file_id>` (GET): Serves the ciphertext once, marks as downloaded, deletes file
- `/release/<file_id>` (POST): Server-gated key release — JSON `{v}` → `{h}` on a constant-time match inside one atomic `attempt_key_release` transaction (410 after release, 403 when the share is gone). Misses increment `attempts`; lockout at `KEY_RELEASE_MAX_ATTEMPTS` (optional burn). Rate-limited per `file_id`, not per IP. `Cache-Control: no-store`
- `/delete/<file_id>` (POST): Manual deletion by uploader (also drops the `file_keys` row)
- `/report_decryption/<file_id>` (POST): Records if client-side decryption succeeded — requires the plaintext `receipt` matching the stored `receipt_hash` (403 otherwise), and only the first valid report takes effect

### File Lifecycle

1. Browser calls `/upload/begin` → receives `file_id` + server share `H`; a pending `file_keys` row is created
2. Browser derives `file_key = HKDF(Kp ‖ H)` (see Client-Side Encryption) and encrypts the file
3. `POST /upload` carries the blob + `file_id` + `key_verifier`; server binds V to the pending share atomically, stores the blob (local/S3), DB entry created with `status: active`
4. Share link generated: `/view/{uuid}`
5. Recipient visits link → confirms → JS fetches the ciphertext via `/download/<id>` (served once; `downloaded_at` set, storage deleted)
6. JS derives `V` from the password and posts it to `/release/<id>` → server returns `H` exactly once (later calls get 410)
7. JS derives `file_key`, decrypts, triggers browser download; wrong passwords consume `attempts` → lockout at `KEY_RELEASE_MAX_ATTEMPTS` (with `KEY_RELEASE_BURN_ON_LOCKOUT`, the `file_keys` row is deleted and H is gone)
8. Optional: Files with `expiry_at` are auto-deleted by `check_and_handle_expiry()` — which also burns the `file_keys` row inside the same transaction so H never outlives the file

### Test Configuration

Tests use `conftest.py` fixtures:
- Temporary upload directory and database file per test session
- Test users: `testuser:password:false` and `adminuser:adminpass:true`
- Environment variables set in fixtures for user authentication
- Database tables truncated per test function for isolation

Test structure:
- `tests/unit/`: Unit tests for utilities, database functions, and SRI hash generation
- `tests/integration/`: Integration tests for routes, workflows, and SRI HTML attributes

### Environment Configuration

Key variables in `.env`:
- User management: `FLASK_USER_N=username:password:is_admin`
- Storage: `STORAGE_BACKEND`, `UPLOAD_FOLDER`
- S3: `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_REGION`
- Limits: `MAX_CONTENT_LENGTH`, `ALLOWED_EXTENSIONS`
- Database: `DATABASE_URL` (`DATABASE_PATH` deprecated → sqlite:/// fallback)
- Key release: `KEY_RELEASE_ENABLED` (default on — when off, `/upload/begin` 404s and `/upload` refuses uploads), `KEY_RELEASE_RATE_LIMIT` (default `10 per minute`, per file_id), `KEY_RELEASE_MAX_ATTEMPTS` (default 1), `KEY_RELEASE_BURN_ON_LOCKOUT` (default off — lockout only, keeps H), `KEY_SHARE_PENDING_TTL_SECONDS` (default 3600 — TTL for begun-but-never-finished shares)

### Deployment

**Passenger WSGI**: `passenger_wsgi.py` provides WSGI entry point with PATH_INFO encoding fixes for production deployment.

**Docker**: Single-service compose with volume mounts for `uploads/` and `buzzdrop.db` persistence.
