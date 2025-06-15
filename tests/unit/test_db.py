import pytest
import os
import shutil # For file operations in cleanup test setup
from unittest import mock
from tinydb import Query
from app import get_files_table, cleanup_orphaned_files # Functions to test
# Fixtures 'app', 'db_instance', 'files_table' will be injected from conftest.py

def test_add_and_get_file_record(files_table):
    # files_table fixture ensures the table is empty at the start of the test
    assert len(files_table.all()) == 0

    file_data = {
        'id': 'uuid1',
        'original_name': 'test.txt',
        'path': '/fake/path/uuid1',
        'uploaded_by': 'testuser',
        'shared_with': []
    }
    files_table.insert(file_data)

    assert len(files_table.all()) == 1
    File = Query()
    retrieved_file = files_table.get(File.id == 'uuid1')
    assert retrieved_file is not None
    assert retrieved_file['original_name'] == 'test.txt'
    assert retrieved_file['uploaded_by'] == 'testuser'

def test_get_non_existent_file_record(files_table):
    File = Query()
    retrieved_file = files_table.get(File.id == 'nonexistent')
    assert retrieved_file is None

def test_cleanup_orphaned_files_no_orphans(app, files_table):
    # app fixture provides UPLOAD_FOLDER
    # files_table fixture provides the db table
    upload_dir = app.config['UPLOAD_FOLDER']

    # Clean the upload directory before the test to remove leftovers from other tests
    for item in os.listdir(upload_dir):
        item_path = os.path.join(upload_dir, item)
        if os.path.isfile(item_path):
            os.remove(item_path)
        elif os.path.isdir(item_path):
            shutil.rmtree(item_path)

    # Create a dummy file on disk that IS tracked
    tracked_file_on_disk_path = os.path.join(upload_dir, "tracked_file.txt")
    with open(tracked_file_on_disk_path, "w") as f:
        f.write("content")

    files_table.insert({'id': '1', 'path': tracked_file_on_disk_path, 'original_name': 'tracked_file.txt'})

    with mock.patch('os.remove') as mock_remove:
        cleanup_orphaned_files() # Call within app context if it relies on current_app directly
        mock_remove.assert_not_called() # No files should be removed

    # Ensure the tracked file is still there (optional, os.remove is mocked)
    assert os.path.exists(tracked_file_on_disk_path)
    # Clean up the created file
    os.remove(tracked_file_on_disk_path)

def test_cleanup_orphaned_files_with_orphans(app, files_table):
    upload_dir = app.config['UPLOAD_FOLDER']

    # Clean the upload directory before the test
    for item in os.listdir(upload_dir):
        item_path = os.path.join(upload_dir, item)
        if os.path.isfile(item_path):
            os.remove(item_path)
        elif os.path.isdir(item_path):
            shutil.rmtree(item_path)

    # File on disk, tracked in DB
    tracked_file_path = os.path.join(upload_dir, "tracked.txt")
    with open(tracked_file_path, "w") as f: f.write("tracked")
    files_table.insert({'id': 't1', 'path': tracked_file_path, 'original_name': 'tracked.txt'})

    # File on disk, NOT tracked in DB (orphan)
    orphaned_file_path = os.path.join(upload_dir, "orphaned.txt")
    with open(orphaned_file_path, "w") as f: f.write("orphan")

    # File in DB, NOT on disk (should be ignored by cleanup_orphaned_files)
    files_table.insert({'id': 'db_only', 'path': os.path.join(upload_dir, "db_only_missing_on_disk.txt"), 'original_name': 'db_only.txt'})

    # Mock os.remove to check it's called on the correct file
    # os.listdir and os.path.exists will operate on the actual temp test upload folder
    removed_paths = []
    original_os_remove = os.remove
    def mock_os_remove(path):
        removed_paths.append(path)
        original_os_remove(path) # actually remove for post-condition check

    with mock.patch('os.remove', side_effect=mock_os_remove) as mocked_remove:
        # cleanup_orphaned_files uses current_app if has_app_context() is true
        # The 'app' fixture should provide this context implicitly.
        # If not, explicitly use with app.app_context():
        with app.app_context():
             cleanup_orphaned_files()

        # Assertions
        assert orphaned_file_path in removed_paths
        assert tracked_file_path not in removed_paths

        mocked_remove.assert_any_call(orphaned_file_path) # Check that os.remove was called with the orphan

        # Verify actual file system state
        assert os.path.exists(tracked_file_path)
        assert not os.path.exists(orphaned_file_path)

    # Cleanup
    if os.path.exists(tracked_file_path):
        os.remove(tracked_file_path)


def test_cleanup_orphaned_files_empty_uploads_dir(app, files_table):
    upload_dir = app.config['UPLOAD_FOLDER']
    # Clean the upload directory before the test (it should be empty for this test's purpose anyway)
    for item in os.listdir(upload_dir):
        item_path = os.path.join(upload_dir, item)
        if os.path.isfile(item_path):
            os.remove(item_path)
        elif os.path.isdir(item_path):
            shutil.rmtree(item_path)

    files_table.insert({'id': 'db_only', 'path': os.path.join(upload_dir, "some_file_in_db.txt")})

    with mock.patch('os.remove') as mock_remove:
        cleanup_orphaned_files()
        mock_remove.assert_not_called()

def test_cleanup_orphaned_files_uploads_dir_does_not_exist(app, files_table):
    # This test needs to temporarily remove the upload directory.
    upload_dir = app.config['UPLOAD_FOLDER']
    original_upload_dir_path = upload_dir

    # Temporarily "remove" the directory by renaming it, or ensure it's gone
    # For this test, cleanup_orphaned_files itself checks os.path.exists(upload_dir)
    # So, we can mock os.path.exists for the upload_dir path to return False.

    with mock.patch('os.path.exists') as mock_path_exists, \
         mock.patch('os.listdir') as mock_listdir, \
         mock.patch('os.remove') as mock_remove:

        # Make os.path.exists return False only for the specific upload_dir path
        def side_effect_exists(path):
            if path == upload_dir:
                return False
            return os.path.exists(path) # Call original for other paths
        mock_path_exists.side_effect = side_effect_exists

        cleanup_orphaned_files()

        mock_listdir.assert_not_called() # Should not attempt to listdir if path doesn't exist
        mock_remove.assert_not_called() # No removal attempts
