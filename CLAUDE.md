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

**Single-File Flask Application** (`app.py`): All backend logic is in one file (~580 lines) handling routes, authentication, file storage, and database operations.

**Client-Side Encryption** (`static/js/main.js`): Files are encrypted in the browser using Web Crypto API (AES-GCM with PBKDF2 key derivation) before upload. The encryption workflow:
1. Derives key from password using PBKDF2 (100k iterations)
2. Prepends magic header `BKP-FILE` to file data for integrity validation
3. Encrypts with AES-GCM using random salt and IV
4. Uploads concatenated: `salt (16 bytes) + iv (12 bytes) + encrypted data`

Decryption happens client-side during download in `static/js/view.js`.

### Storage Architecture

**Dual Storage Backend**: Configurable via `.env` `STORAGE_BACKEND` variable:
- `local`: Files stored in `uploads/` directory with UUID filenames
- `s3`: Files stored in S3 bucket under `uploads/{uuid}` keys

Storage abstraction is handled inline in `app.py` with conditional checks on `STORAGE_BACKEND` throughout upload/download/delete routes.

### Database

**TinyDB** (JSON-based): Lightweight NoSQL database stored in `db.json`. Single `files` table tracks:
- `id` (UUID), `original_name`, `path` (local or S3 key)
- `created_at`, `downloaded_at`, `expiry_at` timestamps
- `uploaded_by` (username), `status` (active/expired)
- `decryption_success` (bool, tracked after client-side decryption)

**Database Helper Functions**:
- `get_db()`: Returns TinyDB instance, handles reopening if closed (important for tests)
- `get_files_table()`: Returns files table using current app context

### Authentication

**Environment-Based Users**: No database for users. Configured via `.env`:
```
FLASK_USER_1=username:password:is_admin
```

Passwords are SHA-256 hashed. `get_users()` function reads all `FLASK_USER_*` environment variables at runtime.

**Decorators**:
- `@login_required`: Checks session for username
- `@admin_required`: Checks both login and admin flag

### Key Routes

- `/upload` (POST): Receives encrypted file, stores with UUID, returns share link
- `/view/<file_id>` (GET): Shows download confirmation page
- `/view/<file_id>/confirm` (POST): Shows decryption interface
- `/download/<file_id>` (GET): Serves file once, marks as downloaded, deletes file
- `/delete/<file_id>` (POST): Manual deletion by uploader
- `/report_decryption/<file_id>` (POST): Records if client-side decryption succeeded

### File Lifecycle

1. User uploads file → encrypted in browser
2. Server receives encrypted blob, assigns UUID, stores (local/S3)
3. Database entry created with `status: active`
4. Share link generated: `/view/{uuid}`
5. Recipient visits link → confirms download → JS fetches encrypted file
6. JS decrypts client-side, triggers browser download
7. After download, file marked with `downloaded_at`, deleted from storage
8. Optional: Files with `expiry_at` are auto-deleted by `check_and_handle_expiry()`

### Test Configuration

Tests use `conftest.py` fixtures:
- Temporary upload directory and database file per test session
- Test users: `testuser:password:false` and `adminuser:adminpass:true`
- Environment variables set in fixtures for user authentication
- Database tables truncated per test function for isolation

Test structure:
- `tests/unit/`: Unit tests for utilities and database functions
- `tests/integration/`: Integration tests for routes and workflows

### Environment Configuration

Key variables in `.env`:
- User management: `FLASK_USER_N=username:password:is_admin`
- Storage: `STORAGE_BACKEND`, `UPLOAD_FOLDER`
- S3: `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_REGION`
- Limits: `MAX_CONTENT_LENGTH`, `ALLOWED_EXTENSIONS`
- Database: `DATABASE_PATH`

### Deployment

**Passenger WSGI**: `passenger_wsgi.py` provides WSGI entry point with PATH_INFO encoding fixes for production deployment.

**Docker**: Single-service compose with volume mounts for `uploads/` and `db.json` persistence.
