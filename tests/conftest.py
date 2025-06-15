import os
import sys
import tempfile
import pytest

# Add parent directory to sys.path to allow direct import of 'app'
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from app import app as flask_app, get_db, get_files_table # Import necessary items from your app

@pytest.fixture(scope='session')
def app():
    """Create and configure a new app instance for each test session."""

    # Create a temporary folder for uploads, isolated for this test session
    temp_upload_folder = tempfile.mkdtemp()

    # Create a temporary file for the TinyDB database
    db_fd, db_path = tempfile.mkstemp(suffix='.json')

    flask_app.config.update({
        'TESTING': True,
        'DATABASE_PATH': db_path,
        'UPLOAD_FOLDER': temp_upload_folder,
        'WTF_CSRF_ENABLED': False, # Disable CSRF for easier testing of forms
        'SECRET_KEY': 'test-secret-key', # Use a fixed secret key for tests
        # Define test users directly in config for simplicity, or use environment variables
        # Ensure these users match what your tests might expect.
        'FLASK_USER_1': 'testuser:password:false',
        'FLASK_USER_2': 'adminuser:adminpass:true',
    })

    # Set environment variables that get_users() relies on
    # Note: app.config is preferred for test configurations if possible,
    # but get_users() directly reads os.getenv.
    os.environ['FLASK_USER_1'] = 'testuser:password:false'
    os.environ['FLASK_USER_2'] = 'adminuser:adminpass:true'
    # Clear any other FLASK_USER_ variables that might interfere
    i = 3
    while os.getenv(f'FLASK_USER_{i}'):
        del os.environ[f'FLASK_USER_{i}']
        i += 1


    # Ensure the test upload folder exists
    os.makedirs(flask_app.config['UPLOAD_FOLDER'], exist_ok=True)

    # Initialize/re-initialize the database for the test app context
    # This ensures that get_db() and get_files_table() use the test database
    with flask_app.app_context():
        # Re-initialize db with the test path
        flask_app.db = get_db() # This will use the updated DATABASE_PATH
        # Optionally, clear out tables if necessary, though TinyDB will use the new file
        files_table = get_files_table()
        files_table.truncate() # Clear the files table for a clean state

    yield flask_app

    # Teardown: clean up the temporary database and upload folder
    os.close(db_fd)
    os.unlink(db_path)
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

@pytest.fixture(scope='function')
def db_instance(app):
    """Provides a direct reference to the test database instance, ensuring tables are clean per test function."""
    with app.app_context():
        database = get_db()
        # Ensuring tables are clean for each test function that uses this fixture.
        # Adjust if you need data to persist across tests within a class/module.
        for table_name in database.tables():
            database.table(table_name).truncate()

        # Specifically ensure 'files' table is clean if it's commonly used
        files_table = get_files_table() # This should get the table from the test DB
        files_table.truncate()
    return database

@pytest.fixture(scope='function')
def files_table(db_instance):
    """Provides a direct reference to the 'files' table from the test_db."""
    return db_instance.table('files')
