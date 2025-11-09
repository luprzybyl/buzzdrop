# Security Audit Report: Buzzdrop Application
**Date:** 2025-11-09
**Auditor:** Application Security Consultant
**Application:** Buzzdrop - Secure File Sharing Platform
**Version:** Current main branch

---

## Executive Summary

Buzzdrop is a Flask-based one-time file sharing application with client-side encryption. While the application implements several security best practices (client-side encryption, one-time downloads), **multiple critical and high-severity vulnerabilities** were identified that could compromise the confidentiality, integrity, and availability of shared sensitive data.

**Risk Level: HIGH** ⚠️

### Critical Findings Summary
- **3 Critical Vulnerabilities**
- **5 High Vulnerabilities**
- **8 Medium Vulnerabilities**
- **4 Low Vulnerabilities**

---

## 1. CRITICAL VULNERABILITIES

### 🔴 CRIT-001: No Access Control on File Downloads
**Severity:** CRITICAL
**CVSS Score:** 9.1 (Critical)
**Location:** `app.py:493-550` (`/download/<file_id>`)

**Description:**
The `/download/<file_id>` endpoint has **NO authentication or authorization checks**. Any user (including unauthenticated users) who knows or guesses a file UUID can download encrypted files.

**Code:**
```python
@app.route('/download/<file_id>', methods=['GET'])
def download_file(file_id):  # ← NO @login_required decorator
    files_table = get_files_table()
    file_info = files_table.get(File.id == file_id)
    # ... downloads file without checking who uploaded it
```

**Attack Scenario:**
1. Attacker enumerates UUIDs (v4 UUIDs are predictable if weak randomness)
2. Attacker accesses `/download/<uuid>` directly
3. Downloads encrypted files without authentication
4. Can brute-force passwords offline on encrypted data

**Impact:**
- Complete bypass of authentication
- Unauthorized access to all uploaded files
- Violates principle of least privilege
- Confidentiality breach

**Recommendation:**
```python
@app.route('/download/<file_id>', methods=['GET'])
@login_required  # Add authentication
def download_file(file_id):
    files_table = get_files_table()
    file_info = files_table.get(File.id == file_id)

    # Add authorization check
    if file_info['uploaded_by'] != session['username']:
        # Check if file is explicitly shared with user
        shared_with = file_info.get('shared_with', [])
        if session['username'] not in shared_with:
            flash('Unauthorized access')
            return redirect(url_for('index'))
    # ... rest of code
```

---

### 🔴 CRIT-002: Weak Password Hashing (SHA-256)
**Severity:** CRITICAL
**CVSS Score:** 8.1 (High-Critical)
**Location:** `app.py:111-113`

**Description:**
User passwords are hashed with **SHA-256 without salt**, making them vulnerable to rainbow table attacks and brute-force attacks. SHA-256 is a fast hash designed for data integrity, not password storage.

**Code:**
```python
def hash_password(password):
    """Hash a password using SHA-256."""
    return hashlib.sha256(password.encode()).hexdigest()  # ← No salt, fast hash
```

**Attack Scenario:**
1. Attacker compromises `.env` file or database
2. Obtains SHA-256 password hashes
3. Uses pre-computed rainbow tables or GPU-accelerated cracking
4. Recovers passwords in seconds/minutes

**Impact:**
- User passwords can be recovered if hashes are leaked
- No protection against rainbow tables
- Credential stuffing possible

**Recommendation:**
Use **bcrypt** or **Argon2** with automatic salting:
```python
from werkzeug.security import generate_password_hash, check_password_hash

def hash_password(password):
    return generate_password_hash(password, method='pbkdf2:sha256', salt_length=16)

# In login:
if check_password_hash(user['password'], password):
    # Login successful
```

Or use `passlib`:
```python
from passlib.hash import bcrypt

def hash_password(password):
    return bcrypt.hash(password)
```

---

### 🔴 CRIT-003: Session Secret Key Regenerated on Restart
**Severity:** CRITICAL
**CVSS Score:** 7.5 (High)
**Location:** `app.py:31`

**Description:**
The Flask session secret key is generated with `os.urandom(24)` on **every application restart**, invalidating all existing user sessions.

**Code:**
```python
app.secret_key = os.urandom(24)  # ← Regenerated on restart
```

**Impact:**
- All users forcibly logged out on app restart
- Session fixation attacks possible
- Deployment/scaling issues (multiple workers have different keys)
- Poor user experience

**Recommendation:**
Use a **persistent secret key** from environment variables:
```python
app.secret_key = os.getenv('FLASK_SECRET_KEY')
if not app.secret_key:
    raise ValueError("FLASK_SECRET_KEY must be set in environment")
```

Generate with:
```bash
python -c "import secrets; print(secrets.token_hex(32))"
```

---

## 2. HIGH VULNERABILITIES

### 🟠 HIGH-001: No CSRF Protection
**Severity:** HIGH
**CVSS Score:** 6.8
**Location:** All POST endpoints

**Description:**
The application has **no CSRF tokens** on any forms. All state-changing operations (upload, delete, login) are vulnerable to Cross-Site Request Forgery.

**Attack Scenario:**
```html
<!-- Attacker's malicious website -->
<img src="https://buzzdrop.com/delete/victim-file-uuid" />
<form id="evil" action="https://buzzdrop.com/upload" method="POST">
    <input name="note_text" value="attacker-controlled-data" />
</form>
<script>document.getElementById('evil').submit();</script>
```

**Impact:**
- Attacker can delete victim's files
- Attacker can upload files on victim's behalf
- Attacker can perform actions as authenticated user

**Recommendation:**
Install Flask-WTF and add CSRF protection:
```python
from flask_wtf.csrf import CSRFProtect

csrf = CSRFProtect(app)

# In templates:
<form method="POST">
    {{ csrf_token() }}
    <!-- form fields -->
</form>
```

---

### 🟠 HIGH-002: Header Injection in Content-Disposition
**Severity:** HIGH
**CVSS Score:** 6.5
**Location:** `app.py:518, 546`

**Description:**
User-controlled `original_name` is directly interpolated into the `Content-Disposition` header **without sanitization**, allowing HTTP response splitting and header injection.

**Code:**
```python
'Content-Disposition': f"attachment; filename={file_info['original_name']}"
# ← No sanitization of user input
```

**Attack Scenario:**
Attacker uploads file named:
```
test.txt\r\nX-XSS-Protection: 0\r\n\r\n<script>alert(1)</script>
```

Result:
```http
Content-Disposition: attachment; filename=test.txt
X-XSS-Protection: 0

<script>alert(1)</script>
```

**Impact:**
- HTTP response splitting
- XSS via injected headers
- Cache poisoning

**Recommendation:**
```python
from werkzeug.utils import secure_filename

filename = secure_filename(file_info['original_name'])
# Use RFC 2231 encoding for non-ASCII
'Content-Disposition': f'attachment; filename="{filename}"'
```

---

### 🟠 HIGH-003: Password in URL Fragment (Privacy Leak)
**Severity:** HIGH
**CVSS Score:** 6.8
**Location:** `success.html:61`, URL sharing feature

**Description:**
The application allows embedding passwords in URL fragments (`#password`). While fragments aren't sent to servers, they are:
- Stored in browser history
- Logged by browser extensions
- Visible in referer headers if user clicks external links
- Stored in browser bookmarks

**Code:**
```javascript
const linkWithPassword = shareLink + '#' + encodeURIComponent(pwd);
```

**Impact:**
- Password leakage via browser history
- Password exposure to analytics/extensions
- Passwords stored in bookmarks
- Violates security best practices

**Recommendation:**
1. **Remove** password-in-URL feature entirely
2. Force users to share password via separate secure channel (as originally intended)
3. Add prominent warning about security implications if keeping feature

---

### 🟠 HIGH-004: Information Disclosure in Error Messages
**Severity:** HIGH
**CVSS Score:** 5.9
**Location:** `app.py:73-86`, startup logs

**Description:**
The application prints sensitive configuration details to stdout/logs:
- S3 bucket names
- S3 region
- Upload folder paths
- Bucket listing

**Code:**
```python
print(f"[Startup] Using S3 bucket: {S3_BUCKET} (region: {S3_REGION})")
print(f"[Startup] S3 Connection OK. Buckets: {[b['Name'] for b in buckets.get('Buckets', [])]}")
```

**Impact:**
- Infrastructure details leaked in logs
- Information useful for reconnaissance
- Log aggregation services may expose data

**Recommendation:**
Use proper logging with levels:
```python
import logging
logging.info("Storage backend initialized: %s", STORAGE_BACKEND)
# Don't log sensitive details
```

---

### 🟠 HIGH-005: No Rate Limiting
**Severity:** HIGH
**CVSS Score:** 6.2
**Location:** All endpoints

**Description:**
No rate limiting on any endpoint, allowing:
- Brute-force password attacks on `/login`
- UUID enumeration on `/download/<file_id>`
- Denial of service via upload flooding

**Attack Scenario:**
```python
# Brute force login
for password in password_list:
    requests.post('https://buzzdrop.com/login',
                  data={'username': 'admin', 'password': password})
```

**Impact:**
- Account takeover via brute-force
- DoS via resource exhaustion
- UUID enumeration

**Recommendation:**
Implement Flask-Limiter:
```python
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address

limiter = Limiter(
    app=app,
    key_func=get_remote_address,
    default_limits=["200 per day", "50 per hour"]
)

@app.route('/login', methods=['POST'])
@limiter.limit("5 per minute")
def login():
    # ...
```

---

## 3. MEDIUM VULNERABILITIES

### 🟡 MED-001: Timing Attack on Password Comparison
**Severity:** MEDIUM
**Location:** `app.py:357`

**Code:**
```python
if user and user['password'] == hash_password(password):
```

**Issue:** String comparison is not constant-time, allowing timing attacks to guess passwords character-by-character.

**Recommendation:**
```python
import hmac
if hmac.compare_digest(user['password'], hash_password(password)):
```

---

### 🟡 MED-002: Missing Security Headers
**Severity:** MEDIUM
**Location:** All responses

**Missing headers:**
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Strict-Transport-Security` (HSTS)
- `Content-Security-Policy`
- `Referrer-Policy: no-referrer`

**Recommendation:**
```python
@app.after_request
def set_security_headers(response):
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['X-Frame-Options'] = 'DENY'
    response.headers['X-XSS-Protection'] = '1; mode=block'
    response.headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains'
    response.headers['Referrer-Policy'] = 'no-referrer'
    return response
```

---

### 🟡 MED-003: Predictable UUIDs for File IDs
**Severity:** MEDIUM
**Location:** `app.py:389, 445`

**Issue:** Using `uuid.uuid4()` without verifying Python's randomness source. If `/dev/urandom` is unavailable, UUIDs may be predictable.

**Recommendation:**
```python
import secrets
unique_id = secrets.token_urlsafe(32)  # Cryptographically secure
```

---

### 🟡 MED-004: User Enumeration via Login Timing
**Severity:** MEDIUM
**Location:** `app.py:356-363`

**Issue:** Different execution paths for "user exists" vs "invalid password" allow username enumeration.

**Recommendation:**
```python
# Always hash password even if user doesn't exist
dummy_hash = hash_password("dummy")
user_hash = user['password'] if user else dummy_hash
if not hmac.compare_digest(user_hash, hash_password(password)):
    flash('Invalid username or password')
```

---

### 🟡 MED-005: No Input Validation on Base64 Decoding
**Severity:** MEDIUM
**Location:** `app.py:394`

**Code:**
```python
text_bytes = base64.b64decode(note_text)  # ← No try/except
```

**Issue:** Invalid base64 will crash with unhandled exception.

**Recommendation:**
```python
try:
    text_bytes = base64.b64decode(note_text)
except Exception:
    flash('Invalid note data')
    return redirect(url_for('index'))
```

---

### 🟡 MED-006: Session Fixation Vulnerability
**Severity:** MEDIUM
**Location:** `app.py:358-359`

**Issue:** Session ID not regenerated after login, allowing session fixation attacks.

**Recommendation:**
```python
from flask import session
# After successful login:
session.regenerate()  # Flask 2.3+
# Or manually:
old_data = dict(session)
session.clear()
session.update(old_data)
```

---

### 🟡 MED-007: Unencrypted Passwords in Environment Variables
**Severity:** MEDIUM
**Location:** `.env.example:5-7`

**Issue:** Passwords stored in plaintext in `.env` file.

**Recommendation:**
Store pre-hashed passwords or use external secret management (AWS Secrets Manager, HashiCorp Vault).

---

### 🟡 MED-008: Path Traversal in File Deletion
**Severity:** MEDIUM
**Location:** `app.py:540`

**Issue:** While using `file_info['path']`, if database is compromised, attacker could delete arbitrary files.

**Recommendation:**
```python
file_path = os.path.realpath(file_info['path'])
if not file_path.startswith(os.path.realpath(upload_dir)):
    raise ValueError("Invalid file path")
os.remove(file_path)
```

---

## 4. LOW VULNERABILITIES

### 🟢 LOW-001: Debug Mode in Production
**Issue:** No explicit `DEBUG = False` in code.

**Recommendation:**
```python
app.config['DEBUG'] = os.getenv('FLASK_DEBUG', 'False').lower() == 'true'
```

---

### 🟢 LOW-002: No Logging for Security Events
**Issue:** No audit logs for failed logins, file access attempts.

---

### 🟢 LOW-003: S3 Bucket Permissions Not Validated
**Issue:** Application doesn't verify S3 bucket is private.

---

### 🟢 LOW-004: No File Type Validation for Text Notes
**Issue:** Text notes don't validate content isn't binary/malicious.

---

## 5. ARCHITECTURE OBSERVATIONS

### ✅ Strengths
1. **Client-side encryption** - Files encrypted before upload (good!)
2. **One-time download** - Files deleted after first access
3. **Input sanitization** - Uses `secure_filename()` for file names
4. **Expiry support** - Time-based file expiration
5. **No plaintext storage** - Files stored encrypted

### ⚠️ Weaknesses
1. **No defense in depth** - Single layer of security (client-side only)
2. **Server-side validation missing** - Trusts client encryption
3. **Monolithic architecture** - Single point of failure
4. **No audit trail** - Can't detect breaches
5. **Manual user management** - Error-prone env var configuration

---

## 6. RECOMMENDATIONS PRIORITY

### Immediate (Critical - Fix within 24 hours)
1. ✅ Add `@login_required` to `/download/<file_id>`
2. ✅ Replace SHA-256 with bcrypt/Argon2
3. ✅ Use persistent `FLASK_SECRET_KEY`
4. ✅ Add CSRF protection

### Short-term (High - Fix within 1 week)
5. ✅ Sanitize `Content-Disposition` headers
6. ✅ Remove or warn about password-in-URL feature
7. ✅ Add rate limiting
8. ✅ Add security headers

### Medium-term (Medium - Fix within 1 month)
9. ✅ Fix timing attacks in authentication
10. ✅ Add input validation and error handling
11. ✅ Implement audit logging
12. ✅ Add session management improvements

### Long-term (Low - Fix within 3 months)
13. ✅ Implement comprehensive monitoring
14. ✅ Add penetration testing to CI/CD
15. ✅ Consider external secret management

---

## 7. COMPLIANCE CONSIDERATIONS

If storing **sensitive data** or **PII**, consider:
- **GDPR**: Right to deletion, breach notification
- **HIPAA**: Audit logs, encryption at rest (currently encrypted)
- **SOC 2**: Access controls, monitoring, incident response
- **ISO 27001**: Security policies, risk management

**Current compliance status: NON-COMPLIANT** for most frameworks due to access control and audit logging gaps.

---

## 8. TESTING RECOMMENDATIONS

1. **Penetration Testing**: Hire external firm for black-box testing
2. **Static Analysis**: Use Bandit, Semgrep for Python code
3. **Dynamic Analysis**: Use OWASP ZAP, Burp Suite
4. **Dependency Scanning**: Use Snyk, Safety for vulnerable packages
5. **Secrets Scanning**: Use git-secrets, TruffleHog

---

## 9. CONCLUSION

Buzzdrop implements **client-side encryption correctly**, which is commendable. However, **critical server-side vulnerabilities** exist that could allow unauthorized access to encrypted files. The lack of proper access controls, weak password hashing, and missing CSRF protection create significant security risks.

**Overall Risk Assessment: HIGH**

**Recommendation:** Do **NOT** use for production sensitive data until critical vulnerabilities are addressed.

---

## 10. SECURITY CHECKLIST FOR FIXES

- [ ] Add authentication to download endpoint
- [ ] Implement bcrypt password hashing
- [ ] Use persistent session secret key
- [ ] Add CSRF protection to all forms
- [ ] Sanitize Content-Disposition headers
- [ ] Add rate limiting to all endpoints
- [ ] Implement security headers
- [ ] Add audit logging
- [ ] Fix timing attack vulnerabilities
- [ ] Add input validation on all user inputs
- [ ] Remove or secure password-in-URL feature
- [ ] Document security model clearly
- [ ] Perform security testing
- [ ] Add monitoring and alerting

---

**Report End**

*This report is confidential and intended only for the Buzzdrop development team.*
