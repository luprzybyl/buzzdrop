<p align="center">
  <img src="static/logo.png" alt="Buzzdrop Logo" width="180" />
</p>

<p align="center">
  <a href="https://github.com/luprzybyl/buzzdrop/actions/workflows/ci.yml">
    <img src="https://github.com/luprzybyl/buzzdrop/actions/workflows/ci.yml/badge.svg" alt="Build Status" />
  </a>
</p>

# Buzzdrop: File Sharing That Stings—Just Once! 🐝

**Buzzdrop** is a one-time, self-destructing file drop. Upload files or share secret text notes, get a link, and—BZZT!—they vanish after a single view. Your secrets are safe: everything is encrypted right in your browser, so not even the server can peek.

## Why Buzzdrop?

- 🐝 **One-Time Download**: Each link is a mayfly—one click and it's gone!
- 📝 **Secret Text Notes**: Share passwords, API keys, or sensitive text—no files needed!
- 🔒 **In-Browser Encryption**: Your data is locked tight (AES-GCM + PBKDF2) before it ever leaves your device.
- 💥 **Auto-Delete**: Downloaded or viewed? Boom, gone. No leftovers.
- 🔗 **Smart Sharing**: Generate links with embedded passwords for one-click access, or share separately for extra security.
- ☁️ **Local or S3 Storage**: Choose your hive—local or Amazon S3.
- 👩‍💻 **Configurable**: File types, size limits, and users—tweak in `.env`.
- 📬 **Optional open notifications**: Ask Buzzdrop to email you when a file or secret note is opened, along with the reported decryption result.
- 🛡️ **Security First**: PBKDF2 password hashing, security headers, rate limiting, and IP tracking for accountability.
- 😎 **Modern UI**: Slick, responsive, and buzzing with style.

## Getting Buzzing

1. **Install the buzz**:
   ```bash
   python -m venv .venv
   source .venv/bin/activate
   pip install -r requirements.txt
   ```
2. **Configure your hive** (copy `.env.example` to `.env` and customize):
   ```bash
   cp .env.example .env
   # For production, set FLASK_SECRET_KEY:
   python -c "import secrets; print(secrets.token_hex(32))"
   # Add the output to your .env as FLASK_SECRET_KEY=<generated-key>
   ```
3. **Start the hive**:
   ```bash
   npm install
   npm run build:css
   python app.py
   ```
4. **Fly to**: [http://localhost:5000](http://localhost:5000)

### Refreshing the local CSS build

Buzzdrop now serves its Tailwind-based styling from a local compiled file at `static/css/app.css` rather than the browser Tailwind CDN.

Whenever you change template classes or the Tailwind source file, rebuild the production CSS with:

```bash
npm install
npm run build:css
```

The editable source lives in `static/css/tailwind.css`, and the compiled output is committed so production deployments do not need Node installed at runtime.

---

## 🐳 Dockerized Buzz (The Fastest Flight!)

Want to get buzzing in a single command? Docker’s your jetpack!

```bash
# Build the hive
docker-compose build

# Let the swarm fly
docker-compose up
```

- Your files & database are safe—volumes are shared with your host.
- App will buzz at [http://localhost:5000](http://localhost:5000)
- Customize with your `.env` as usual!

Stop the swarm with `docker-compose down`—no mess, no leftovers.

---

## How to Use

### For Files:
1. Log in (buzzers only!)
2. Select **"Upload File"** tab and choose your file.
3. Set a strong password and optional expiry date.
4. Get your shareable link with **two sharing modes**:
   - **🔗 One-Click Link**: Password embedded in URL fragment (convenient, but less secure)
   - **🔒 Separate Sharing**: Share link and password via different channels (maximum security)
5. Recipient opens link, confirms download, enters password (or auto-filled from URL), and decrypts.
6. First download zaps the file from existence—BZZT!
7. Optionally enable **"Notify me when this is opened"** to receive a single email after the recipient attempts decryption.

### For Secret Text Notes:
1. Log in and switch to **"Share Text Note"** tab.
2. Type or paste your secret text (passwords, API keys, confidential messages).
3. Set a strong password and optional expiry date.
4. Share the link—recipient views the text once, then it vanishes!
5. Optionally enable an uploader notification email for the first open attempt.

### Security Tips:
- For maximum security, use **separate sharing**: send the link via email and password via SMS/Signal.
- For convenience with trusted recipients, use **one-click links** (password in URL fragment).
- Set expiry dates for time-sensitive secrets.
- Monitor your shared files dashboard—see download timestamps and IP addresses.

## Security Buzz

Buzzdrop takes security seriously. Here's how we protect your secrets:

### Encryption & Storage:
- **Client-Side Encryption**: AES-GCM with 256-bit keys derived from your password (PBKDF2, 100k iterations).
- **Zero-Knowledge**: Files and text notes are encrypted in your browser before upload—the server never sees your data.
- **Unique UUIDs**: Every file has a cryptographically random identifier (no guesswork).
- **S3 Support**: Files never exposed directly—always routed through Buzzdrop's secure backend.

### Authentication & Sessions:
- **PBKDF2-SHA256 Password Hashing**: User passwords hashed with 1M iterations and random salts.
- **Persistent Sessions**: Secret key management for multi-worker deployments (configurable via `FLASK_SECRET_KEY`).
- **Constant-Time Comparison**: Prevents timing attacks on password verification.

### HTTP Security Headers:
- `X-Frame-Options: DENY` - Prevents clickjacking attacks
- `X-Content-Type-Options: nosniff` - Blocks MIME-type sniffing
- `Content-Security-Policy` - Restricts resource loading
- `Strict-Transport-Security` (HSTS) - Forces HTTPS in production
- `Referrer-Policy: no-referrer` - Prevents information leakage

### Subresource Integrity (SRI):
- **Runtime Hash Verification**: All JavaScript files include SHA-384 integrity checks.
- **Tamper Detection**: Browser verifies file integrity before execution—blocks modified or compromised scripts.
- **Zero Trust**: Protects against CDN compromises and man-in-the-middle attacks on static assets.

### Audit & Accountability:
- **IP Tracking**: Records client IP addresses for all downloads (displayed in your dashboard).
- **Download Timestamps**: Track exactly when files were accessed.
- **Optional uploader notifications**: A one-time email can include the share name/type, open timestamp, and whether client-side decryption was reported as successful or failed.
- **Sanitized Logging**: No sensitive data (bucket names, file paths) exposed in logs.

### Rate Limiting:
- **Implemented with Flask-Limiter**: configurable per-route limits protect `/login`, `/api/token`, `/upload`, and public file access (`/view/<id>`, `/view/<id>/confirm`, `/download/<id>`).
- **Environment configurable**: tune `LOGIN_RATE_LIMIT`, `API_TOKEN_RATE_LIMIT`, `UPLOAD_RATE_LIMIT`, `PUBLIC_FILE_RATE_LIMIT`, `RATE_LIMIT_ENABLED`, and `RATE_LIMIT_STORAGE_URI` in `.env`.
- **Proxy safety by default**: Buzzdrop intentionally ignores `X-Forwarded-For` for rate-limit enforcement and uses the direct peer address (`request.remote_addr`) instead, so a direct client cannot spoof a new IP on every request to bypass limits.
- **Reverse proxy caveat**: if you deploy behind nginx, Cloudflare, an ingress, or another proxy without explicit trusted-proxy handling in your stack, `request.remote_addr` may be the proxy address and multiple users behind that proxy may share one rate-limit bucket. Configure your proxy/deployment to pass and trust client IPs correctly rather than enabling blind trust in `X-Forwarded-For`.
- Recommended: keep these app-level limits and deploy behind nginx/Cloudflare/AWS WAF for defense in depth.

### Input Validation:
- Base64 validation with size limits on encrypted uploads.
- File type and size restrictions (configurable in `.env`).
- Expiry date validation and automatic cleanup.

### Open Notification Configuration:
- Extend user records to optionally include an account email in `.env`: `FLASK_USER_N=username:password:is_admin[:email[:email_verified]]`
- Configure SMTP with `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_FROM_EMAIL`, `SMTP_USE_TLS`, `SMTP_USE_SSL`, and `SMTP_TIMEOUT_SECONDS`
- If the upload form's notification email is left blank, Buzzdrop uses the logged-in user's configured email only when it is marked as verified
- If email delivery fails, Buzzdrop logs the failure and keeps the share available in the dashboard without retrying automatically

## S3? No Problem!

Just fill out your `.env` with your S3 details. Buzzdrop will handle the swarm.

---

Ready to buzz? Drop a file and watch it fly—then disappear!  
_Powered by caffeine, code, and a little bit of sting._

## `buzz` CLI — Share from the Terminal

The `buzz` command-line tool lets you encrypt and upload files directly from your laptop without opening a browser.

### Installation

Download the latest binary from [GitHub Releases](https://github.com/luprzybyl/buzzdrop/releases) and put it on your `$PATH`:

```bash
curl -fsSL https://github.com/luprzybyl/buzzdrop/releases/latest/download/buzz -o ~/.local/bin/buzz
chmod +x ~/.local/bin/buzz
```

Or run from source (requires `pip install -r requirements-cli.txt`):

```bash
ln -s $(pwd)/cli/buzz ~/.local/bin/buzz
```

### Setup

1. **Get an API token** — ask an admin to generate one for your account:
   ```bash
   # Admin runs on the server (or via curl while logged in as admin):
   curl -s -X POST https://your-buzzdrop.example.com/api/token \
     -H 'Content-Type: application/json' \
     -b 'session=<admin-session-cookie>' \
     -d '{"username": "yourname"}' | jq -r .token
   ```

2. **Create `~/.buzz_token`**:
   ```bash
   echo '{"token": "PASTE_TOKEN_HERE", "server": "https://your-buzzdrop.example.com"}' \
     > ~/.buzz_token
   chmod 600 ~/.buzz_token
   ```

   > **Breaking change:** tokens generated before the PBKDF2-HMAC-SHA256 rollout are no longer accepted in this release. If an older token stops working, generate a replacement with `POST /api/token` and update `~/.buzz_token`.

### Usage

```bash
buzz file.pdf                        # auto-generates a 4-word passphrase
buzz file.pdf -p my-secret-pass      # use your own password
buzz file.pdf --expiry 2025-12-31T23:59
```

Output:
```
Encrypting file.pdf... done
Uploading... done

Share link:     https://your-buzzdrop.example.com/view/abc123
Password:       tiger-ocean-lamp-drift

One-click link: https://your-buzzdrop.example.com/view/abc123#tiger-ocean-lamp-drift
```

The recipient opens the share link, enters the password (or uses the one-click link), and the file decrypts in their browser — exactly the same as a web upload.

---

## API Token Management

The `/api/token` endpoint lets any logged-in user issue an API token for themselves, and lets admins issue API tokens for other users.

**Generate a token** (logged-in session required; admin required only when requesting a different user):
```bash
POST /api/token
Content-Type: application/json

{"username": "targetuser"}
```
Returns `{"token": "<64-char hex>", "expires_at": "<ISO-8601 timestamp>"}` — **shown once, store it immediately**.

By default, tokens expire after 30 days. You can optionally pass `{"expires_in_days": 7}` when creating a token to shorten or extend that lifetime.

Tokens are stored as deterministic PBKDF2-HMAC-SHA256 digests in the database; the raw value is never persisted. The hash secret can be set explicitly with `TOKEN_HASH_SECRET`, otherwise Buzzdrop falls back to `FLASK_SECRET_KEY` when it is configured and to a stable built-in development fallback when it is not. **Breaking change:** legacy API tokens generated before the PBKDF2 migration are no longer accepted; users must generate replacement tokens with `POST /api/token`. Logged-in users can list their active tokens with `GET /api/tokens` and revoke one with `POST /api/tokens/<token_id>/revoke`. Admins can also review and revoke active tokens for any user from the **Manage Users** page.


The application is built with:
- **Flask** (Python web framework)
- **Werkzeug** (secure password hashing and file handling)
- **TinyDB** (lightweight JSON database)
- **Flask-Limiter** (rate limiting middleware)
- **Boto3** (AWS S3 integration)
- **Tailwind CSS** (modern responsive styling)
- **Web Crypto API** (client-side AES-GCM encryption)

### Test Coverage:
The project includes comprehensive test coverage with **72 passing tests**:
- Unit tests for password hashing, utilities, database operations, and SRI hash generation
- Integration tests for authentication, file uploads, downloads, text notes, and SRI attributes
- All security features validated through automated testing

## Production Deployment

Before deploying Buzzdrop to production, ensure you:

1. **Generate a secure secret key**:
   ```bash
   python -c "import secrets; print(secrets.token_hex(32))"
   # Set FLASK_SECRET_KEY in your .env with this value
   ```

2. **Reset all user passwords**: Old SHA-256 hashes are incompatible with the new PBKDF2 system. Update all `FLASK_USER_*` entries in your `.env`.

3. **Enable HTTPS**: Security headers like HSTS require HTTPS. Configure your reverse proxy (nginx/Apache) with valid SSL/TLS certificates.

4. **Configure rate limiting**: Review the built-in Flask-Limiter settings in `.env`, make sure your reverse-proxy deployment preserves the real client IP safely, and layer nginx, Cloudflare, or AWS WAF limits on top for production-grade protection.

5. **Set up S3 (optional)**: For scalable storage, configure `STORAGE_BACKEND=s3` and provide AWS credentials in `.env`.

6. **Review IP tracking**: Client IP addresses are logged for accountability. Ensure compliance with your privacy policy and local regulations (GDPR, etc.).

7. **Test security headers**:
   ```bash
   curl -I https://your-domain.com
   # Verify X-Frame-Options, X-Content-Type-Options, CSP, etc. are present
   ```

For detailed security documentation, see `SECURITY_FIXES_SUMMARY.md` and `SECURITY_AUDIT_REPORT.md`.

## License

MIT License

## Running Tests

This project uses [pytest](https://docs.pytest.org/) for automated testing.

To run the full suite of unit and integration tests, navigate to the root directory of the project and execute:

```bash
pytest -v
```

This command will automatically discover and run all tests located in the `tests/` directory. The `-v` flag provides verbose output.
