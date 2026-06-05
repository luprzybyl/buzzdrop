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

Buzzdrop is a one-time self-destructing file-sharing app where files are encrypted client-side (AES-GCM + PBKDF2) before upload. The server never handles plaintext data.

**Module layout** — the app was refactored from a single-file monolith; responsibilities are now split:
- `app.py` — Flask routes, `get_db()`/`get_files_table()` helpers, SRI context processor, startup logic
- `models.py` — `FileRepository`: all TinyDB CRUD via a repository pattern
- `storage.py` — `StorageBackend` ABC with `LocalStorage` and `S3Storage` implementations
- `auth.py` — user loading from env vars, `@login_required`/`@admin_required` decorators
- `config.py` — `Config`/`DevelopmentConfig`/`TestingConfig`/`ProductionConfig`; selected via `FLASK_ENV`
- `tokens.py` — `generate_api_token`, `validate_api_token`, `revoke_api_token`; token hashes stored in TinyDB `api_tokens` table
- `cli/buzz` — standalone CLI script (install to `$PATH`; deps in `requirements-cli.txt`)
- `static/js/main.js` — client-side encryption on upload
- `static/js/view.js` — client-side decryption on download

**File lifecycle:**
1. Browser encrypts file → POST `/upload` → stored with UUID filename (local path or S3 key)
2. DB entry created: `status: active`, `downloaded_at: null`
3. Recipient visits `/view/<id>` → confirms → `/view/<id>/confirm` renders decryption UI
4. Browser fetches `/download/<id>` → file streamed once, then deleted from storage; `downloaded_at` set
5. Optional expiry: `check_and_handle_expiry()` marks `status: expired` and deletes storage file

**Storage abstraction:** `get_storage_backend(config)` returns either `LocalStorage` or `S3Storage`. Both expose `save(file_id, file_data) -> path`, `retrieve(path) -> Iterator[bytes]`, `delete(path)`. The `path` stored in DB is a local filesystem path for local storage and an S3 key (`uploads/{uuid}`) for S3.

**API token auth:** `POST /api/token` (admin-only, JSON `{"username": "..."}`) issues a raw token shown once. The `@api_auth_required` decorator on `/upload` accepts either `Authorization: Bearer <token>` or a session cookie. When a Bearer header is present and invalid → 401 JSON (no session fallback). On success it sets `flask.g.username`; routes read `g.username` not `session['username']`. Tokens are stored as SHA-256 hashes in TinyDB `api_tokens` table — never the raw token.

**`buzz` CLI** (`cli/buzz`): encrypts a file with the same AES-GCM format as the browser, then uploads via Bearer token. Reads `~/.buzz_token` as JSON `{"token": "...", "server": "https://..."}`. Requires `cryptography` and `requests` (see `requirements-cli.txt`). Generates a 4-word passphrase if `-p` is omitted.

 All `<script>` tags must include `integrity="{{ sri_hash('js/filename.js') }}" crossorigin="anonymous"`. In development, missing files raise `FileNotFoundError`; in production they log a warning.

## Key Conventions

**Users are environment variables, not a database.** Format: `FLASK_USER_N=username:password:is_admin`. `get_users()` in `auth.py` is decorated with `@lru_cache` — it hashes passwords on first call. In tests, **clearing and re-adding `FLASK_USER_*` env vars requires calling `get_users.cache_clear()`** or the cached result will be stale.

**`FileRepository` resolves its table lazily.** When initialized without a `files_table` argument (the default), `table` property calls `from app import get_files_table` at access time, which respects the current Flask app context. Tests that supply a table directly bypass this.

**`get_db()` handles closed handles.** TinyDB file handles can go stale across test teardowns. `get_db()` checks `database._storage._handle.closed` and reopens if needed — do not bypass this with direct `TinyDB()` calls in new code.

**Test isolation:** `conftest.py` sets `FLASK_USER_1`/`FLASK_USER_2` at module level before any imports. The `db_instance` fixture is `scope='function'` and truncates all tables per test. The `app` fixture is `scope='session'` with a shared temp DB file.

**Encrypted binary format (client-side):** `salt (16 bytes) + iv (12 bytes) + AES-GCM ciphertext`. The plaintext has magic header `BKP-FILE` prepended before encryption for integrity validation on decrypt.

**Type field:** DB entries have `type: 'file'` or `type: 'text'` (text notes). Text note content is base64-encoded encrypted data sent via form field `note_text`; file uploads use `multipart/form-data` with field `file`.

**AJAX detection:** Routes check `request.headers.get('X-Requested-With') == 'XMLHttpRequest'` to decide between JSON and redirect responses.
