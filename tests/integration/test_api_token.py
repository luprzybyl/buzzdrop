"""Integration tests for API token authentication and the /api/token endpoint."""
import io
import os
import pytest


@pytest.fixture
def admin_client(client):
    """A test client logged in as admin."""
    client.post('/login', data={'username': 'adminuser', 'password': 'adminpass'})
    return client


@pytest.fixture
def user_client(client):
    """A test client logged in as a regular user."""
    client.post('/login', data={'username': 'testuser', 'password': 'password'})
    return client


# ---------------------------------------------------------------------------
# Token creation
# ---------------------------------------------------------------------------

def test_create_token_unauthenticated(client):
    resp = client.post('/api/token', json={'username': 'testuser'})
    assert resp.status_code in (302, 401)


def test_create_token_for_self(user_client):
    """Regular users can generate a token for themselves."""
    resp = user_client.post('/api/token', json={'username': 'testuser'})
    assert resp.status_code == 201
    data = resp.get_json()
    assert 'token' in data
    assert len(data['token']) == 64


def test_create_token_for_self_no_username(user_client):
    """Omitting username defaults to the logged-in user."""
    resp = user_client.post('/api/token', json={})
    assert resp.status_code == 201
    assert len(resp.get_json()['token']) == 64


def test_create_token_for_other_user_forbidden(user_client):
    """Non-admin cannot generate a token for a different user."""
    resp = user_client.post('/api/token', json={'username': 'adminuser'})
    assert resp.status_code == 403


def test_admin_can_create_token_for_any_user(admin_client):
    """Admins can generate a token for any existing user."""
    resp = admin_client.post('/api/token', json={'username': 'testuser'})
    assert resp.status_code == 201
    assert len(resp.get_json()['token']) == 64


def test_create_token_unknown_user(admin_client):
    resp = admin_client.post('/api/token', json={'username': 'nobody'})
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# Upload with Bearer token
# ---------------------------------------------------------------------------

def _make_fake_upload():
    """Return a BytesIO with minimal bytes in the expected upload format."""
    import io
    salt = os.urandom(16)
    iv = os.urandom(12)
    # Fake ciphertext: 8 bytes header + 1 byte data + 16 byte GCM tag
    fake_ciphertext = b'\x00' * 25
    return io.BytesIO(salt + iv + fake_ciphertext)


def test_upload_with_valid_token(app, client, db_instance):
    with app.app_context():
        from tokens import generate_api_token
        token = generate_api_token('testuser')

    resp = client.post(
        '/upload',
        data={'file': (_make_fake_upload(), 'test.pdf')},
        headers={
            'Authorization': f'Bearer {token}',
            'X-Requested-With': 'XMLHttpRequest',
        },
        content_type='multipart/form-data',
    )
    assert resp.status_code == 200
    body = resp.get_json()
    assert 'file_id' in body
    assert 'share_link' in body


def test_upload_with_invalid_token(client):
    import io
    resp = client.post(
        '/upload',
        data={'file': (io.BytesIO(b'\x00' * 44), 'test.pdf')},
        headers={
            'Authorization': 'Bearer ' + '0' * 64,
            'X-Requested-With': 'XMLHttpRequest',
        },
        content_type='multipart/form-data',
    )
    assert resp.status_code == 401
    assert resp.get_json()['error'] == 'Invalid or expired token'


def test_upload_with_session_still_works(user_client, db_instance):
    """Existing web-UI session auth must remain functional."""
    import io, os
    resp = user_client.post(
        '/upload',
        data={'file': (io.BytesIO(os.urandom(44)), 'test.pdf')},
        headers={'X-Requested-With': 'XMLHttpRequest'},
        content_type='multipart/form-data',
    )
    assert resp.status_code == 200
    assert 'file_id' in resp.get_json()


def test_upload_token_sets_uploaded_by(app, client, db_instance):
    """Files uploaded via token should be attributed to the token's owner."""
    with app.app_context():
        from tokens import generate_api_token
        token = generate_api_token('testuser')

    import io, os
    resp = client.post(
        '/upload',
        data={'file': (io.BytesIO(os.urandom(44)), 'myfile.txt')},
        headers={
            'Authorization': f'Bearer {token}',
            'X-Requested-With': 'XMLHttpRequest',
        },
        content_type='multipart/form-data',
    )
    assert resp.status_code == 200
    file_id = resp.get_json()['file_id']
    with app.app_context():
        from models import FileRepository
        repo = FileRepository()
        entry = repo.get_by_id(file_id)
    assert entry['uploaded_by'] == 'testuser'
