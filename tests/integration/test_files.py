import pytest
import os
from flask import url_for, session, current_app
from tinydb import Query
import io # For creating dummy file content for uploads
from datetime import datetime, timedelta
# Fixtures: 'app', 'client', 'db_instance', 'files_table' from conftest.py
# Test users from conftest.py: 'testuser:password:false', 'adminuser:adminpass:true'

def login_user(client, username, password):
    return client.post(url_for('login'), data={'username': username, 'password': password}, follow_redirects=True)

# Helper function to upload a file for a user
def upload_file_for_user(client, app, files_table, filename, content, username_for_db_record):
    file_data = {'file': (io.BytesIO(content.encode()), filename)}
    client.post(url_for('upload_file'), data=file_data, content_type='multipart/form-data')

    File = Query()
    file_info = files_table.get((File.original_name == filename) & (File.uploaded_by == username_for_db_record))
    return file_info['id'] if file_info else None

def test_upload_file_requires_login(client):
    response = client.post(url_for('upload_file'), data={'file': (io.BytesIO(b"test content"), "test.txt")}, follow_redirects=True)
    assert url_for('login') in response.request.path
    assert b'Please log in to access this page' in response.data

def test_upload_file_success(client, app, files_table):
    login_user(client, 'testuser', 'password')

    file_content = b"This is a test file."
    file_name = "upload_test.txt"
    data = {'file': (io.BytesIO(file_content), file_name)}

    data = {'file': (io.BytesIO(file_content), file_name)}

    # Using follow_redirects=False. If successful, should render success.html directly with 200.
    # If it redirects, status would be 302.
    response = client.post(url_for('upload_file'), data=data, content_type='multipart/form-data', follow_redirects=False)

    assert response.status_code == 200
    # Ensure content from success.html is present, not index.html
    assert b'File Uploaded Successfully!' in response.data
    assert b'id="share-link"' in response.data # Check that the input field for the link is there

    File = Query()
    file_info = files_table.get(File.original_name == file_name)
    assert file_info is not None
    assert file_info['uploaded_by'] == 'testuser'

    file_path_on_disk = os.path.join(app.config['UPLOAD_FOLDER'], file_info['id'])
    assert os.path.exists(file_path_on_disk)
    with open(file_path_on_disk, 'rb') as f:
        assert f.read() == file_content

def test_upload_file_no_file_part(client):
    login_user(client, 'testuser', 'password')
    response = client.post(url_for('upload_file'), data={}, follow_redirects=True)
    assert b'No file part' in response.data
    assert url_for('index') in response.request.path # Redirects to index

def test_upload_file_no_selected_file(client):
    login_user(client, 'testuser', 'password')
    response = client.post(url_for('upload_file'), data={'file': (io.BytesIO(b""), "")}, follow_redirects=True) # Empty filename
    assert b'No selected file' in response.data
    assert url_for('index') in response.request.path

def test_upload_file_disallowed_extension(client, app):
    login_user(client, 'testuser', 'password')
    data = {'file': (io.BytesIO(b"some data"), "test.exe")}
    response = client.post(url_for('upload_file'), data=data, content_type='multipart/form-data', follow_redirects=True)
    assert b'File type not allowed' in response.data
    assert url_for('index') in response.request.path

def test_upload_file_too_large(client, app):
    login_user(client, 'testuser', 'password')
    original_max_length = app.config['MAX_CONTENT_LENGTH']
    app.config['MAX_CONTENT_LENGTH'] = 10 # Set a very small limit for testing

    file_content = b"This content is larger than 10 bytes."
    data = {'file': (io.BytesIO(file_content), "large_file.txt")}

    response_no_redirect = client.post(url_for('upload_file'), data=data, content_type='multipart/form-data')
    assert response_no_redirect.status_code == 413 # Request Entity Too Large

    app.config['MAX_CONTENT_LENGTH'] = original_max_length # Reset

def test_download_file_success(client, app, files_table):
    login_user(client, 'testuser', 'password')

    file_content = b"Downloadable content."
    file_name = "download_me.txt"
    upload_data = {'file': (io.BytesIO(file_content), file_name)}
    client.post(url_for('upload_file'), data=upload_data, content_type='multipart/form-data')

    File = Query()
    file_info = files_table.get(File.original_name == file_name)
    assert file_info is not None
    file_id = file_info['id']
    file_path_on_disk = file_info['path'] # In the test setup, 'path' is the unique_id in upload_folder
                                        # So, need to join with app.config['UPLOAD_FOLDER']

    # Corrected file_path_on_disk for test environment
    actual_file_path_on_disk = os.path.join(app.config['UPLOAD_FOLDER'], file_info['id'])
    assert os.path.exists(actual_file_path_on_disk)

    response = client.get(url_for('download_file', file_id=file_id))
    assert response.status_code == 200
    assert response.data == file_content
    assert response.headers['Content-Disposition'] == f'attachment; filename={file_name}'

    updated_file_info = files_table.get(File.id == file_id)
    assert updated_file_info is not None
    assert updated_file_info['downloaded_at'] is not None
    assert not os.path.exists(actual_file_path_on_disk)

def test_download_file_not_found(client):
    login_user(client, 'testuser', 'password')
    response = client.get(url_for('download_file', file_id='nonexistentid'), follow_redirects=True)
    assert b'File not found' in response.data
    assert url_for('index') in response.request.path

def test_download_file_already_downloaded(client, app, files_table):
    login_user(client, 'testuser', 'password')

    file_content = b"Already downloaded."
    file_name = "download_once.txt"
    client.post(url_for('upload_file'), data={'file': (io.BytesIO(file_content), file_name)}, content_type='multipart/form-data')
    File = Query()
    file_info = files_table.get(File.original_name == file_name)
    file_id = file_info['id']
    client.get(url_for('download_file', file_id=file_id))

    response = client.get(url_for('download_file', file_id=file_id), follow_redirects=True)
    assert b'This file has already been downloaded' in response.data
    assert url_for('index') in response.request.path

def test_view_file_success(client, app, files_table):
    login_user(client, 'testuser', 'password')

    file_name = "view_me.txt"
    client.post(url_for('upload_file'), data={'file': (io.BytesIO(b"view content"), file_name)}, content_type='multipart/form-data')
    File = Query()
    file_info = files_table.get(File.original_name == file_name)
    assert file_info is not None
    file_id = file_info['id']

    response = client.get(url_for('view_file', file_id=file_id))
    assert response.status_code == 200
    assert file_name.encode() in response.data
    assert file_id.encode() in response.data

def test_view_file_not_found_or_downloaded(client):
    response = client.get(url_for('view_file', file_id='nonexistentid'), follow_redirects=True)
    assert b'File not found' in response.data
    assert url_for('index') in response.request.path


def test_delete_file_requires_login(client):
    response = client.post(url_for('delete_file', file_id='someid'), follow_redirects=True)
    assert url_for('login') in response.request.path
    assert b'Please log in to access this page' in response.data


def test_delete_file_before_download(client, app, files_table):
    login_user(client, 'testuser', 'password')

    file_id = upload_file_for_user(client, app, files_table, 'del.txt', 'hi', 'testuser')
    File = Query()
    file_info = files_table.get(File.id == file_id)
    file_path = file_info['path']
    assert os.path.exists(file_path)

    response = client.post(url_for('delete_file', file_id=file_id), follow_redirects=True)
    assert response.status_code == 200
    assert b'File deleted successfully' in response.data
    assert files_table.get(File.id == file_id) is None
    assert not os.path.exists(file_path)


def test_delete_file_after_download(client, app, files_table):
    login_user(client, 'testuser', 'password')

    file_id = upload_file_for_user(client, app, files_table, 'del_after.txt', 'content', 'testuser')
    download_response = client.get(url_for('download_file', file_id=file_id))
    assert download_response.status_code == 200
    _ = download_response.data

    File = Query()
    file_info = files_table.get(File.id == file_id)
    file_path = file_info['path']
    assert not os.path.exists(file_path)

    response = client.post(url_for('delete_file', file_id=file_id), follow_redirects=True)
    assert response.status_code == 200
    assert b'File deleted successfully' in response.data
    assert files_table.get(File.id == file_id) is None


def test_view_file_expired(client, app, files_table):
    login_user(client, 'testuser', 'password')

    expiry = (datetime.now() - timedelta(minutes=1)).strftime('%Y-%m-%dT%H:%M')
    file_data = {
        'file': (io.BytesIO(b'expired'), 'exp.txt'),
        'expiry': expiry
    }
    client.post(url_for('upload_file'), data=file_data, content_type='multipart/form-data')

    File = Query()
    file_info = files_table.get(File.original_name == 'exp.txt')
    file_id = file_info['id']

    response = client.get(url_for('view_file', file_id=file_id), follow_redirects=True)
    assert b'File has expired' in response.data
    updated = files_table.get(File.id == file_id)
    assert updated['status'] == 'expired'
    assert not os.path.exists(updated['path'])
