import os
import uuid
from datetime import datetime
from io import BytesIO
from flask import (
    Flask,
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
from tinydb import TinyDB, Query
from dotenv import load_dotenv
import base64
import hashlib

# Load environment variables FIRST, before any other imports that read env vars
env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.env')
env_loaded = load_dotenv(dotenv_path=env_path)
print(f"[APP.PY] .env path: {env_path}")
print(f"[APP.PY] .env file loaded: {env_loaded}")
print(f"[APP.PY] .env exists: {os.path.exists(env_path)}")
print(f"[APP.PY] Current working directory: {os.getcwd()}")
print(f"[APP.PY] FLASK_SECRET_KEY present: {bool(os.getenv('FLASK_SECRET_KEY'))}")
print(f"[APP.PY] FLASK_USER_1 present: {bool(os.getenv('FLASK_USER_1'))}")
print(f"[APP.PY] STORAGE_BACKEND: {os.getenv('STORAGE_BACKEND', 'NOT SET')}")

# Import new modules AFTER loading .env
from config import get_config
from storage import get_storage_backend, print_backend_info, StorageError
from auth import login_required, admin_required, get_users, login_user, logout_user
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

# Validate configuration
try:
    config_class.validate()
except ValueError as e:
    print(f"Configuration error: {e}")
    # Generate temporary secret key for development
    if not app.config.get('SECRET_KEY') and os.getenv('FLASK_ENV') != 'production':
        import secrets
        app.config['SECRET_KEY'] = secrets.token_hex(32)
        print("WARNING: Using temporary session key. Set FLASK_SECRET_KEY in .env for production!")
    else:
        raise

# Generate temporary secret key for development if not set
if not app.config.get('SECRET_KEY'):
    if os.getenv('FLASK_ENV') == 'production':
        raise ValueError("FLASK_SECRET_KEY must be set in production environment")
    import secrets
    app.config['SECRET_KEY'] = secrets.token_hex(32)
    print("WARNING: Using temporary session key. Set FLASK_SECRET_KEY in .env for production!")

app.secret_key = app.config['SECRET_KEY']

# --- SRI HASH HELPER ---
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
    """Return a TinyDB instance, reopening it if necessary."""
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

@app.route('/')
def index():
    """Home page route."""
    if 'username' in session:
        # Get files uploaded by the current user
        user_files = file_repo.get_user_files(session['username'])
        
        # Check expiry and format for display
        for f in user_files:
            check_and_handle_expiry(f)
            enhance_file_display(f)

        # Get files shared with the current user
        shared_files = file_repo.get_shared_files(session['username'])
        
        return render_template(
            'index.html', 
            user_files=user_files, 
            shared_files=shared_files,
            allowed_extensions=list(current_app.config.get('ALLOWED_EXTENSIONS')),
            max_content_length=current_app.config.get('MAX_CONTENT_LENGTH')
        )
    
    return render_template(
        'index.html',
        allowed_extensions=list(current_app.config.get('ALLOWED_EXTENSIONS')),
        max_content_length=current_app.config.get('MAX_CONTENT_LENGTH'),
    )

@app.route('/login', methods=['GET', 'POST'])
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
    users = get_users()
    return render_template('users.html', users=users)

@app.route('/upload', methods=['POST'])
@login_required
def upload_file():
    # Check if this is a text note upload
    note_text = request.form.get('note_text')
    upload_type = request.form.get('type', 'file')

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
            'uploaded_by': session['username'],
            'expiry_at': expiry_iso,
            'type': 'text'
        }, file_id=unique_id)
        
        share_link = url_for('view_file', file_id=unique_id, _external=True)
        if request.headers.get('X-Requested-With') == 'XMLHttpRequest':
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
            'uploaded_by': session['username'],
            'expiry_at': expiry_iso,
            'type': 'file'
        }, file_id=unique_id)
        
        share_link = url_for('view_file', file_id=unique_id, _external=True)
        if request.headers.get('X-Requested-With') == 'XMLHttpRequest':
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
    file_info = file_repo.get_by_id(file_id)

    if not file_info or file_info.get('uploaded_by') != session['username']:
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
def confirm_view_file(file_id):
    file_info = file_repo.get_by_id(file_id)
    if not file_info or file_info['downloaded_at'] is not None:
        flash('File not found')
        return redirect(url_for('index'))
    if check_and_handle_expiry(file_info):
        flash('File has expired')
        return redirect(url_for('index'))
    file_type = file_info.get('type', 'file')
    return render_template('view.html', file_id=file_id, original_name=file_info['original_name'], file_type=file_type)


@app.route('/report_decryption/<file_id>', methods=['POST'])
def report_decryption(file_id):
    """Record whether the downloaded file was decrypted successfully."""
    file_info = file_repo.get_by_id(file_id)
    if not file_info:
        return {'error': 'File not found'}, 404

    data = request.get_json(silent=True) or {}
    if 'success' not in data:
        return {'error': 'Invalid request'}, 400

    if file_info.get('decryption_success') is None:
        file_repo.update_decryption_status(file_id, bool(data['success']))
    return {'status': 'recorded'}


# Print configuration info on startup
config_info = config_class.get_display_info()
print("\n[Configuration]")
for key, value in config_info.items():
    print(f"  {key}: {value}")

if __name__ == '__main__':
    app.run()