"""Integration tests for API token authentication and the /api/token endpoint."""
import io
import os
import pytest


def _csrf_headers(client):
    with client.session_transaction() as session:
        csrf_token = session['csrf_token']
    return {
        'X-Requested-With': 'XMLHttpRequest',
        'X-CSRF-Token': csrf_token,
    }


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


@pytest.fixture
def clear_user_cache(monkeypatch):
    from auth import get_users
    get_users.cache_clear()
    yield
    monkeypatch.undo()
    get_users.cache_clear()


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
    assert 'expires_at' in data
    assert len(data['token']) == 64


def test_create_token_for_self_no_username(user_client):
    """Omitting username defaults to the logged-in user."""
    resp = user_client.post('/api/token', json={})
    assert resp.status_code == 201
    assert len(resp.get_json()['token']) == 64
    assert 'expires_at' in resp.get_json()


def test_create_token_for_other_user_forbidden(user_client):
    """Non-admin cannot generate a token for a different user."""
    resp = user_client.post('/api/token', json={'username': 'adminuser'})
    assert resp.status_code == 403


def test_admin_can_create_token_for_any_user(admin_client):
    """Admins can generate a token for any existing user."""
    resp = admin_client.post('/api/token', json={'username': 'testuser'})
    assert resp.status_code == 201
    assert len(resp.get_json()['token']) == 64
    assert 'expires_at' in resp.get_json()


def test_create_token_unknown_user(admin_client):
    resp = admin_client.post('/api/token', json={'username': 'nobody'})
    assert resp.status_code == 404


def test_create_token_rejects_invalid_expiry(user_client):
    resp = user_client.post('/api/token', json={'expires_in_days': 0})
    assert resp.status_code == 400
    assert resp.get_json()['error'] == 'expires_in_days must be a positive integer'


@pytest.mark.parametrize('expires_in_days', [1.5, True, float('inf')])
def test_create_token_rejects_non_integer_expiry_values(user_client, expires_in_days):
    resp = user_client.post('/api/token', json={'expires_in_days': expires_in_days})
    assert resp.status_code == 400
    assert resp.get_json()['error'] == 'expires_in_days must be a positive integer'


def test_list_tokens_for_self(app, user_client, db_instance):
    with app.app_context():
        from tokens import generate_api_token
        generate_api_token('testuser')

    resp = user_client.get('/api/tokens')
    assert resp.status_code == 200
    tokens = resp.get_json()['tokens']
    assert len(tokens) == 1
    assert tokens[0]['username'] == 'testuser'
    assert tokens[0]['expires_at'] is not None


def test_user_cannot_list_other_users_tokens(app, user_client, db_instance):
    with app.app_context():
        from tokens import generate_api_token
        generate_api_token('adminuser')

    resp = user_client.get('/api/tokens?username=adminuser')
    assert resp.status_code == 403


def test_user_can_revoke_own_token(app, user_client, db_instance):
    with app.app_context():
        from app import get_db
        from tokens import generate_api_token, validate_api_token

        token = generate_api_token('testuser')
        token_entry = get_db().table('api_tokens').get(lambda item: item['username'] == 'testuser')
        token_id = token_entry.doc_id
        assert validate_api_token(token) == 'testuser'

    resp = user_client.post(
        f'/api/tokens/{token_id}/revoke',
        headers=_csrf_headers(user_client),
    )
    assert resp.status_code == 200
    assert resp.get_json()['status'] == 'revoked'

    with app.app_context():
        from tokens import validate_api_token
        assert validate_api_token(token) is None


def test_user_cannot_revoke_other_users_token(app, user_client, db_instance):
    with app.app_context():
        from app import get_db
        from tokens import generate_api_token

        generate_api_token('adminuser')
        token_entry = get_db().table('api_tokens').get(lambda item: item['username'] == 'adminuser')
        token_id = token_entry.doc_id

    resp = user_client.post(
        f'/api/tokens/{token_id}/revoke',
        headers=_csrf_headers(user_client),
    )
    assert resp.status_code == 403


def test_admin_can_revoke_other_users_token(app, admin_client, db_instance):
    with app.app_context():
        from app import get_db
        from tokens import generate_api_token, validate_api_token

        token = generate_api_token('testuser')
        token_entry = get_db().table('api_tokens').get(lambda item: item['username'] == 'testuser')
        token_id = token_entry.doc_id
        assert validate_api_token(token) == 'testuser'

    resp = admin_client.post(
        f'/api/tokens/{token_id}/revoke',
        headers=_csrf_headers(admin_client),
    )
    assert resp.status_code == 200
    assert resp.get_json()['status'] == 'revoked'

    with app.app_context():
        from tokens import list_api_tokens, validate_api_token
        assert validate_api_token(token) is None
        assert list_api_tokens('testuser') == []


def test_revoke_token_requires_csrf(app, user_client, db_instance):
    with app.app_context():
        from app import get_db
        from tokens import generate_api_token

        generate_api_token('testuser')
        token_entry = get_db().table('api_tokens').get(lambda item: item['username'] == 'testuser')
        token_id = token_entry.doc_id

    resp = user_client.post(
        f'/api/tokens/{token_id}/revoke',
        headers={'X-Requested-With': 'XMLHttpRequest'},
    )
    assert resp.status_code == 403
    assert resp.get_json()['error'] == 'CSRF validation failed'


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


def test_upload_with_removed_token_user_is_rejected(app, client, monkeypatch, clear_user_cache):
    with app.app_context():
        from tokens import generate_api_token
        token = generate_api_token('testuser')

    monkeypatch.delenv('FLASK_USER_1', raising=False)
    from auth import get_users
    get_users.cache_clear()

    resp = client.post(
        '/upload',
        data={'file': (_make_fake_upload(), 'test.pdf')},
        headers={
            'Authorization': 'Bearer ' + token,
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


def test_upload_with_removed_session_user_redirects_to_login(user_client, monkeypatch, clear_user_cache):
    monkeypatch.delenv('FLASK_USER_1', raising=False)
    from auth import get_users
    get_users.cache_clear()

    resp = user_client.post(
        '/upload',
        data={'file': (_make_fake_upload(), 'test.pdf')},
        content_type='multipart/form-data',
        follow_redirects=True,
    )

    assert resp.status_code == 200
    assert '/login' in resp.request.path
    assert b'Please log in to access this page' in resp.data
    with user_client.session_transaction() as sess:
        assert 'username' not in sess
        assert 'is_admin' not in sess


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
