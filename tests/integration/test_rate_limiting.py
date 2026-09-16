import io

import pytest
from flask import url_for
from tinydb import Query


def login_user(client, username, password):
    return client.post(url_for('login'), data={'username': username, 'password': password}, follow_redirects=True)


@pytest.fixture
def restore_rate_limits(app):
    keys = (
        'LOGIN_RATE_LIMIT',
        'API_TOKEN_RATE_LIMIT',
        'UPLOAD_RATE_LIMIT',
        'PUBLIC_FILE_RATE_LIMIT',
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

    first = client.post(url_for('create_api_token'), json={})
    assert first.status_code == 201
    assert 'token' in first.get_json()

    second = client.post(url_for('create_api_token'), json={})
    assert second.status_code == 429
    assert second.get_json()['error'] == 'Too many requests. Please try again later.'


def test_upload_rate_limit_returns_json(client, app, restore_rate_limits):
    app.config['UPLOAD_RATE_LIMIT'] = '1 per minute'
    login_user(client, 'testuser', 'password')

    first = client.post(
        url_for('upload_file'),
        data={'file': (io.BytesIO(b'first upload'), 'first.txt')},
        headers={'X-Requested-With': 'XMLHttpRequest'},
        content_type='multipart/form-data',
    )
    assert first.status_code == 200

    second = client.post(
        url_for('upload_file'),
        data={'file': (io.BytesIO(b'second upload'), 'second.txt')},
        headers={'X-Requested-With': 'XMLHttpRequest'},
        content_type='multipart/form-data',
    )
    assert second.status_code == 429
    assert second.get_json()['error'] == 'Too many requests. Please try again later.'


def test_public_file_rate_limit_is_shared_across_view_and_download(client, app, files_table, restore_rate_limits):
    app.config['PUBLIC_FILE_RATE_LIMIT'] = '2 per minute'
    login_user(client, 'testuser', 'password')

    upload = client.post(
        url_for('upload_file'),
        data={'file': (io.BytesIO(b'downloadable content'), 'shared.txt')},
        content_type='multipart/form-data',
    )
    assert upload.status_code == 200

    file_info = files_table.get(Query().original_name == 'shared.txt')
    assert file_info is not None

    first = client.get(url_for('view_file', file_id=file_info['id']))
    assert first.status_code == 200

    confirm = client.post(url_for('confirm_view_file', file_id=file_info['id']))
    assert confirm.status_code == 200

    second = client.get(url_for('download_file', file_id=file_info['id']))
    assert second.status_code == 429
    assert b'Too many requests. Please try again later.' in second.data
