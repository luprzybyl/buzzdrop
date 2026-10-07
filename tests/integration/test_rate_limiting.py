import io

import pytest
from flask import url_for


def login_user(client, username, password):
    response = client.post(url_for('login'), data={'username': username, 'password': password}, follow_redirects=True)
    with client.session_transaction() as session:
        session['csrf_token'] = 'test-csrf-token'
    return response


@pytest.fixture
def restore_rate_limits(app):
    keys = (
        'LOGIN_RATE_LIMIT',
        'API_TOKEN_RATE_LIMIT',
        'UPLOAD_RATE_LIMIT',
        'PUBLIC_FILE_RATE_LIMIT',
        'REPORT_DECRYPTION_RATE_LIMIT',
    )
    original = {key: app.config[key] for key in keys}
    yield
    app.config.update(original)


def test_login_rate_limit_blocks_repeated_attempts(client, app, restore_rate_limits):
    app.config['LOGIN_RATE_LIMIT'] = '1 per minute'

    first = client.post(url_for('login'), data={'username': 'testuser', 'password': 'wrongpassword'})
    assert first.status_code == 200
    assert b'Invalid username or password' in first.data

    second = client.post(url_for('login'), data={'username': 'testuser', 'password': 'wrongpassword'})
    assert second.status_code == 429
    assert b'Too many requests. Please try again later.' in second.data


def test_login_rate_limit_ignores_x_forwarded_for_spoofing(client, app, restore_rate_limits):
    app.config['LOGIN_RATE_LIMIT'] = '1 per minute'
    environ_overrides = {'REMOTE_ADDR': '203.0.113.5'}

    first = client.post(
        url_for('login'),
        data={'username': 'testuser', 'password': 'wrongpassword'},
        headers={'X-Forwarded-For': '198.51.100.10'},
        environ_overrides=environ_overrides,
    )
    assert first.status_code == 200
    assert b'Invalid username or password' in first.data

    second = client.post(
        url_for('login'),
        data={'username': 'testuser', 'password': 'wrongpassword'},
        headers={'X-Forwarded-For': '198.51.100.11'},
        environ_overrides=environ_overrides,
    )
    assert second.status_code == 429
    assert b'Too many requests. Please try again later.' in second.data


def test_api_token_rate_limit_returns_json(client, app, restore_rate_limits):
    app.config['API_TOKEN_RATE_LIMIT'] = '1 per minute'
    login_user(client, 'testuser', 'password')

    first = client.post(
        url_for('create_api_token'), json={'csrf_token': 'test-csrf-token'})
    assert first.status_code == 201
    assert 'token' in first.get_json()

    second = client.post(
        url_for('create_api_token'), json={'csrf_token': 'test-csrf-token'})
    assert second.status_code == 429
    assert second.get_json()['error'] == 'Too many requests. Please try again later.'


def test_upload_rate_limit_returns_json(client, app, files_store, key_share, restore_rate_limits):
    app.config['UPLOAD_RATE_LIMIT'] = '1 per minute'
    login_user(client, 'testuser', 'password')

    def _post_key_release_upload(name):
        file_id, _h = key_share()
        return client.post(
            url_for('upload_file'),
            data={
                'file': (io.BytesIO(b'x'), name),
                'file_id': file_id,
                'key_verifier': 'cc' * 32,
            'receipt_hash': 'aa' * 32,
            'csrf_token': 'test-csrf-token',
            },
            headers={'X-Requested-With': 'XMLHttpRequest',
                      'X-CSRF-Token': 'test-csrf-token'},
            content_type='multipart/form-data',
        )

    first = _post_key_release_upload('first.txt')
    assert first.status_code == 200

    second = _post_key_release_upload('second.txt')
    assert second.status_code == 429
    assert second.get_json()['error'] == 'Too many requests. Please try again later.'


def test_public_file_rate_limit_is_shared_across_view_and_download(client, app, files_store, key_share, restore_rate_limits, csrf_form_data):
    app.config['PUBLIC_FILE_RATE_LIMIT'] = '2 per minute'
    login_user(client, 'testuser', 'password')

    file_id, _h = key_share()
    upload = client.post(
        url_for('upload_file'),
        data={
            # A BKV3 envelope — confirm reads the salt out of the blob.
            'file': (io.BytesIO(b'BKV3' + b'\x00' * 28 + b'downloadable'), 'shared.txt'),
            'file_id': file_id,
            'key_verifier': 'cc' * 32,
            'receipt_hash': 'aa' * 32,
            'csrf_token': 'test-csrf-token',
        },
        content_type='multipart/form-data',
    )
    assert upload.status_code == 200

    file_info = files_store.get_by(original_name='shared.txt')
    assert file_info is not None

    first = client.get(url_for('view_file', file_id=file_info['id']))
    assert first.status_code == 200

    confirm = client.post(url_for('confirm_view_file', file_id=file_info['id']), data=csrf_form_data())
    assert confirm.status_code == 200

    second = client.get(url_for('download_file', file_id=file_info['id']))
    assert second.status_code == 429
    assert b'Too many requests. Please try again later.' in second.data


def test_report_decryption_rate_limit_is_per_file_id(client, app, restore_rate_limits):
    """The endpoint is unauthenticated (the receipt is the credential),
    so it gets the same per-file_id rate limiting as /release."""
    app.config['REPORT_DECRYPTION_RATE_LIMIT'] = '1 per minute'

    url = url_for('report_decryption', file_id='missing-id')
    first = client.post(url, json={'success': False})
    assert first.status_code == 404

    second = client.post(url, json={'success': False})
    assert second.status_code == 429
    assert b'Too many requests. Please try again later.' in second.data

    # A different file_id gets its own bucket.
    other = client.post(
        url_for('report_decryption', file_id='other-id'),
        json={'success': False})
    assert other.status_code == 404
