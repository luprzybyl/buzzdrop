import math
import os
import secrets
import smtplib
import threading
from datetime import datetime, timedelta
from email.message import EmailMessage
from email.utils import parseaddr
from io import BytesIO
from flask import (
    Flask,
    g,
    make_response,
    request,
    render_template,
    send_from_directory,
    redirect,
    url_for,
    flash,
    session,
    current_app,
    has_app_context,
)
from werkzeug.exceptions import InternalServerError, NotFound, RequestEntityTooLarge
from werkzeug.utils import secure_filename
from flask_limiter import Limiter
from typing import Optional
from db import create_backend
from dotenv import load_dotenv
import base64
import hashlib
import json

# Load environment variables FIRST, before any other imports that read env vars
env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.env')
load_dotenv(dotenv_path=env_path)

# Import new modules AFTER loading .env
from config import get_config
from storage import get_storage_backend, print_backend_info, StorageError
from auth import login_required, admin_required, api_auth_required, get_users, get_current_user, login_user, logout_user
from utils import (
    format_file_timestamps,
    enhance_file_display,
    allowed_file,
    get_client_ip,
    cleanup_orphaned_files,
)
from models import FileRepository

app = Flask(__name__)

# Load configuration
config_class = get_config()
app.config.from_object(config_class)

# Handle SECRET_KEY: require in production, generate temporary one for development
if not app.config.get('SECRET_KEY'):
    if os.getenv('FLASK_ENV') == 'production':
        raise ValueError("FLASK_SECRET_KEY must be set in production environment")
    app.config['SECRET_KEY'] = secrets.token_hex(32)
    import logging
    logging.warning("Using temporary session key. Set FLASK_SECRET_KEY in .env for production!")

# Validate remaining configuration (S3 settings, etc.)
# Note: Validation errors are intentionally fatal - the app should not start with invalid config
config_class.validate()

app.secret_key = app.config['SECRET_KEY']
RATE_LIMIT_EXCEEDED_MESSAGE = 'Too many requests. Please try again later.'

limiter = Limiter(
    key_func=get_client_ip,
    app=app,
    default_limits=[],
    headers_enabled=app.config.get('RATE_LIMIT_HEADERS_ENABLED', True),
    storage_uri=app.config.get('RATE_LIMIT_STORAGE_URI', 'memory://'),
    enabled=app.config.get('RATE_LIMIT_ENABLED', True),
)


class NotificationPreferenceError(Exception):
    """Safe validation error for uploader notification inputs."""

    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


def _get_csrf_token():
    token = session.get('csrf_token')
    if not token:
        token = secrets.token_urlsafe(32)
        session['csrf_token'] = token
    return token


def _is_valid_csrf_token() -> bool:
    submitted_token = request.headers.get('X-CSRF-Token')
    if submitted_token is None:
        submitted_token = request.form.get('csrf_token')
    if submitted_token is None and request.is_json:
        submitted_token = (request.get_json(silent=True) or {}).get('csrf_token')

    session_token = session.get('csrf_token')
    return bool(submitted_token and session_token and secrets.compare_digest(submitted_token, session_token))


def _session_csrf_required() -> bool:
    """
    CSRF gate for routes that accept session OR Bearer auth.

    An ``Authorization`` header exempts the request outright: a
    cross-site form/fetch cannot set it, so Bearer API clients are
    CSRF-immune by construction. Session-authed requests must present
    the session token (header, form field, or JSON field).
    """
    if request.headers.get('Authorization'):
        return True
    return _is_valid_csrf_token()


def _parse_positive_integer(value):
    if isinstance(value, bool):
        raise ValueError
    if isinstance(value, int):
        parsed_value = value
    elif isinstance(value, float):
        if not math.isfinite(value) or not value.is_integer():
            raise ValueError
        parsed_value = int(value)
    elif isinstance(value, str):
        stripped_value = value.strip()
        if not stripped_value or not stripped_value.isdigit():
            raise ValueError
        parsed_value = int(stripped_value)
    else:
        raise ValueError

    if parsed_value < 1:
        raise ValueError
    return parsed_value


def _notifications_configured() -> bool:
    return bool(current_app.config.get('SMTP_HOST') and current_app.config.get('SMTP_FROM_EMAIL'))


def _notification_requested() -> bool:
    return (request.form.get('notify_on_open') or '').strip().lower() in {'1', 'true', 'yes', 'on'}


def _is_valid_notification_email(email_address: str) -> bool:
    parsed = parseaddr(email_address)[1]
    if parsed != email_address or '@' not in parsed or ' ' in parsed:
        return False
    local_part, _, domain = parsed.rpartition('@')
    return bool(local_part and '.' in domain)


def _get_notification_preferences(username: str) -> tuple[bool, str | None]:
    if not _notification_requested():
        return False, None

    if not _notifications_configured():
        raise NotificationPreferenceError('Open notifications are not configured on this server')

    user = get_users().get(username, {})
    configured_email = (user.get('email') or '').strip()
    requested_email = (request.form.get('notification_email') or '').strip()

    if not configured_email:
        raise NotificationPreferenceError('Configure an account email before enabling open notifications')

    if not _is_valid_notification_email(configured_email):
        raise NotificationPreferenceError('Your configured account email is invalid')

    if requested_email and requested_email != configured_email:
        raise NotificationPreferenceError('Open notifications can only be sent to your configured account email')

    return True, configured_email


def _send_email(recipient: str, subject: str, body: str):
    message = EmailMessage()
    message['Subject'] = subject
    message['From'] = current_app.config['SMTP_FROM_EMAIL']
    message['To'] = recipient
    message.set_content(body)

    smtp_class = smtplib.SMTP_SSL if current_app.config.get('SMTP_USE_SSL') else smtplib.SMTP
    with smtp_class(
        current_app.config['SMTP_HOST'],
        current_app.config['SMTP_PORT'],
        timeout=current_app.config.get('SMTP_TIMEOUT_SECONDS', 10),
    ) as server:
        if current_app.config.get('SMTP_USE_TLS') and not current_app.config.get('SMTP_USE_SSL'):
            server.starttls()
        if current_app.config.get('SMTP_USERNAME'):
            server.login(
                current_app.config['SMTP_USERNAME'],
                current_app.config.get('SMTP_PASSWORD', ''),
            )
        server.send_message(message)


def send_open_notification_email(file_info: dict) -> bool:
    if (
        not file_info.get('notify_on_open')
        or not file_info.get('notification_email')
        or file_info.get('notification_sent_at')
    ):
        return False

    if not file_repo.claim_notification_send(file_info['id']):
        return False

    decryption_success = file_info.get('decryption_success')
    if decryption_success is True:
        decryption_status = 'successful'
    elif decryption_success is False:
        decryption_status = 'failed'
    else:
        decryption_status = 'not reported'

    share_type = 'Secret Note' if file_info.get('type') == 'text' else 'File'
    original_name = file_info.get('original_name') or ('Secret Note' if share_type == 'Secret Note' else 'Shared file')
    # Email subjects are not private (notification previews, provider
    # logs) — the filename stays out of the subject line, period.
    subject = f'Buzzdrop {share_type.lower()} opened'
    body = '\n'.join([
        'Your Buzzdrop share was opened.',
        '',
        f'Type: {share_type}',
        f'Original name: {original_name}',
        f'Opened at: {file_info.get("downloaded_at") or datetime.now().isoformat()}',
        f'Decryption status: {decryption_status}',
        '',
        'Buzzdrop intentionally omits recipient-sensitive details from this notification.',
    ])

    try:
        _send_email(file_info['notification_email'], subject, body)
    except Exception:
        file_repo.clear_notification_claim(file_info['id'])
        file_info['notification_claimed_at'] = None
        raise

    file_repo.mark_notification_sent(file_info['id'])
    file_info['notification_claimed_at'] = None
    file_info['notification_sent_at'] = datetime.now().isoformat()
    return True

# --- SRI HASH HELPER ---
@app.context_processor
def csrf_token_processor():
    return {'csrf_token': _get_csrf_token}


def _sri_digest(filepath):
    """SHA-384 SRI value ('sha384-<base64>') of a file's bytes."""
    with open(filepath, 'rb') as f:
        hashed = hashlib.sha384(f.read()).digest()
    return 'sha384-' + base64.b64encode(hashed).decode()


def _module_import_map():
    """
    Import map JSON pinning every ES module under static/js (issue #166).

    A <script integrity> attribute covers only the entry file; modules it
    imports are fetched by the module loader, which takes their expected
    hash from the import map's "integrity" section instead. Rendered
    inline by base.html, so the exact string is kept on g and its SHA-256
    is added to the CSP by set_security_headers.
    """
    js_dir = os.path.join(app.static_folder, 'js')
    integrity = {}
    for dirpath, _dirnames, filenames in os.walk(js_dir):
        for name in filenames:
            if not name.endswith('.js'):
                continue
            filepath = os.path.join(dirpath, name)
            filename = os.path.relpath(filepath, app.static_folder).replace(os.sep, '/')
            integrity[url_for('static', filename=filename)] = _sri_digest(filepath)
    g.import_map = json.dumps({'integrity': integrity}, sort_keys=True, separators=(',', ':'))
    return g.import_map


@app.context_processor
def sri_hash_processor():
    """Context processor to generate SRI hashes for static files."""
    def sri_hash(filename):
        """
        Generate SHA-384 SRI hash for a static file.
        
        Args:
            filename: Relative path to the static file (e.g., 'js/pages/index/entry.js')
            
        Returns:
            str: SRI hash in format 'sha384-<base64-hash>' or empty string if file not found
        """
        try:
            return _sri_digest(os.path.join(app.static_folder, filename))
        except FileNotFoundError:
            # In case the file doesn't exist, raise error in development or log warning in production
            import logging
            env = os.getenv('FLASK_ENV', 'production')
            if env == 'development':
                raise FileNotFoundError(f"SRI hash requested for missing static file: {filename}")
            else:
                logging.warning(f"SRI hash requested for missing static file: {filename}")
                return ""
    return dict(sri_hash=sri_hash, module_import_map=_module_import_map)

# Ensure upload directory exists (for local storage)
if app.config['STORAGE_BACKEND'] == 'local':
    os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)

# Initialize the storage backend (sqlite:// today, swappable via DATABASE_URL)
backend = create_backend(config_class.get_database_url())
app.backend = backend

# Initialize storage backend
storage = get_storage_backend(app.config)
print_backend_info(storage)

# Initialize file repository
file_repo = FileRepository()

def _resolve_database_url() -> str:
    """
    Resolve the effective, canonicalized DATABASE_URL for the current app
    context.

    Bare paths are wrapped in sqlite:/// and SQLite paths are absolutized so
    the result compares equal to Backend.url — otherwise every call would
    mint a fresh backend and leak the old one's connections.
    """
    configured = (
        current_app.config if has_app_context() else app.config
    )
    url = configured.get('DATABASE_URL')
    if not url:
        # Deprecated fallback: plain file path → sqlite:///
        url = f"sqlite:///{configured.get('DATABASE_PATH') or 'buzzdrop.db'}"

    if url.startswith('sqlite:///'):
        path = url[len('sqlite:///'):]
        url = f'sqlite:///{os.path.abspath(path)}'
    elif '://' not in url:
        url = f'sqlite:///{os.path.abspath(url)}'
    return url


def get_backend():
    """
    Return the storage Backend for the current app context.

    A new backend is created when the app's cached instance is missing,
    closed, or was opened against a different DATABASE_URL (e.g. test
    scenarios that point the app at a temporary database file). A displaced
    backend is closed so its connections are not leaked.

    Returns:
        Backend: Active backend exposing .files/.tokens stores
    """
    url = _resolve_database_url()
    if has_app_context():
        backend = getattr(current_app, 'backend', None)
        if backend is None or backend.url != url or getattr(backend, 'closed', False):
            if backend is not None:
                backend.close()
            backend = create_backend(url)
            current_app.backend = backend
    else:
        backend = getattr(app, 'backend', None)
        if backend is None or backend.url != url or getattr(backend, 'closed', False):
            if backend is not None:
                backend.close()
            backend = create_backend(url)
            app.backend = backend
    return backend


def get_files_store():
    """Return the files store respecting the current app configuration."""
    return get_backend().files

# Clean up orphaned files on startup (local storage only)
if app.config['STORAGE_BACKEND'] == 'local':
    files_store = get_files_store()
    tracked_files = set(
        file_info['path'].split(os.sep)[-1] for file_info in files_store.all()
    )
    cleanup_orphaned_files(app.config['UPLOAD_FOLDER'], tracked_files)

# Sweep pending key shares abandoned mid-handshake (begin but no finish).
file_repo.purge_stale_key_shares(
    app.config['KEY_SHARE_PENDING_TTL_SECONDS'])

@app.route('/favicon.ico')
def favicon():
    """Serve the site favicon."""
    return send_from_directory(
        os.path.join(app.root_path, 'static'),
        'favicon.ico',
        mimetype='image/vnd.microsoft.icon'
    )

def check_and_handle_expiry(file_info):
    """Check if the given file has expired and handle cleanup."""
    if not file_info:
        return False

    expiry_at = file_info.get('expiry_at')
    status = file_info.get('status')
    if not expiry_at or status == 'expired':
        return status == 'expired'

    try:
        expiry_dt = datetime.fromisoformat(expiry_at)
    except ValueError:
        return False

    if datetime.now() >= expiry_dt:
        # Remove file from storage
        try:
            storage.delete(file_info['path'])
        except Exception:
            pass

        # An expired share is dead: destroy the key share (H) along with
        # the blob — nothing may be released for an expired file.
        file_repo.burn_key_share(file_info['id'])

        # Mark as expired in database
        file_repo.mark_expired(file_info['id'])
        file_info['status'] = 'expired'
        return True

    return False


def sweep_expired_files() -> int:
    """
    Expire every active drop whose expiry_at has passed: delete the
    stored blob (local or S3 — check_and_handle_expiry goes through the
    storage abstraction), burn the key share, and mark the record
    expired. Drops released but not downloaded within
    KEY_RELEASE_DOWNLOAD_TTL_SECONDS of the release go the same way.

    Expiry must not depend on someone touching the link — this runs
    once at startup and, when EXPIRY_SWEEP_INTERVAL_SECONDS > 0, again
    on a timer.

    Returns:
        Number of drops expired by this pass.
    """
    expired_count = 0
    for file_info in file_repo.get_all_active():
        try:
            if check_and_handle_expiry(file_info):
                expired_count += 1
        except Exception:
            # One bad row must not stop the sweep — keep going.
            app.logger.exception(
                'Expiry sweep failed for file %s', file_info.get('id'))
    # Released but never downloaded within the window: the ticket is no
    # longer honoured and H is gone, so the blob serves no one.
    for stale in file_repo.expire_unclaimed_releases(
            app.config['KEY_RELEASE_DOWNLOAD_TTL_SECONDS']):
        try:
            storage.delete(stale['path'])
        except Exception:
            app.logger.exception(
                'Expiry sweep could not delete the blob of unclaimed '
                'release %s', stale['id'])
        expired_count += 1
    return expired_count


# Startup sweep — drops that expired while the app was down must be
# destroyed even if nobody ever opens them (same pattern as the
# pending-share purge above).
_startup_expired_count = sweep_expired_files()
if _startup_expired_count:
    app.logger.info(
        'Startup expiry sweep removed %d expired drop(s)',
        _startup_expired_count)


def _expiry_sweep_loop(interval_seconds: float,
                       stop_event: threading.Event) -> None:
    while not stop_event.wait(interval_seconds):
        try:
            removed = sweep_expired_files()
            if removed:
                app.logger.info(
                    'Periodic expiry sweep removed %d drop(s)', removed)
        except Exception:
            app.logger.exception('Periodic expiry sweep failed')


def start_expiry_sweep_thread(interval_seconds: float):
    """
    Spawn the periodic expiry sweeper as a daemon thread.

    The sweep is idempotent, so it is safe under WSGI deployments with
    several workers and under the dev reloader — every process sweeps
    the same database and repeated passes converge. Daemon threads die
    with their process, so production code never stops them; the
    thread's ``sweep_stop`` event exists for tests that need a clean
    shutdown. An interval <= 0 disables the periodic sweep (the
    startup sweep above already ran).

    Returns:
        The started Thread, or None when disabled.
    """
    if interval_seconds <= 0:
        return None
    stop_event = threading.Event()
    thread = threading.Thread(
        target=_expiry_sweep_loop,
        args=(interval_seconds, stop_event),
        name='buzzdrop-expiry-sweep',
        daemon=True,
    )
    thread.sweep_stop = stop_event
    thread.start()
    return thread


_expiry_sweep_thread = start_expiry_sweep_thread(
    app.config.get('EXPIRY_SWEEP_INTERVAL_SECONDS', 0))


@app.errorhandler(RequestEntityTooLarge)
def handle_large_file(error):
    """Return a user-friendly message when the uploaded file exceeds the limit."""
    if request.headers.get('X-Requested-With') == 'XMLHttpRequest':
        return {'error': 'File too large'}, 413
    flash('File too large')
    return 'File too large', 413


def _is_api_request():
    """True when the client expects JSON rather than an HTML page."""
    return (
        request.path.startswith('/api/')
        or request.headers.get('Authorization', '').startswith('Bearer ')
        or request.headers.get('X-Requested-With') == 'XMLHttpRequest'
    )


@app.errorhandler(429)
def handle_rate_limit(error):
    """Return consistent rate-limit responses for HTML, AJAX, and API clients."""
    message = getattr(error, 'description', RATE_LIMIT_EXCEEDED_MESSAGE)

    if _is_api_request():
        return {'error': message}, 429

    if request.endpoint == 'login':
        flash(message)
        return render_template('login.html'), 429

    return message, 429


def _error_page(status, eyebrow, heading, message):
    """A dead-end page in the card style, rendered from templates/error.html."""
    return render_template('error.html', eyebrow=eyebrow, heading=heading,
                           message=message), status


@app.errorhandler(NotFound)
def handle_not_found(error):
    """A themed 404 page instead of Werkzeug's default (JSON for API clients)."""
    if _is_api_request():
        return {'error': 'Not found'}, 404
    return _error_page(404, '404', 'Page not found',
                       "There's nothing at this address.")


@app.errorhandler(InternalServerError)
def handle_server_error(error):
    """A themed 500 page instead of Werkzeug's default (JSON for API clients)."""
    if _is_api_request():
        return {'error': 'Internal server error'}, 500
    return _error_page(500, '500', 'Something went wrong',
                       'The server hit an error. Please try again in a moment.')


def _openable_drop(file_id):
    """The drop's record while its link can still be opened, else None."""
    file_info = file_repo.get_by_id(file_id)
    if (not file_info or file_info['downloaded_at'] is not None
            or check_and_handle_expiry(file_info)):
        return None
    share = file_repo.get_key_share(file_id)
    # A released, burned or never-bound share leads nowhere — the same
    # dead link as every other gone drop (a ciphertext without H is dead).
    if (not share or share.get('released_at') is not None
            or share.get('v') is None):
        return None
    return file_info


_ENVELOPE_MAGIC = b'BKV3'
_ENVELOPE_PREFIX_LENGTH = 20  # 'BKV3' + salt(16)


def _envelope_salt(prefix: bytes) -> Optional[str]:
    """The BKV3 envelope salt as hex, or None when the prefix isn't one."""
    if len(prefix) >= _ENVELOPE_PREFIX_LENGTH and \
            prefix[:len(_ENVELOPE_MAGIC)] == _ENVELOPE_MAGIC:
        return prefix[len(_ENVELOPE_MAGIC):_ENVELOPE_PREFIX_LENGTH].hex()
    return None


def _drop_gone():
    """
    The /view page for a drop link that leads nowhere. It is the same whether
    the drop was already opened, expired or never existed, so the page
    reveals nothing about which, just as /release answers a uniform 404.
    (/download still flashes the reason; only /view is uniform.)
    """
    return _error_page(404, 'Dead link', 'This drop is gone',
                       'It was already opened, it expired, or it never existed. '
                       'Ask the sender for a new one.')


@app.route('/')
def index():
    """Home page route."""
    current_user = get_current_user()
    if current_user:
        username = current_user['username']
        # Get files uploaded by the current user, newest upload first: the
        # list's default sort, so it reads right before the page script runs.
        # created_at is a naive ISO timestamp, which sorts as text.
        user_files = sorted(file_repo.get_user_files(username),
                            key=lambda f: f.get('created_at') or '', reverse=True)
        
        # Check expiry and format for display
        for f in user_files:
            check_and_handle_expiry(f)
            enhance_file_display(f)

        # Get files shared with the current user
        shared_files = file_repo.get_shared_files(username)
        
        response = make_response(render_template(
            'index.html', 
            user_files=user_files, 
            shared_files=shared_files,
            allowed_extensions=sorted(current_app.config.get('ALLOWED_EXTENSIONS')),
            max_content_length=current_app.config.get('MAX_CONTENT_LENGTH'),
            configured_notification_email=current_user.get('email'),
        ))
        response.headers['Cache-Control'] = 'no-store'
        return response
    
    return render_template(
        'index.html',
        allowed_extensions=sorted(current_app.config.get('ALLOWED_EXTENSIONS')),
        max_content_length=current_app.config.get('MAX_CONTENT_LENGTH'),
    )

@app.route('/api/user/files/status', methods=['GET'])
@login_required
def user_file_statuses():
    requested_ids = list(dict.fromkeys(request.args.getlist('id')))
    if len(requested_ids) > 50:
        return {'error': 'Too many file IDs'}, 400

    current_user = get_current_user()
    files = file_repo.get_user_files_by_ids(current_user['username'], requested_ids)
    statuses = []
    for file_info in files:
        check_and_handle_expiry(file_info)
        enhance_file_display(file_info)
        statuses.append({
            'id': file_info['id'],
            'status': file_info.get('status', 'active'),
            'status_key': file_info['status_key'],
            'status_display': file_info['status_display'],
            'downloaded_at': file_info.get('downloaded_at'),
            'downloaded_at_iso': file_info['downloaded_at_iso'],
            'downloaded_by_ip': file_info.get('downloaded_by_ip'),
        })

    response = make_response({'files': statuses})
    response.headers['Cache-Control'] = 'no-store'
    return response

@app.route('/login', methods=['GET', 'POST'])
@limiter.limit(
    lambda: current_app.config['LOGIN_RATE_LIMIT'],
    methods=['POST'],
    error_message=RATE_LIMIT_EXCEEDED_MESSAGE,
)
def login():
    if request.method == 'POST':
        username = request.form.get('username')
        password = request.form.get('password')

        if login_user(username, password):
            flash('Logged in successfully', 'success')
            return redirect(url_for('index'))
        else:
            flash('Invalid username or password')

    return render_template('login.html')

@app.route('/logout', methods=['POST'])
def logout():
    # Logout mutates session state — POST only, gated by the session CSRF
    # token (Bearer Authorization exempts the check as on other routes).
    if not _session_csrf_required():
        flash('Invalid request')
        return redirect(url_for('index'))
    logout_user()
    flash('Logged out successfully', 'success')
    return redirect(url_for('index'))

@app.route('/users', methods=['GET'])
@admin_required
def manage_users():
    from tokens import list_api_tokens

    users = get_users()
    tokens_by_user = {username: [] for username in users}
    for token in list_api_tokens():
        tokens_by_user.setdefault(token['username'], []).append(token)
    return render_template('users.html', users=users, tokens_by_user=tokens_by_user)


@app.route('/api/token', methods=['POST'])
@limiter.limit(
    lambda: current_app.config['API_TOKEN_RATE_LIMIT'],
    methods=['POST'],
    error_message=RATE_LIMIT_EXCEEDED_MESSAGE,
)
@login_required
def create_api_token():
    """
    Generate an API token.

    - Any logged-in user may generate a token for themselves (omit ``username``
      or pass their own username).
    - Admins may generate a token for any existing user by passing
      ``{"username": "targetuser"}``.

    Request JSON: {"username": "<existing_username>", "expires_in_days": 30}
    Response JSON: {"token": "<raw_token>", "expires_at": "<ISO timestamp>"}
    ← shown once, store securely
    """
    from tokens import DEFAULT_TOKEN_EXPIRY_DAYS, generate_api_token
    if not _session_csrf_required():
        return {'error': 'CSRF validation failed'}, 403
    data = request.get_json(silent=True) or {}
    current_user = get_current_user()
    current_username = current_user['username']
    requested_username = data.get('username') or current_username
    requested_expiry_days = data.get('expires_in_days', DEFAULT_TOKEN_EXPIRY_DAYS)

    users = get_users()
    is_current_admin = current_user.get('is_admin', False)

    if requested_username != current_username and not is_current_admin:
        return {'error': 'Admin access required to generate tokens for other users'}, 403

    if requested_username not in users:
        return {'error': 'Unknown user'}, 404

    try:
        requested_expiry_days = _parse_positive_integer(requested_expiry_days)
    except ValueError:
        return {'error': 'expires_in_days must be a positive integer'}, 400

    expires_at = datetime.now() + timedelta(days=requested_expiry_days)
    raw_token = generate_api_token(requested_username, expires_at=expires_at)
    return {'token': raw_token, 'expires_at': expires_at.isoformat()}, 201


@app.route('/api/tokens', methods=['GET'])
@login_required
def list_api_tokens_route():
    from tokens import list_api_tokens

    users = get_users()
    current_user = get_current_user()
    current_username = current_user['username']
    requested_username = request.args.get('username') or current_username

    if requested_username != current_username and not current_user.get('is_admin', False):
        return {'error': 'Admin access required to list tokens for other users'}, 403

    if requested_username not in users:
        return {'error': 'Unknown user'}, 404

    return {'tokens': list_api_tokens(requested_username)}, 200


@app.route('/api/tokens/<int:token_id>/revoke', methods=['POST'])
@login_required
def revoke_api_token_route(token_id):
    from tokens import get_api_token, revoke_api_token_by_id

    wants_json = (
        request.headers.get('X-Requested-With') == 'XMLHttpRequest'
        or request.is_json
    )

    current_user = get_current_user()
    current_username = current_user['username']

    token = get_api_token(token_id)

    if not token:
        if wants_json:
            return {'error': 'Token not found'}, 404
        flash('API token not found')
        return redirect(url_for('manage_users' if current_user.get('is_admin', False) else 'index'))

    if token['username'] != current_username and not current_user.get('is_admin', False):
        if wants_json:
            return {'error': 'Admin access required to revoke tokens for other users'}, 403
        flash('Admin access required')
        return redirect(url_for('index'))

    if not _is_valid_csrf_token():
        if wants_json:
            return {'error': 'CSRF validation failed'}, 403
        flash('Invalid request')
        return redirect(url_for('manage_users' if current_user.get('is_admin', False) else 'index'))

    revoke_api_token_by_id(token_id)

    if wants_json:
        return {'status': 'revoked'}, 200

    flash('API token revoked', 'success')
    return redirect(url_for('manage_users' if current_user.get('is_admin', False) else 'index'))


@app.after_request
def no_store_key_release_responses(response):
    """H-carrying endpoints must never be cached by browsers/proxies."""
    if request.endpoint in {'upload_begin', 'release_key'}:
        response.headers['Cache-Control'] = 'no-store'
    return response


# Baseline CSP: same-origin everything, no inline script. All markup ships
# scripts as static files under SRI (see sri_hash_processor); the only
# non-static <script> blocks are type="application/json" data islands,
# which CSP does not treat as script, and base.html's import map, which
# set_security_headers allows by its SHA-256 on the pages that render it
# (see _module_import_map). Inline *styles* are still used on a
# few elements, so style-src keeps 'unsafe-inline'.
CSP_DIRECTIVES = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
]


def _content_security_policy(script_hashes=()):
    """The baseline CSP, with script-src extended by inline-block hashes."""
    sources = ''.join(f" 'sha256-{digest}'" for digest in script_hashes)
    return "; ".join(
        directive + sources if directive.startswith('script-src ') else directive
        for directive in CSP_DIRECTIVES)

PERMISSIONS_POLICY = ", ".join([
    "accelerometer=()",
    "camera=()",
    "geolocation=()",
    "gyroscope=()",
    "magnetometer=()",
    "microphone=()",
    "payment=()",
    "usb=()",
    "interest-cohort=()",
])


@app.after_request
def set_security_headers(response):
    """
    Emit baseline security headers on every response.

    - CSP + X-Frame-Options kill framing (/login credential phishing,
      /view/<id> one-click-confirm clickjacking).
    - Referrer-Policy keeps share links out of Referer headers.
    - HSTS is sent unconditionally: browsers ignore it over plain HTTP,
      and the app has no ProxyFix, so request.is_secure is unreliable
      behind TLS-terminating proxies (Passenger/nginx).
    """
    script_hashes = []
    import_map = g.get('import_map')
    if import_map is not None:
        script_hashes.append(base64.b64encode(
            hashlib.sha256(import_map.encode('utf-8')).digest()).decode())
    response.headers['Content-Security-Policy'] = _content_security_policy(script_hashes)
    response.headers['X-Frame-Options'] = 'DENY'
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['Referrer-Policy'] = 'no-referrer'
    response.headers['Strict-Transport-Security'] = (
        'max-age=31536000; includeSubDomains')
    response.headers['Permissions-Policy'] = PERMISSIONS_POLICY
    return response


def _is_valid_key_material(value) -> bool:
    """Key material (H, V, receipt hash) travels as 64 lowercase hex chars (32 bytes)."""
    return (
        isinstance(value, str)
        and len(value) == 64
        and all(c in '0123456789abcdef' for c in value)
    )


@app.route('/upload/begin', methods=['POST'])
@limiter.limit(
    lambda: current_app.config['UPLOAD_RATE_LIMIT'],
    methods=['POST'],
    error_message=RATE_LIMIT_EXCEEDED_MESSAGE,
)
@api_auth_required
def upload_begin():
    """
    Phase 1 of a key-release upload (docs/true-one-time.md §6.3): mint a
    file_id and the random server share H so the client can derive
    file_key = HKDF(Kp ‖ H) before encrypting. The pending share is
    bound to the uploader's username and completed by /upload carrying
    ``file_id`` + ``key_verifier`` + ``receipt_hash``.
    """
    if not _session_csrf_required():
        return {'error': 'CSRF validation failed'}, 403

    # Pending shares that never finished are dead weight — sweep them on
    # the same path that creates them.
    file_repo.purge_stale_key_shares(
        current_app.config['KEY_SHARE_PENDING_TTL_SECONDS'])

    file_id, h_hex = file_repo.create_key_share(created_by=g.username)
    return {'file_id': file_id, 'h': h_hex}


@app.route('/upload', methods=['POST'])
@limiter.limit(
    lambda: current_app.config['UPLOAD_RATE_LIMIT'],
    methods=['POST'],
    error_message=RATE_LIMIT_EXCEEDED_MESSAGE,
)
@api_auth_required
def upload_file():
    # Check if this is a text note upload
    note_text = request.form.get('note_text')
    upload_type = request.form.get('type', 'file')
    private_note = (request.form.get('private_note') or '').strip() or None
    wants_json = request.headers.get('X-Requested-With') == 'XMLHttpRequest'

    if not _session_csrf_required():
        if wants_json:
            return {'error': 'CSRF validation failed'}, 403
        flash('Invalid request')
        return redirect(url_for('index'))

    # Every upload is two-phase: the client must have run /upload/begin
    # and sends back the minted file_id, the password verifier V, and the
    # receipt hash (SHA-256 of the in-ciphertext decryption receipt).
    file_id = (request.form.get('file_id') or '').strip() or None
    key_verifier = (request.form.get('key_verifier') or '').strip().lower() or None
    receipt_hash = (request.form.get('receipt_hash') or '').strip().lower() or None

    def _fail(message, status=400):
        if wants_json:
            return {'error': message}, status
        flash(message)
        return redirect(url_for('index'))

    try:
        notify_on_open, notification_email = _get_notification_preferences(g.username)
    except NotificationPreferenceError as exc:
        return _fail(exc.message)

    if (
        not file_id
        or not _is_valid_key_material(key_verifier)
        or not _is_valid_key_material(receipt_hash)
    ):
        return _fail('Invalid key-release upload')
    share = file_repo.get_key_share(file_id)
    if (
        share is None
        or share.get('v') is not None
        or share.get('released_at') is not None
        or file_repo.get_by_id(file_id) is not None
    ):
        return _fail('Unknown or already finalized key-release upload', 409)
    # Owner binding: only the account that ran /upload/begin may finish
    # it — a leaked pending file_id must not let someone else claim it.
    if share.get('created_by') != g.username:
        return _fail('Key-release share belongs to another user', 403)

    if upload_type == 'text' and note_text:
        # Handle text note upload
        # Decode base64 encrypted data
        text_bytes = base64.b64decode(note_text)

        # The envelope salt rides on the share row so /view can hand it to
        # the client before it has proved the password (V needs the salt).
        salt_hex = _envelope_salt(text_bytes[:_ENVELOPE_PREFIX_LENGTH])
        # Parse expiry date
        expiry_raw = request.form.get('expiry')
        expiry_iso = None
        if expiry_raw:
            try:
                expiry_iso = datetime.fromisoformat(expiry_raw).isoformat()
            except ValueError:
                expiry_iso = None

        # The file_id was minted by /upload/begin
        unique_id = file_id

        # Binding V atomically claims the pending share — a racing second
        # finish loses here, before any blob or record is written.
        if not file_repo.bind_key_verifier(unique_id, key_verifier, salt_hex):
            return _fail('Key-release upload was finalized elsewhere', 409)

        # Compensation: a bound share with no file record is dangling —
        # if save/create fails after the bind, destroy the share so the
        # failed finish can't be replayed or sit orphaned holding H.
        file_path = None
        try:
            file_path = storage.save(unique_id, text_bytes)
            file_repo.create({
                'original_name': 'Secret Note',
                'path': file_path,
                'uploaded_by': g.username,
                'expiry_at': expiry_iso,
                'type': 'text',
                'private_note': private_note,
                'notify_on_open': notify_on_open,
                'notification_email': notification_email,
                'receipt_hash': receipt_hash,
            }, file_id=unique_id)
        except Exception:
            if file_path is not None:
                try:
                    storage.delete(file_path)
                except Exception:
                    pass
            file_repo.burn_key_share(unique_id)
            return _fail('Upload failed', 500)

        share_link = url_for('view_file', file_id=unique_id, _external=True)
        if wants_json:
            return {
                'file_id': unique_id,
                'share_link': share_link,
                'type': 'text'
            }
        return render_template('success.html', share_link=share_link, file_type='text')

    # Handle regular file upload
    if 'file' not in request.files:
        flash('No file part')
        return redirect(url_for('index'))
    
    file = request.files['file']
    if file.filename == '':
        flash('No selected file')
        return redirect(url_for('index'))
    
    if file and allowed_file(file.filename):
        filename = secure_filename(file.filename)

        # The file_id was minted by /upload/begin
        unique_id = file_id

        # The envelope salt rides on the share row so /view can hand it to
        # the client before it has proved the password (V needs the salt).
        salt_hex = None
        try:
            head = file.stream.read(_ENVELOPE_PREFIX_LENGTH)
            file.stream.seek(0)
            salt_hex = _envelope_salt(head)
        except Exception:
            salt_hex = None

        # Binding V atomically claims the pending share — a racing second
        # finish loses here, before any blob or record is written.
        if not file_repo.bind_key_verifier(unique_id, key_verifier, salt_hex):
            return _fail('Key-release upload was finalized elsewhere', 409)

        # Parse expiry date
        expiry_raw = request.form.get('expiry')
        expiry_iso = None
        if expiry_raw:
            try:
                expiry_iso = datetime.fromisoformat(expiry_raw).isoformat()
            except ValueError:
                expiry_iso = None

        # Compensation: a bound share with no file record is dangling —
        # if save/create fails after the bind, destroy the share so the
        # failed finish can't be replayed or sit orphaned holding H.
        file_path = None
        try:
            file_path = storage.save(unique_id, file)
            file_repo.create({
                'original_name': filename,
                'path': file_path,
                'uploaded_by': g.username,
                'expiry_at': expiry_iso,
                'type': 'file',
                'private_note': private_note,
                'notify_on_open': notify_on_open,
                'notification_email': notification_email,
                'receipt_hash': receipt_hash,
            }, file_id=unique_id)
        except Exception:
            if file_path is not None:
                try:
                    storage.delete(file_path)
                except Exception:
                    pass
            file_repo.burn_key_share(unique_id)
            return _fail('Upload failed', 500)

        share_link = url_for('view_file', file_id=unique_id, _external=True)
        if wants_json:
            return {
                'file_id': unique_id,
                'share_link': share_link,
                'type': 'file'
            }
        return render_template('success.html', share_link=share_link, file_type='file')
    
    flash('File type not allowed')
    if request.headers.get('X-Requested-With') == 'XMLHttpRequest':
        return {'error': 'File type not allowed'}, 400
    return redirect(url_for('index'))

# Remove confirm_download route, logic moves to /view/<file_id> and /view/<file_id>/confirm

@app.route('/download/<file_id>', methods=['GET'])
@limiter.shared_limit(
    lambda: current_app.config['PUBLIC_FILE_RATE_LIMIT'],
    'public_file_access',
    methods=['GET'],
    error_message=RATE_LIMIT_EXCEEDED_MESSAGE,
)
def download_file(file_id):
    """
    Serve the ciphertext once, to the caller that won /release.

    The ticket is a bearer credential derived from H (HKDF-SHA256, info
    'buzzdrop-download-ticket'): the release stores only its digest and
    never sends it — the winner recomputes it from the H it got. The blob
    is no longer the one-time claim, so fetching it early protects
    nothing. The ticket is consumed with the claim, before the body
    streams, and the blob is deleted after it: a transfer that breaks off
    is not resumable — deliberately, no retry surface. Without a
    valid ticket an unreleased share answers a bare 403 to everyone; a
    released share answers 'claimed', since only the release winner holds
    the ticket.
    """
    xhr = request.headers.get('X-Requested-With') == 'XMLHttpRequest'
    file_info = file_repo.get_by_id(file_id)
    if not file_info:
        if xhr:
            return {'error': 'File not found'}, 404
        flash('File not found')
        return redirect(url_for('index'))
    if 'downloaded_at' in file_info and file_info['downloaded_at'] is not None:
        if xhr:
            return {'error': 'This file has already been downloaded'}, 410
        flash('This file has already been downloaded at {}'.format(file_info['downloaded_at']))
        return redirect(url_for('index'))
    if check_and_handle_expiry(file_info):
        if xhr:
            return {'error': 'File has expired'}, 410
        flash('File has expired')
        return redirect(url_for('index'))

    ticket = request.headers.get('X-Download-Ticket')
    if isinstance(ticket, str):
        ticket = ticket.strip().lower()

    # Verify the ticket and claim the blob in one transaction — exactly
    # one concurrent requester wins, and the ticket is consumed with the
    # claim.
    result = file_repo.claim_download_with_ticket(
        file_id, ticket, get_client_ip(),
        current_app.config['KEY_RELEASE_DOWNLOAD_TTL_SECONDS'])
    status = result['status']

    if status == 'not_released':
        return {'error': 'Forbidden'}, 403
    if status == 'bad_ticket':
        if xhr:
            return {'error': 'This drop has already been claimed'}, 410
        flash('This file has already been claimed')
        return redirect(url_for('index'))
    if status == 'already_downloaded':
        if xhr:
            return {'error': 'This file has already been downloaded'}, 410
        flash('This file has already been downloaded')
        return redirect(url_for('index'))
    if status == 'expired':
        if result.get('path'):
            try:
                storage.delete(result['path'])
            except Exception:
                pass
        if xhr:
            return {'error': 'File has expired'}, 410
        flash('File has expired')
        return redirect(url_for('index'))
    if status == 'missing':
        if xhr:
            return {'error': 'File not found'}, 404
        flash('File not found')
        return redirect(url_for('index'))

    # Stream file from storage
    def generate():
        try:
            for chunk in storage.retrieve(file_info['path']):
                yield chunk
        except Exception:
            # The claim is already consumed — surface the loss loudly.
            current_app.logger.error(
                'Storage retrieve failed for claimed file %s', file_id)
            raise
        finally:
            try:
                storage.delete(file_info['path'])
            except Exception:
                pass

    headers = {
        'Content-Disposition': f'attachment; filename="{file_info.get("original_name") or "download"}"'
    }
    try:
        # Lets the client report real download progress.
        headers['Content-Length'] = str(storage.size(file_info['path']))
    except StorageError:
        current_app.logger.warning(
            'Could not stat claimed file %s — download progress disabled',
            file_id)

    response = current_app.response_class(
        generate(),
        headers=headers,
        mimetype='application/octet-stream'
    )
    return response


@app.route('/delete/<file_id>', methods=['POST'])
@login_required
def delete_file(file_id):
    """Delete a file entry and remove the file if it still exists."""
    current_user = get_current_user()
    current_username = current_user['username']
    file_info = file_repo.get_by_id(file_id)

    if not _is_valid_csrf_token():
        flash('Invalid request')
        return redirect(url_for('index'))

    if not file_info or file_info.get('uploaded_by') != current_username:
        flash('File not found')
        return redirect(url_for('index'))

    # Remove the file from storage if it hasn't been downloaded yet
    if not file_info.get('downloaded_at'):
        try:
            storage.delete(file_info['path'])
        except Exception:
            pass

    file_repo.delete(file_id)
    flash('File deleted successfully', 'success')
    return redirect(url_for('index'))


@app.route('/success/<file_id>')
@login_required
def upload_success(file_id):
    file_info = file_repo.get_by_id(file_id)
    if not file_info or file_info.get('uploaded_by') != get_current_user()['username']:
        flash('File not found')
        return redirect(url_for('index'))
    share_link = url_for('view_file', file_id=file_id, _external=True)
    return render_template('success.html', share_link=share_link,
                           file_type=file_info.get('type'))


@app.route('/view/<file_id>', methods=['GET'])
@limiter.shared_limit(
    lambda: current_app.config['PUBLIC_FILE_RATE_LIMIT'],
    'public_file_access',
    methods=['GET'],
    error_message=RATE_LIMIT_EXCEEDED_MESSAGE,
)
def view_file(file_id):
    file_info = _openable_drop(file_id)
    if not file_info:
        return _drop_gone()
    file_type = file_info.get('type', 'file')
    return render_template('confirm_download.html', file_id=file_id, original_name=file_info.get('original_name'), file_type=file_type)

@app.route('/view/<file_id>/confirm', methods=['POST'])
@limiter.shared_limit(
    lambda: current_app.config['PUBLIC_FILE_RATE_LIMIT'],
    'public_file_access',
    methods=['POST'],
    error_message=RATE_LIMIT_EXCEEDED_MESSAGE,
)
def confirm_view_file(file_id):
    file_info = _openable_drop(file_id)
    if not file_info:
        return _drop_gone()
    if not _is_valid_csrf_token():
        flash('Invalid request')
        return redirect(url_for('view_file', file_id=file_id))
    # The client needs the envelope salt before it can prove the password
    # (V derives from it) — the ciphertext only comes after. The salt is
    # read off the share row bound at upload; shares uploaded before that
    # existed fall back to the blob's envelope prefix in storage.
    share = file_repo.get_key_share(file_id)
    salt = (share or {}).get('salt')
    if salt is None:
        try:
            salt = _envelope_salt(
                storage.read_prefix(file_info['path'], _ENVELOPE_PREFIX_LENGTH))
        except StorageError:
            salt = None
    file_type = file_info.get('type', 'file')
    return render_template('view.html', file_id=file_id, original_name=file_info.get('original_name'), file_type=file_type,
                           salt=salt,
                           max_attempts=current_app.config['KEY_RELEASE_MAX_ATTEMPTS'])


def _release_rate_limit_key() -> str:
    """Rate-limit /release per file_id — rotating IPs must not reset it."""
    return f"release:{request.view_args.get('file_id') or get_client_ip()}"


@app.route('/release/<file_id>', methods=['POST'])
@limiter.limit(
    lambda: current_app.config['KEY_RELEASE_RATE_LIMIT'],
    key_func=_release_rate_limit_key,
    methods=['POST'],
    error_message=RATE_LIMIT_EXCEEDED_MESSAGE,
)
def release_key(file_id):
    """
    Server-gated key release (docs/true-one-time.md §6.4): the client proves
    password knowledge by presenting verifier V'. The whole attempt —
    read state, constant-time compare, claim-or-count — runs inside ONE
    transaction in FileStore.attempt_key_release, so racing requests
    serialize: exactly one can release H, and a racing correct-V can
    never be pre-empted (or burned) by a wrong-V request that lost.
    """
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return {'error': 'Invalid request'}, 400
    v_hex = data.get('v')
    if isinstance(v_hex, str):
        v_hex = v_hex.strip().lower()
    if not _is_valid_key_material(v_hex):
        return {'error': 'Invalid request'}, 400

    client_ip = get_client_ip()
    result = file_repo.attempt_key_release(
        file_id,
        v_hex,
        current_app.config['KEY_RELEASE_MAX_ATTEMPTS'],
        current_app.config['KEY_RELEASE_BURN_ON_LOCKOUT'],
    )
    status = result['status']

    if status == 'ok':
        current_app.logger.info(
            'Key-release share %s released (ip=%s)', file_id, client_ip)
        # The ticket itself isn't sent: the client derives it from H
        # (HKDF), and the server keeps only its digest on the share row.
        return {'h': result['h']}
    if status == 'denied':
        current_app.logger.warning(
            'Failed key-release attempt on %s (attempts=%s, ip=%s)',
            file_id, result.get('attempts'), client_ip)
        return {
            'error': 'Incorrect password',
            'attempts_remaining': result['attempts_remaining'],
        }, 403
    if status == 'locked':
        current_app.logger.warning(
            'Key-release share %s locked (attempts exhausted, ip=%s)',
            file_id, client_ip)
        return {'error': 'Too many attempts'}, 429
    if status == 'released':
        return {'error': 'Key already released'}, 410
    if status == 'expired':
        # Share row is already gone; finish the cleanup by dropping the
        # stored blob too.
        if result.get('path'):
            try:
                storage.delete(result['path'])
            except Exception:
                pass
        return {'error': 'File has expired'}, 410
    # missing_file / missing_share / pending — nothing to release.
    return {'error': 'Not found'}, 404


def _report_rate_limit_key() -> str:
    """Rate-limit /report_decryption per file_id, same as /release."""
    return f"report:{request.view_args.get('file_id') or get_client_ip()}"


@app.route('/report_decryption/<file_id>', methods=['POST'])
@limiter.limit(
    lambda: current_app.config['REPORT_DECRYPTION_RATE_LIMIT'],
    key_func=_report_rate_limit_key,
    methods=['POST'],
    error_message=RATE_LIMIT_EXCEEDED_MESSAGE,
)
def report_decryption(file_id):
    """
    Record whether the downloaded file was decrypted successfully.

    Proof-of-decryption: the client must return the 32-byte receipt that
    was encrypted INSIDE the ciphertext — the server stores only its
    SHA-256 hash, so the report is unforgeable from the link/UUID alone.
    The endpoint is unauthenticated (the receipt is the credential), so
    it is rate-limited per file_id like /release.
    """
    file_info = file_repo.get_by_id(file_id)
    if not file_info:
        return {'error': 'File not found'}, 404

    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return {'error': 'Invalid request'}, 400
    receipt_hex = data.get('receipt')
    if isinstance(receipt_hex, str):
        receipt_hex = receipt_hex.strip().lower()
    if (
        'success' not in data
        or not isinstance(data['success'], bool)
        or not _is_valid_key_material(receipt_hex)
    ):
        return {'error': 'Invalid request'}, 400

    stored_hash = file_info.get('receipt_hash')
    candidate_hash = hashlib.sha256(bytes.fromhex(receipt_hex)).hexdigest()
    if not stored_hash or not secrets.compare_digest(
            stored_hash, candidate_hash):
        return {'error': 'Invalid receipt'}, 403

    if file_repo.record_decryption_result(file_id, data['success']):
        file_info['decryption_success'] = data['success']

    latest_file_info = file_repo.get_by_id(file_id) or file_info

    if not latest_file_info.get('notification_sent_at'):
        try:
            send_open_notification_email(latest_file_info)
        except Exception as exc:
            current_app.logger.warning(
                'Failed to send open notification for %s: %s',
                file_id,
                exc,
            )
    return {'status': 'recorded'}


# Print configuration info on startup
config_info = config_class.get_display_info()
print("\n[Configuration]")
for key, value in config_info.items():
    print(f"  {key}: {value}")

if __name__ == '__main__':
    app.run()