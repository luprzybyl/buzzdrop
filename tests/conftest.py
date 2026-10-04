import hashlib
import io
import os
import secrets
import sys
import tempfile
import uuid
import pytest
from dotenv import load_dotenv

# Set required environment variables before loading app
os.environ['FLASK_SECRET_KEY'] = 'test-secret-key-for-testing-only'
os.environ['FLASK_USER_1'] = 'testuser:password:false'
os.environ['FLASK_USER_2'] = 'adminuser:adminpass:true'

# Load .env.example for all test runs
load_dotenv(dotenv_path=os.path.join(os.path.dirname(os.path.dirname(__file__)), '.env.example'), override=False)

# Add parent directory to sys.path to allow direct import of 'app'
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from app import app as flask_app, get_backend, get_files_store, limiter # Import necessary items from your app
from auth import get_users

@pytest.fixture(scope='session')
def app():
    """Create and configure a new app instance for each test session."""

    # Create a temporary folder for uploads, isolated for this test session
    temp_upload_folder = tempfile.mkdtemp()

    # Create a temporary file for the SQLite database
    db_fd, db_path = tempfile.mkstemp(suffix='.db')

    flask_app.config.update({
        'TESTING': True,
        'DATABASE_URL': f'sqlite:///{db_path}',
        'UPLOAD_FOLDER': temp_upload_folder,
        'WTF_CSRF_ENABLED': False, # Disable CSRF for easier testing of forms
    })

    # Environment variables for test users are already set at module level
    # Clear any other FLASK_USER_ variables that might interfere
    i = 3
    while os.getenv(f'FLASK_USER_{i}'):
        del os.environ[f'FLASK_USER_{i}']
        i += 1


    # Ensure the test upload folder exists
    os.makedirs(flask_app.config['UPLOAD_FOLDER'], exist_ok=True)

    # Initialize/re-initialize the backend for the test app context
    # This ensures that get_backend() and get_files_store() use the test database
    with flask_app.app_context():
        # Re-initialize backend with the test DATABASE_URL
        flask_app.backend = get_backend()
        files_store = get_files_store()
        files_store.truncate() # Clear the files table for a clean state

    yield flask_app

    # Teardown: clean up the temporary database and upload folder
    with flask_app.app_context():
        backend = getattr(flask_app, 'backend', None)
        if backend is not None:
            backend.close()
    os.close(db_fd)
    os.unlink(db_path)
    # WAL sidecars, if any
    for suffix in ('-wal', '-shm'):
        sidecar = db_path + suffix
        if os.path.exists(sidecar):
            os.unlink(sidecar)
    # Clean up the temporary upload folder and its contents
    for root, dirs, files in os.walk(temp_upload_folder, topdown=False):
        for name in files:
            os.remove(os.path.join(root, name))
        for name in dirs:
            os.rmdir(os.path.join(root, name))
    os.rmdir(temp_upload_folder)

    # Clean up environment variables set for the test
    del os.environ['FLASK_USER_1']
    del os.environ['FLASK_USER_2']


@pytest.fixture
def client(app):
    """A test client for the app."""
    return app.test_client()


@pytest.fixture
def csrf_form_data(client):
    """Return form data containing a valid session-backed CSRF token."""
    def _csrf_form_data():
        with client.session_transaction() as session:
            csrf_token = session.get('csrf_token')
            if not csrf_token:
                csrf_token = 'test-csrf-token'
                session['csrf_token'] = csrf_token
        return {'csrf_token': csrf_token}

    return _csrf_form_data


@pytest.fixture(autouse=True)
def reset_rate_limiter():
    """Reset in-memory rate limit state between tests."""
    limiter.reset()
    yield
    limiter.reset()

@pytest.fixture(autouse=True)
def reset_user_cache():
    """Reset cached environment-backed users between tests."""
    get_users.cache_clear()
    yield
    get_users.cache_clear()

@pytest.fixture(scope='function')
def db_instance(app):
    """Provides a direct reference to the test backend, ensuring tables are clean per test function."""
    with app.app_context():
        backend = get_backend()
        backend.files.truncate()
        backend.tokens.truncate()
    return backend

@pytest.fixture(scope='function')
def files_store(db_instance):
    """Provides a direct reference to the files store of the test backend."""
    return db_instance.files

@pytest.fixture(scope='function')
def tokens_store(db_instance):
    """Provides a direct reference to the api_tokens store of the test backend."""
    return db_instance.tokens


def receipt_pair():
    """Return (receipt_hex, receipt_hash_hex) for a fresh fake receipt."""
    receipt = secrets.token_bytes(32)
    return receipt.hex(), hashlib.sha256(receipt).hexdigest()


@pytest.fixture
def key_share(files_store):
    """
    Create a pending key share directly in the store — the same
    state /upload/begin produces, without spending a rate-limited request.

    Returns a factory: _create(file_id=None, created_by='testuser')
    -> (file_id, h_hex). ``created_by`` defaults to the test user so
    owner binding lets the logged-in client finish the upload.
    """
    def _create(file_id=None, created_by='testuser'):
        file_id = file_id or str(uuid.uuid4())
        h_hex = secrets.token_hex(32)
        files_store.create_key_share(file_id, h_hex, created_by=created_by)
        return file_id, h_hex
    return _create


@pytest.fixture
def key_release_upload(client, key_share):
    """
    POST a complete two-phase key-release upload and return
    (file_id, h_hex, receipt_hex, response).

    ``data`` is merged into the multipart form; pass note fields for text
    notes. ``verifier`` defaults to a fixed valid hex string — the real
    V is only meaningful to crypto tests, not to route tests.
    """
    def _upload(data=None, filename='test.txt', content=b'content',
                headers=None, verifier='cc' * 32, xhr=True):
        file_id, h_hex = key_share()
        receipt_hex, receipt_hash = receipt_pair()
        form = dict(data or {})
        if 'file' not in form and 'note_text' not in form:
            form['file'] = (io.BytesIO(content), filename)
        form['file_id'] = file_id
        form['key_verifier'] = verifier
        form['receipt_hash'] = receipt_hash
        if headers is None:
            headers = {'X-Requested-With': 'XMLHttpRequest'} if xhr else {}
        response = client.post(
            '/upload',
            data=form,
            content_type='multipart/form-data',
            headers=headers,
        )
        return file_id, h_hex, receipt_hex, response
    return _upload
