import base64
from flask import url_for
from tinydb import Query

def login_user(client, username, password):
    """Helper function to log in a user."""
    return client.post(url_for('login'), data={'username': username, 'password': password}, follow_redirects=True)

def test_upload_text_note_requires_login(client):
    """Test that uploading a text note requires authentication."""
    # Mock encrypted text data (base64 encoded)
    mock_encrypted = base64.b64encode(b"mock encrypted data").decode('utf-8')
    data = {
        'note_text': mock_encrypted,
        'type': 'text'
    }
    response = client.post(url_for('upload_file'), data=data, follow_redirects=False)
    assert response.status_code == 302  # Redirect to login
    assert b'/login' in response.data or response.location.endswith('/login')

def test_upload_text_note_success(client, app, files_table):
    """Test successful text note upload."""
    login_user(client, 'testuser', 'password')

    # Simulate encrypted text (base64 encoded)
    test_text = b"This is a secret text note"
    mock_encrypted = base64.b64encode(test_text).decode('utf-8')

    data = {
        'note_text': mock_encrypted,
        'type': 'text'
    }

    response = client.post(
        url_for('upload_file'),
        data=data,
        follow_redirects=False,
        headers={'X-Requested-With': 'XMLHttpRequest'}
    )

    assert response.status_code == 200
    json_data = response.get_json()
    assert 'file_id' in json_data
    assert 'share_link' in json_data
    assert json_data['type'] == 'text'

    # Verify database entry
    File = Query()
    note_info = files_table.get(File.id == json_data['file_id'])
    assert note_info is not None
    assert note_info['type'] == 'text'
    assert note_info['original_name'] == 'Secret Note'
    assert note_info['uploaded_by'] == 'testuser'
    assert note_info['status'] == 'active'

def test_upload_text_note_with_expiry(client, app, files_table):
    """Test text note upload with expiry date."""
    login_user(client, 'testuser', 'password')

    mock_encrypted = base64.b64encode(b"Expiring note").decode('utf-8')
    expiry_date = '2025-12-31T23:59'

    data = {
        'note_text': mock_encrypted,
        'type': 'text',
        'expiry': expiry_date
    }

    response = client.post(
        url_for('upload_file'),
        data=data,
        follow_redirects=False,
        headers={'X-Requested-With': 'XMLHttpRequest'}
    )

    assert response.status_code == 200
    json_data = response.get_json()

    File = Query()
    note_info = files_table.get(File.id == json_data['file_id'])
    assert note_info is not None
    assert note_info['expiry_at'] is not None
    assert '2025-12-31' in note_info['expiry_at']

def test_view_text_note_shows_correct_template(client, app, files_table):
    """Test that viewing a text note shows the correct template with text type."""
    login_user(client, 'testuser', 'password')

    # Upload a text note first
    mock_encrypted = base64.b64encode(b"Test note").decode('utf-8')
    response = client.post(
        url_for('upload_file'),
        data={'note_text': mock_encrypted, 'type': 'text'},
        headers={'X-Requested-With': 'XMLHttpRequest'}
    )
    note_id = response.get_json()['file_id']

    # View the note (confirm page)
    response = client.get(url_for('view_file', file_id=note_id))
    assert response.status_code == 200
    assert b'Secret Note' in response.data
    assert b'Ready to View?' in response.data
    assert b'Viewing will immediately delete this note' in response.data

def test_confirm_view_text_note(client, app, files_table):
    """Test the confirm view page for text notes."""
    login_user(client, 'testuser', 'password')

    # Upload a text note first
    mock_encrypted = base64.b64encode(b"Test note").decode('utf-8')
    response = client.post(
        url_for('upload_file'),
        data={'note_text': mock_encrypted, 'type': 'text'},
        headers={'X-Requested-With': 'XMLHttpRequest'}
    )
    note_id = response.get_json()['file_id']

    # Confirm view
    response = client.post(url_for('confirm_view_file', file_id=note_id))
    assert response.status_code == 200
    assert b'Decrypt and View' in response.data
    assert b'window.fileType = "text"' in response.data
    assert b'text-display' in response.data  # Text display div should be present

def test_text_note_type_field_in_database(client, app, files_table):
    """Test that text notes have correct type field in database."""
    login_user(client, 'testuser', 'password')

    # Upload text note
    mock_encrypted = base64.b64encode(b"Test note").decode('utf-8')
    response = client.post(
        url_for('upload_file'),
        data={'note_text': mock_encrypted, 'type': 'text'},
        headers={'X-Requested-With': 'XMLHttpRequest'}
    )
    note_id = response.get_json()['file_id']

    # Check database
    File = Query()
    note_info = files_table.get(File.id == note_id)
    assert note_info['type'] == 'text'

    # Compare with regular file upload
    import io
    file_response = client.post(
        url_for('upload_file'),
        data={'file': (io.BytesIO(b"test content"), "test.txt")},
        content_type='multipart/form-data',
        follow_redirects=False
    )
    # Extract file_id from response
    assert file_response.status_code == 200

    # Get the most recent file that's not the note
    all_files = files_table.all()
    file_upload = [f for f in all_files if f['id'] != note_id][0]
    assert file_upload['type'] == 'file'

def test_text_note_success_page(client, app):
    """Test that success page shows correct message for text notes."""
    login_user(client, 'testuser', 'password')

    mock_encrypted = base64.b64encode(b"Test note").decode('utf-8')

    # Post without AJAX to get HTML response
    response = client.post(
        url_for('upload_file'),
        data={'note_text': mock_encrypted, 'type': 'text'},
        follow_redirects=False
    )

    assert response.status_code == 200
    assert b'Text Note Shared Successfully!' in response.data
    assert b'The note will be deleted after the first view' in response.data

def test_text_note_deletion_after_view(client, app, files_table):
    """Test that text note is marked as downloaded after viewing."""
    login_user(client, 'testuser', 'password')

    # Upload text note
    mock_encrypted = base64.b64encode(b"Test note").decode('utf-8')
    response = client.post(
        url_for('upload_file'),
        data={'note_text': mock_encrypted, 'type': 'text'},
        headers={'X-Requested-With': 'XMLHttpRequest'}
    )
    note_id = response.get_json()['file_id']

    # Download the note
    response = client.get(url_for('download_file', file_id=note_id))
    assert response.status_code == 200

    # Verify it's marked as downloaded
    File = Query()
    note_info = files_table.get(File.id == note_id)
    assert note_info['downloaded_at'] is not None

    # Try to view again - should fail
    response = client.get(url_for('view_file', file_id=note_id), follow_redirects=False)
    assert response.status_code == 302  # Redirect because already downloaded

def test_delete_text_note_before_view(client, app, files_table):
    """Test manual deletion of text note before it's viewed."""
    login_user(client, 'testuser', 'password')

    # Upload text note
    mock_encrypted = base64.b64encode(b"Test note").decode('utf-8')
    response = client.post(
        url_for('upload_file'),
        data={'note_text': mock_encrypted, 'type': 'text'},
        headers={'X-Requested-With': 'XMLHttpRequest'}
    )
    note_id = response.get_json()['file_id']

    # Delete the note
    response = client.post(url_for('delete_file', file_id=note_id), follow_redirects=True)
    assert response.status_code == 200

    # Verify it's removed from database
    File = Query()
    note_info = files_table.get(File.id == note_id)
    assert note_info is None

def test_text_note_empty_content(client, app):
    """Test that empty text note is rejected."""
    login_user(client, 'testuser', 'password')

    # Try to upload empty note
    data = {
        'note_text': '',
        'type': 'text'
    }

    response = client.post(
        url_for('upload_file'),
        data=data,
        follow_redirects=False
    )

    # Should redirect back to index or show error
    # Since note_text is empty, the backend will skip text note handling
    # and fall through to file upload logic which will fail
    assert response.status_code in [302, 400]

def test_report_decryption_for_text_note(client, app, files_table):
    """Test reporting decryption success for text notes."""
    login_user(client, 'testuser', 'password')

    # Upload text note
    mock_encrypted = base64.b64encode(b"Test note").decode('utf-8')
    response = client.post(
        url_for('upload_file'),
        data={'note_text': mock_encrypted, 'type': 'text'},
        headers={'X-Requested-With': 'XMLHttpRequest'}
    )
    note_id = response.get_json()['file_id']

    # Report decryption success
    response = client.post(
        url_for('report_decryption', file_id=note_id),
        json={'success': True}
    )
    assert response.status_code == 200

    # Verify in database
    File = Query()
    note_info = files_table.get(File.id == note_id)
    assert note_info['decryption_success'] is True
