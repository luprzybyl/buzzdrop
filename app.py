import math
import os
import secrets
import smtplib
import uuid
from datetime import datetime, timedelta
from email.message import EmailMessage
from email.utils import parseaddr
from io import BytesIO
from flask import (
    Flask,
    g,
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
from werkzeug.exceptions import RequestEntityTooLarge
from werkzeug.utils import secure_filename
from flask_limiter import Limiter
from tinydb import TinyDB, Query
from dotenv import load_dotenv
import base64
import hashlib

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
    subject = f'Buzzdrop {share_type.lower()} opened: {original_name}'
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


@app.context_processor
def sri_hash_processor():
    """Context processor to generate SRI hashes for static files."""
    def sri_hash(filename):
        """
        Generate SHA-384 SRI hash for a static file.
        
        Args:
            filename: Relative path to the static file (e.g., 'js/main.js')
            
        Returns:
            str: SRI hash in format 'sha384-<base64-hash>' or empty string if file not found
        """
        try:
            # Construct the full path to the static file
            filepath = os.path.join(app.static_folder, filename)
            with open(filepath, 'rb') as f:
                # Read the file content
                file_content = f.read()
                # Calculate SHA-384 hash
                hashed = hashlib.sha384(file_content).digest()
                # Encode it in Base64
                return 'sha384-' + base64.b64encode(hashed).decode()
        except FileNotFoundError:
            # In case the file doesn't exist, raise error in development or log warning in production
            import logging
            env = os.getenv('FLASK_ENV', 'production')
            if env == 'development':
                raise FileNotFoundError(f"SRI hash requested for missing static file: {filename}")
            else:
                logging.warning(f"SRI hash requested for missing static file: {filename}")
                return ""
    return dict(sri_hash=sri_hash)

# Ensure upload directory exists (for local storage)
if app.config['STORAGE_BACKEND'] == 'local':
    os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)

# Initialize TinyDB
db = TinyDB(app.config['DATABASE_PATH'])
app.db = db
File = Query()

# Initialize storage backend
storage = get_storage_backend(app.config)
print_backend_info(storage)

# Initialize file repository
file_repo = FileRepository()

def get_db():
    """
    Return a TinyDB instance, reopening it if necessary.
    
    This function handles the complexity of TinyDB connections across Flask app contexts.
    It checks if the database handle is still open and reconnects if needed. This is
    particularly important for:
    - Test scenarios where the database file may be recreated between tests
    - Long-running applications where file handles may become stale
    - Multiple app contexts accessing the same database
    
    Returns:
        TinyDB: Active database instance for the current app context
    """
    if has_app_context():
        database = getattr(current_app, 'db', None)
        path = current_app.config.get('DATABASE_PATH', app.config['DATABASE_PATH'])
        if database is None or getattr(database._storage, '_handle', None) is None or database._storage._handle.closed:
            database = TinyDB(path)
            current_app.db = database
    else:
        database = getattr(app, 'db', None)
        path = app.config['DATABASE_PATH']
        if database is None or getattr(database._storage, '_handle', None) is None or database._storage._handle.closed:
            database = TinyDB(path)
            app.db = database
    return database


def get_files_table():
    """Return the TinyDB table respecting the current app configuration."""
    database = get_db()
    return database.table('files')

# Clean up orphaned files on startup (local storage only)
if app.config['STORAGE_BACKEND'] == 'local':
    files_table = get_files_table()
    tracked_files = set(
        file_info['path'].split(os.sep)[-1] for file_info in files_table.all()
    )
    cleanup_orphaned_files(app.config['UPLOAD_FOLDER'], tracked_files)

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
        
        # Mark as expired in database
        file_repo.mark_expired(file_info['id'])
        file_info['status'] = 'expired'
        return True

    return False


@app.errorhandler(RequestEntityTooLarge)
def handle_large_file(error):
    """Return a user-friendly message when the uploaded file exceeds the limit."""
    if request.headers.get('X-Requested-With') == 'XMLHttpRequest':
        return {'error': 'File too large'}, 413
    flash('File too large')
    return 'File too large', 413


@app.errorhandler(429)
def handle_rate_limit(error):
    """Return consistent rate-limit responses for HTML, AJAX, and API clients."""
    message = getattr(error, 'description', RATE_LIMIT_EXCEEDED_MESSAGE)
    is_api_request = (
        request.path.startswith('/api/')
        or request.headers.get('Authorization', '').startswith('Bearer ')
        or request.headers.get('X-Requested-With') == 'XMLHttpRequest'
    )

    if is_api_request:
        return {'error': message}, 429

    if request.endpoint == 'login':
        flash(message)
        return render_template('login.html'), 429

    return message, 429

@app.route('/')
def index():
    """Home page route."""
    current_user = get_current_user()
    if current_user:
        username = current_user['username']
        # Get files uploaded by the current user
        user_files = file_repo.get_user_files(username)
        
        # Check expiry and format for display
        for f in user_files:
            check_and_handle_expiry(f)
            enhance_file_display(f)

        # Get files shared with the current user
        shared_files = file_repo.get_shared_files(username)
        
        return render_template(
            'index.html', 
            user_files=user_files, 
            shared_files=shared_files,
            allowed_extensions=list(current_app.config.get('ALLOWED_EXTENSIONS')),
            max_content_length=current_app.config.get('MAX_CONTENT_LENGTH'),
            configured_notification_email=current_user.get('email'),
        )
    
    return render_template(
        'index.html',
        allowed_extensions=list(current_app.config.get('ALLOWED_EXTENSIONS')),
        max_content_length=current_app.config.get('MAX_CONTENT_LENGTH'),
    )

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
            flash('Logged in successfully')
            return redirect(url_for('index'))
        else:
            flash('Invalid username or password')

    return render_template('login.html')

@app.route('/logout')
def logout():
    logout_user()
    flash('Logged out successfully')
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

    if not _is_valid_csrf_token():
        if wants_json:
            return {'error': 'CSRF validation failed'}, 403
        flash('Invalid request')
        return redirect(url_for('manage_users' if current_user.get('is_admin', False) else 'index'))

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

    revoke_api_token_by_id(token_id)

    if wants_json:
        return {'status': 'revoked'}, 200

    flash('API token revoked')
    return redirect(url_for('manage_users' if current_user.get('is_admin', False) else 'index'))


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

    try:
        notify_on_open, notification_email = _get_notification_preferences(g.username)
    except NotificationPreferenceError as exc:
        if wants_json:
            return {'error': exc.message}, 400
        flash(exc.message)
        return redirect(url_for('index'))

    if upload_type == 'text' and note_text:
        # Handle text note upload
        # Decode base64 encrypted data
        text_bytes = base64.b64decode(note_text)
        
        # Parse expiry date
        expiry_raw = request.form.get('expiry')
        expiry_iso = None
        if expiry_raw:
            try:
                expiry_iso = datetime.fromisoformat(expiry_raw).isoformat()
            except ValueError:
                expiry_iso = None

        # Generate unique ID
        unique_id = str(uuid.uuid4())
        
        # Save to storage
        file_path = storage.save(unique_id, text_bytes)

        # Create database entry
        file_repo.create({
            'original_name': 'Secret Note',
            'path': file_path,
            'uploaded_by': g.username,
            'expiry_at': expiry_iso,
            'type': 'text',
            'private_note': private_note,
            'notify_on_open': notify_on_open,
            'notification_email': notification_email,
        }, file_id=unique_id)
        
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
        
        # Generate unique ID and save to storage
        unique_id = str(uuid.uuid4())
        file_path = storage.save(unique_id, file)
        
        # Parse expiry date
        expiry_raw = request.form.get('expiry')
        expiry_iso = None
        if expiry_raw:
            try:
                expiry_iso = datetime.fromisoformat(expiry_raw).isoformat()
            except ValueError:
                expiry_iso = None

        # Create database entry
        file_repo.create({
            'original_name': filename,
            'path': file_path,
            'uploaded_by': g.username,
            'expiry_at': expiry_iso,
            'type': 'file',
            'private_note': private_note,
            'notify_on_open': notify_on_open,
            'notification_email': notification_email,
        }, file_id=unique_id)
        
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
    file_info = file_repo.get_by_id(file_id)
    if not file_info:
        flash('File not found')
        return redirect(url_for('index'))
    if 'downloaded_at' in file_info and file_info['downloaded_at'] is not None:
        flash('This file has already been downloaded at {}'.format(file_info['downloaded_at']))
        return redirect(url_for('index'))
    if check_and_handle_expiry(file_info):
        flash('File has expired')
        return redirect(url_for('index'))

    # Get client IP address
    client_ip = get_client_ip()

    # Mark file as downloaded
    file_repo.mark_downloaded(file_id, client_ip)
    
    # Stream file from storage
    def generate():
        for chunk in storage.retrieve(file_info['path']):
            yield chunk
        # Delete file after streaming completes
        try:
            storage.delete(file_info['path'])
        except Exception:
            pass
    
    response = current_app.response_class(
        generate(),
        headers={
            'Content-Disposition': f"attachment; filename={file_info['original_name']}"
        },
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
    flash('File deleted successfully')
    return redirect(url_for('index'))


@app.route('/success/<file_id>')
@login_required
def upload_success(file_id):
    share_link = url_for('view_file', file_id=file_id, _external=True)
    return render_template('success.html', share_link=share_link)


@app.route('/view/<file_id>', methods=['GET'])
@limiter.shared_limit(
    lambda: current_app.config['PUBLIC_FILE_RATE_LIMIT'],
    'public_file_access',
    methods=['GET'],
    error_message=RATE_LIMIT_EXCEEDED_MESSAGE,
)
def view_file(file_id):
    file_info = file_repo.get_by_id(file_id)
    if not file_info or file_info['downloaded_at'] is not None:
        flash('File not found')
        return redirect(url_for('index'))
    if check_and_handle_expiry(file_info):
        flash('File has expired')
        return redirect(url_for('index'))
    file_type = file_info.get('type', 'file')
    return render_template('confirm_download.html', file_id=file_id, original_name=file_info['original_name'], file_type=file_type)

@app.route('/view/<file_id>/confirm', methods=['POST'])
@limiter.shared_limit(
    lambda: current_app.config['PUBLIC_FILE_RATE_LIMIT'],
    'public_file_access',
    methods=['POST'],
    error_message=RATE_LIMIT_EXCEEDED_MESSAGE,
)
def confirm_view_file(file_id):
    file_info = file_repo.get_by_id(file_id)
    if not file_info or file_info['downloaded_at'] is not None:
        flash('File not found')
        return redirect(url_for('index'))
    if check_and_handle_expiry(file_info):
        flash('File has expired')
        return redirect(url_for('index'))
    if not _is_valid_csrf_token():
        flash('Invalid request')
        return redirect(url_for('view_file', file_id=file_id))
    file_type = file_info.get('type', 'file')
    return render_template('view.html', file_id=file_id, original_name=file_info['original_name'], file_type=file_type)


@app.route('/report_decryption/<file_id>', methods=['POST'])
def report_decryption(file_id):
    """Record whether the downloaded file was decrypted successfully."""
    file_info = file_repo.get_by_id(file_id)
    if not file_info:
        return {'error': 'File not found'}, 404

    data = request.get_json(silent=True) or {}
    if 'success' not in data or not isinstance(data['success'], bool):
        return {'error': 'Invalid request'}, 400

    if file_info.get('decryption_success') is None:
        file_repo.update_decryption_status(file_id, data['success'])
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