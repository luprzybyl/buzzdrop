import os
import uuid
from datetime import datetime
from flask import (
    Flask,
    request,
    render_template,
    send_file,
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
from functools import wraps
from dotenv import load_dotenv
import hashlib
import boto3
from botocore.exceptions import ClientError
from io import BytesIO

# Load environment variables
load_dotenv()

app = Flask(__name__)
app.secret_key = os.urandom(24)

# Configuration from environment variables
app.config['UPLOAD_FOLDER'] = os.getenv('UPLOAD_FOLDER', 'uploads')
app.config['ALLOWED_EXTENSIONS'] = set(
    os.getenv('ALLOWED_EXTENSIONS', 'txt,pdf,png,jpg,jpeg,gif,doc,docx,xls,xlsx').split(',')
)
app.config['MAX_CONTENT_LENGTH'] = int(
    os.getenv('MAX_CONTENT_LENGTH', 16 * 1024 * 1024)
)

# --- S3 CONFIG ---
S3_BUCKET = os.getenv('S3_BUCKET')
S3_ACCESS_KEY = os.getenv('S3_ACCESS_KEY')
S3_SECRET_KEY = os.getenv('S3_SECRET_KEY')
S3_REGION = os.getenv('S3_REGION', 'us-east-1')
STORAGE_BACKEND = os.getenv('STORAGE_BACKEND', 'local')  # 'local' or 's3'

s3_client = None
if STORAGE_BACKEND == 's3':
    s3_client = boto3.client(
        's3',
        aws_access_key_id=S3_ACCESS_KEY,
        aws_secret_access_key=S3_SECRET_KEY,
        region_name=S3_REGION
    )

# Module level defaults for easy access when no app context is present
UPLOAD_FOLDER = app.config['UPLOAD_FOLDER']
ALLOWED_EXTENSIONS = app.config['ALLOWED_EXTENSIONS']
MAX_CONTENT_LENGTH = app.config['MAX_CONTENT_LENGTH']

# Ensure upload directory exists
os.makedirs(app.config['UPLOAD_FOLDER'], exist_ok=True)

# Initialize TinyDB
app.config['DATABASE_PATH'] = os.getenv('DATABASE_PATH', 'db.json')
db = TinyDB(app.config['DATABASE_PATH'])
app.db = db
File = Query()


def print_backend_info():
    print(f"\n[Startup] STORAGE_BACKEND: {STORAGE_BACKEND}")
    if STORAGE_BACKEND == 's3':
        try:
            # Try to list buckets as a connectivity test
            buckets = s3_client.list_buckets()
            print(f"[Startup] S3 Connection OK. Buckets: {[b['Name'] for b in buckets.get('Buckets', [])]}")
            if S3_BUCKET:
                print(f"[Startup] Using S3 bucket: {S3_BUCKET} (region: {S3_REGION})")
        except Exception as e:
            print(f"[Startup] S3 Connection FAILED: {e}")
    else:
        print(f"[Startup] Using local storage. Upload folder: {os.getenv('UPLOAD_FOLDER', 'uploads')}")

print_backend_info()

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

def hash_password(password):
    """Hash a password using SHA-256."""
    return hashlib.sha256(password.encode()).hexdigest()

def get_users():
    """Get all users from environment variables."""
    users = {}
    for key, value in os.environ.items():
        if key.startswith('FLASK_USER_'):
            try:
                # Extract parts from the value
                username, password, is_admin_str = value.split(':', 2)
                users[username] = {
                    'password': hash_password(password),
                    'is_admin': is_admin_str.lower() == 'true'
                }
            except ValueError:
                # Handle cases where the value might not have enough parts
                print(f"Warning: Invalid user format in environment variable {key}")
    return users

def login_required(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if 'username' not in session:
            flash('Please log in to access this page')
            return redirect(url_for('login'))
        return f(*args, **kwargs)
    return decorated_function

def admin_required(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if 'username' not in session:
            flash('Please log in to access this page')
            return redirect(url_for('login'))
        
        users = get_users()
        user = users.get(session['username'])
        if not user or not user['is_admin']:
            flash('Admin access required')
            return redirect(url_for('index'))
        
        return f(*args, **kwargs)
    return decorated_function

def cleanup_orphaned_files():
    """Remove any files in the uploads directory that are not tracked in the database."""
    config = current_app.config if has_app_context() else app.config
    upload_dir = config.get('UPLOAD_FOLDER', UPLOAD_FOLDER)
    if not os.path.exists(upload_dir):
        return

    # Get list of files in uploads directory
    uploaded_files = set(os.listdir(upload_dir))

    # Get list of files we're tracking
    files_table = get_files_table()
    tracked_files = set(
        file_info['path'].split(os.sep)[-1] for file_info in files_table.all()
    )
    
    # Find orphaned files
    orphaned_files = uploaded_files - tracked_files
    
    # Remove orphaned files
    for orphaned_file in orphaned_files:
        try:
            file_path = os.path.join(upload_dir, orphaned_file)
            os.remove(file_path)
            print(f"Removed orphaned file: {orphaned_file}")
        except Exception as e:
            print(f"Error removing orphaned file {orphaned_file}: {str(e)}")

# Clean up orphaned files on startup
cleanup_orphaned_files()

@app.route('/favicon.ico')
def favicon():
    """Serve the site favicon."""
    return send_from_directory(
        os.path.join(app.root_path, 'static'),
        'favicon.ico',
        mimetype='image/vnd.microsoft.icon'
    )

def allowed_file(filename):
    if has_app_context():
        allowed = current_app.config.get('ALLOWED_EXTENSIONS', ALLOWED_EXTENSIONS)
    else:
        allowed = ALLOWED_EXTENSIONS
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in allowed


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
        if STORAGE_BACKEND == 's3':
            try:
                s3_client.delete_object(Bucket=S3_BUCKET, Key=file_info['path'])
            except Exception:
                pass
        else:
            try:
                os.remove(file_info['path'])
            except FileNotFoundError:
                pass
        files_table = get_files_table()
        files_table.update({'status': 'expired'}, File.id == file_info['id'])
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
        files_table = get_files_table()
        # Get files uploaded by the current user
        user_files = files_table.search(File.uploaded_by == session['username'])
        # Format timestamps so table columns remain narrow
        for f in user_files:
            try:
                f['created_at'] = datetime.fromisoformat(f['created_at']).strftime('%Y-%m-%d %H-%M-%S')
            except Exception:
                pass
            if f.get('downloaded_at'):
                try:
                    f['downloaded_at'] = datetime.fromisoformat(f['downloaded_at']).strftime('%Y-%m-%d %H-%M-%S')
                except Exception:
                    pass
            status = f.get('decryption_success')
            if status is True:
                f['decryption_status'] = 'Success'
            elif status is False:
                f['decryption_status'] = 'Failed'
            else:
                f['decryption_status'] = 'Pending'

        # Get files shared with the current user
        shared_files = files_table.search(
            (File.shared_with.any([session['username']]))
            & (File.uploaded_by != session['username'])
        )

        print("user_files: ", user_files)
        
        return render_template(
            'index.html', 
            user_files=user_files, 
            shared_files=shared_files,
            allowed_extensions=list(
                current_app.config.get('ALLOWED_EXTENSIONS', ALLOWED_EXTENSIONS)
            ),
            max_content_length=current_app.config.get(
                'MAX_CONTENT_LENGTH', MAX_CONTENT_LENGTH
            )
        )
    return render_template(
        'index.html',
        allowed_extensions=list(
            current_app.config.get('ALLOWED_EXTENSIONS', ALLOWED_EXTENSIONS)
        ),
        max_content_length=current_app.config.get(
            'MAX_CONTENT_LENGTH', MAX_CONTENT_LENGTH
        ),
    )

@app.route('/login', methods=['GET', 'POST'])
def login():
    if request.method == 'POST':
        username = request.form.get('username')
        password = request.form.get('password')
        
        users = get_users()
        user = users.get(username)
        if user and user['password'] == hash_password(password):
            session['username'] = username
            session['is_admin'] = user['is_admin']
            flash('Logged in successfully')
            return redirect(url_for('index'))
        else:
            flash('Invalid username or password')
    
    return render_template('login.html')

@app.route('/logout')
def logout():
    session.pop('username', None)
    session.pop('is_admin', None)
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
    if 'file' not in request.files:
        flash('No file part')
        return redirect(url_for('index'))
    file = request.files['file']
    if file.filename == '':
        flash('No selected file')
        return redirect(url_for('index'))
    if file and allowed_file(file.filename):
        filename = secure_filename(file.filename)
        unique_id = str(uuid.uuid4())
        files_table = get_files_table()
        if STORAGE_BACKEND == 's3':
            s3_key = f"uploads/{unique_id}"
            # Upload to S3
            s3_client.upload_fileobj(file, S3_BUCKET, s3_key)
            file_path = s3_key
        else:
            upload_dir = current_app.config.get('UPLOAD_FOLDER', UPLOAD_FOLDER)
            os.makedirs(upload_dir, exist_ok=True)
            file_path = os.path.join(upload_dir, unique_id)
            file.save(file_path)
        expiry_raw = request.form.get('expiry')
        expiry_iso = None
        if expiry_raw:
            try:
                expiry_iso = datetime.fromisoformat(expiry_raw).isoformat()
            except ValueError:
                expiry_iso = None

        files_table.insert({
            'id': unique_id,
            'original_name': filename,
            'path': file_path,
            'created_at': datetime.now().isoformat(),
            'downloaded_at': None,
            'uploaded_by': session['username'],
            'expiry_at': expiry_iso,
            'status': 'active',
            'decryption_success': None
        })
        share_link = url_for('view_file', file_id=unique_id, _external=True)
        if request.headers.get('X-Requested-With') == 'XMLHttpRequest':
            return {
                'file_id': unique_id,
                'share_link': share_link
            }
        return render_template('success.html', share_link=share_link)
    flash('File type not allowed')
    if request.headers.get('X-Requested-With') == 'XMLHttpRequest':
        return {'error': 'File type not allowed'}, 400
    return redirect(url_for('index'))

# Remove confirm_download route, logic moves to /view/<file_id> and /view/<file_id>/confirm

@app.route('/download/<file_id>', methods=['GET'])
def download_file(file_id):
    files_table = get_files_table()
    file_info = files_table.get(File.id == file_id)
    if not file_info:
        flash('File not found')
        return redirect(url_for('index'))
    if 'downloaded_at' in file_info and file_info['downloaded_at'] is not None:
        flash('This file has already been downloaded at {}'.format(file_info['downloaded_at']))
        return redirect(url_for('index'))
    if check_and_handle_expiry(file_info):
        flash('File has expired')
        return redirect(url_for('index'))
    # Mark file as downloaded (set timestamp)
    files_table.update({'downloaded_at': datetime.now().isoformat()}, File.id == file_id)
    if STORAGE_BACKEND == 's3':
        s3_key = file_info['path']
        try:
            s3_obj = s3_client.get_object(Bucket=S3_BUCKET, Key=s3_key)
            def generate():
                for chunk in iter(lambda: s3_obj['Body'].read(8192), b''):
                    yield chunk
            response = current_app.response_class(
                generate(),
                headers={
                    'Content-Disposition': f"attachment; filename={file_info['original_name']}"
                },
                mimetype='application/octet-stream'
            )
            # Optionally, delete from S3 after download (for one-time download)
            try:
                s3_client.delete_object(Bucket=S3_BUCKET, Key=s3_key)
            except Exception:
                pass
            return response
        except ClientError:
            flash('File not found in S3')
            return redirect(url_for('index'))
    else:
        def generate():
            with open(file_info['path'], 'rb') as file_handle:
                while True:
                    chunk = file_handle.read(8192)
                    if not chunk:
                        break
                    yield chunk
            try:
                os.remove(file_info['path'])
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
    files_table = get_files_table()
    file_info = files_table.get(File.id == file_id)

    if not file_info or file_info.get('uploaded_by') != session['username']:
        flash('File not found')
        return redirect(url_for('index'))

    # Remove the file from disk or S3 if it hasn't been downloaded yet
    if not file_info.get('downloaded_at'):
        if STORAGE_BACKEND == 's3':
            try:
                s3_client.delete_object(Bucket=S3_BUCKET, Key=file_info['path'])
            except Exception:
                pass
        else:
            try:
                os.remove(file_info['path'])
            except FileNotFoundError:
                pass

    files_table.remove(File.id == file_id)
    flash('File deleted successfully')
    return redirect(url_for('index'))


@app.route('/success/<file_id>')
@login_required
def upload_success(file_id):
    share_link = url_for('view_file', file_id=file_id, _external=True)
    return render_template('success.html', share_link=share_link)


@app.route('/view/<file_id>', methods=['GET'])
def view_file(file_id):
    files_table = get_files_table()
    file_info = files_table.get(File.id == file_id)
    if not file_info or file_info['downloaded_at'] is not None:
        flash('File not found')
        return redirect(url_for('index'))
    if check_and_handle_expiry(file_info):
        flash('File has expired')
        return redirect(url_for('index'))
    return render_template('confirm_download.html', file_id=file_id, original_name=file_info['original_name'])

@app.route('/view/<file_id>/confirm', methods=['POST'])
def confirm_view_file(file_id):
    files_table = get_files_table()
    file_info = files_table.get(File.id == file_id)
    if not file_info or file_info['downloaded_at'] is not None:
        flash('File not found')
        return redirect(url_for('index'))
    if check_and_handle_expiry(file_info):
        flash('File has expired')
        return redirect(url_for('index'))
    return render_template('view.html', file_id=file_id, original_name=file_info['original_name'])


@app.route('/report_decryption/<file_id>', methods=['POST'])
def report_decryption(file_id):
    """Record whether the downloaded file was decrypted successfully."""
    files_table = get_files_table()
    file_info = files_table.get(File.id == file_id)
    if not file_info:
        return {'error': 'File not found'}, 404

    data = request.get_json(silent=True) or {}
    if 'success' not in data:
        return {'error': 'Invalid request'}, 400

    if file_info.get('decryption_success') is None:
        files_table.update({'decryption_success': bool(data['success'])}, File.id == file_id)
    return {'status': 'recorded'}


print("upload folder: " + app.config['UPLOAD_FOLDER'])
print("database path: " + app.config['DATABASE_PATH'])

if __name__ == '__main__':
    app.run(debug=True)