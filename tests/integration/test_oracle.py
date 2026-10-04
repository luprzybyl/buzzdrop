"""
Integration tests for server-gated key release (the "oracle" flow).

Covers the two-phase upload (/upload/begin + /upload carrying
oracle_file_id/key_verifier) and the one-time /release endpoint:
verifier checks, attempt counting, lockout/burn policy, and
backward compatibility with self-contained v1/v2 shares.
"""
import io
import os
from datetime import datetime, timedelta

import pytest
from flask import url_for

# Fixtures: 'app', 'client', 'db_instance', 'files_store' from conftest.py
# Test users from conftest.py: 'testuser:password:false', 'adminuser:adminpass:true'


def login_user(client, username='testuser', password='password'):
    return client.post(
        url_for('login'),
        data={'username': username, 'password': password},
        follow_redirects=True,
    )


@pytest.fixture
def oracle_settings(app):
    """Mutate oracle-related config and restore it afterwards."""
    keys = (
        'ORACLE_ENABLED',
        'ORACLE_RELEASE_RATE_LIMIT',
        'ORACLE_MAX_RELEASE_ATTEMPTS',
        'ORACLE_BURN_ON_LOCKOUT',
    )
    original = {key: app.config.get(key) for key in keys}
    yield app.config
    app.config.update(original)


def _create_file_record(files_store, file_id='file-1', **overrides):
    doc = {
        'id': file_id,
        'original_name': 'secret.txt',
        'path': f'nonexistent/{file_id}',
        'created_at': datetime.now().isoformat(),
        'downloaded_at': None,
        'uploaded_by': 'testuser',
        'expiry_at': None,
        'status': 'active',
        'type': 'file',
    }
    doc.update(overrides)
    files_store.insert(doc)
    return file_id


def _bound_share(files_store, file_id='file-1', h='aa' * 32, v='bb' * 32):
    """Persist a complete oracle share + file record, return (file_id, h, v)."""
    _create_file_record(files_store, file_id=file_id)
    files_store.create_key_share(file_id, h)
    files_store.bind_key_verifier(file_id, v)
    return file_id, h, v


def _oracle_upload(client, filename='oracle.txt', content=b'encrypted blob'):
    """Drive the full two-phase upload; returns (file_id, h, upload_response)."""
    begin = client.post(
        url_for('upload_begin'),
        headers={'X-Requested-With': 'XMLHttpRequest'},
    )
    assert begin.status_code == 200
    file_id = begin.get_json()['file_id']
    h = begin.get_json()['h']

    finish = client.post(
        url_for('upload_file'),
        data={
            'file': (io.BytesIO(content), filename),
            'oracle_file_id': file_id,
            'key_verifier': 'cc' * 32,
        },
        content_type='multipart/form-data',
        headers={'X-Requested-With': 'XMLHttpRequest'},
    )
    return file_id, h, finish


# ---------------------------------------------------------------------------
# /upload/begin
# ---------------------------------------------------------------------------

def test_upload_begin_requires_auth(client):
    response = client.post(url_for('upload_begin'), follow_redirects=True)
    assert url_for('login') in response.request.path


def test_upload_begin_returns_pending_share(client, files_store):
    login_user(client)
    response = client.post(
        url_for('upload_begin'),
        headers={'X-Requested-With': 'XMLHttpRequest'},
    )
    assert response.status_code == 200
    body = response.get_json()
    assert body['file_id']
    assert len(body['h']) == 64

    share = files_store.get_key_share(body['file_id'])
    assert share['h'] == body['h']
    assert share['v'] is None
    assert share['released_at'] is None
    # No files row yet — the record is created by the finish call.
    assert files_store.get_by_id(body['file_id']) is None


def test_upload_begin_disabled(client, oracle_settings):
    oracle_settings['ORACLE_ENABLED'] = False
    login_user(client)
    response = client.post(
        url_for('upload_begin'),
        headers={'X-Requested-With': 'XMLHttpRequest'},
    )
    assert response.status_code == 404


# ---------------------------------------------------------------------------
# /upload finish (oracle fields)
# ---------------------------------------------------------------------------

def test_oracle_upload_binds_verifier(client, files_store):
    login_user(client)
    file_id, _h, finish = _oracle_upload(client)
    assert finish.status_code == 200
    assert finish.get_json()['file_id'] == file_id

    share = files_store.get_key_share(file_id)
    assert share['v'] == 'cc' * 32
    file_info = files_store.get_by_id(file_id)
    assert file_info is not None
    assert file_info['uploaded_by'] == 'testuser'


def test_oracle_upload_rejects_unknown_share(client, files_store):
    login_user(client)
    response = client.post(
        url_for('upload_file'),
        data={
            'file': (io.BytesIO(b'blob'), 'x.txt'),
            'oracle_file_id': 'does-not-exist',
            'key_verifier': 'cc' * 32,
        },
        content_type='multipart/form-data',
        headers={'X-Requested-With': 'XMLHttpRequest'},
    )
    assert response.status_code == 409


def test_oracle_upload_rejects_finalized_share(client, files_store):
    login_user(client)
    file_id, _h, finish = _oracle_upload(client)
    assert finish.status_code == 200

    second = client.post(
        url_for('upload_file'),
        data={
            'file': (io.BytesIO(b'blob2'), 'y.txt'),
            'oracle_file_id': file_id,
            'key_verifier': 'dd' * 32,
        },
        content_type='multipart/form-data',
        headers={'X-Requested-With': 'XMLHttpRequest'},
    )
    assert second.status_code == 409


def test_oracle_upload_rejects_partial_handshake(client):
    login_user(client)
    for data in (
        {'file': (io.BytesIO(b'b'), 'x.txt'), 'oracle_file_id': 'abc'},
        {'file': (io.BytesIO(b'b'), 'x.txt'), 'key_verifier': 'cc' * 32},
        {'file': (io.BytesIO(b'b'), 'x.txt'),
         'oracle_file_id': 'abc', 'key_verifier': 'not-hex'},
    ):
        response = client.post(
            url_for('upload_file'),
            data=data,
            content_type='multipart/form-data',
            headers={'X-Requested-With': 'XMLHttpRequest'},
        )
        assert response.status_code == 400


def test_oracle_upload_rejected_when_disabled(client, files_store, oracle_settings):
    """A share created while enabled cannot be finished after opt-out."""
    login_user(client)
    begin = client.post(
        url_for('upload_begin'),
        headers={'X-Requested-With': 'XMLHttpRequest'},
    )
    file_id = begin.get_json()['file_id']

    oracle_settings['ORACLE_ENABLED'] = False
    finish = client.post(
        url_for('upload_file'),
        data={
            'file': (io.BytesIO(b'blob'), 'x.txt'),
            'oracle_file_id': file_id,
            'key_verifier': 'cc' * 32,
        },
        content_type='multipart/form-data',
        headers={'X-Requested-With': 'XMLHttpRequest'},
    )
    assert finish.status_code == 409


def test_legacy_upload_still_works(client, files_store):
    """Plain uploads without oracle fields are untouched (v1/v2 path)."""
    login_user(client)
    response = client.post(
        url_for('upload_file'),
        data={'file': (io.BytesIO(b'plain blob'), 'legacy.txt')},
        content_type='multipart/form-data',
        headers={'X-Requested-With': 'XMLHttpRequest'},
    )
    assert response.status_code == 200
    file_info = files_store.get_by(original_name='legacy.txt')
    assert file_info is not None
    assert files_store.get_key_share(file_info['id']) is None


# ---------------------------------------------------------------------------
# /release
# ---------------------------------------------------------------------------

def test_release_returns_h_once(client, files_store):
    file_id, h, v = _bound_share(files_store)

    first = client.post(url_for('release_key', file_id=file_id), json={'v': v})
    assert first.status_code == 200
    assert first.get_json()['h'] == h

    second = client.post(url_for('release_key', file_id=file_id), json={'v': v})
    assert second.status_code == 410


def test_release_wrong_verifier_counts_attempts(client, files_store):
    file_id, _h, _v = _bound_share(files_store)

    response = client.post(
        url_for('release_key', file_id=file_id), json={'v': 'dd' * 32})
    assert response.status_code == 403
    assert response.get_json()['attempts_remaining'] == 4
    assert files_store.get_key_share(file_id)['attempts'] == 1
    assert files_store.get_key_share(file_id)['released_at'] is None


def test_release_lockout_after_max_attempts(client, files_store, oracle_settings):
    oracle_settings['ORACLE_MAX_RELEASE_ATTEMPTS'] = 2
    file_id, _h, _v = _bound_share(files_store)

    for expected_status in (403, 429):
        response = client.post(
            url_for('release_key', file_id=file_id), json={'v': 'dd' * 32})
        assert response.status_code == expected_status

    locked = client.post(
        url_for('release_key', file_id=file_id), json={'v': 'dd' * 32})
    assert locked.status_code == 429
    # Even the correct verifier is refused after lockout.
    correct = client.post(
        url_for('release_key', file_id=file_id), json={'v': 'bb' * 32})
    assert correct.status_code == 429
    # Lockout without burn keeps H — availability lost, not the share row.
    assert files_store.get_key_share(file_id) is not None


def test_release_burn_on_lockout(client, files_store, oracle_settings):
    oracle_settings['ORACLE_MAX_RELEASE_ATTEMPTS'] = 1
    oracle_settings['ORACLE_BURN_ON_LOCKOUT'] = True
    file_id, _h, _v = _bound_share(files_store)

    miss = client.post(
        url_for('release_key', file_id=file_id), json={'v': 'dd' * 32})
    assert miss.status_code == 429
    # Burned: H is gone for good, the ciphertext is mathematically dead.
    assert files_store.get_key_share(file_id) is None
    follow_up = client.post(
        url_for('release_key', file_id=file_id), json={'v': 'bb' * 32})
    assert follow_up.status_code == 404


def test_release_on_legacy_share_is_404(client, files_store):
    """v1/v2 blobs have no key share — the oracle does not apply."""
    _create_file_record(files_store, file_id='legacy-1')
    response = client.post(
        url_for('release_key', file_id='legacy-1'), json={'v': 'bb' * 32})
    assert response.status_code == 404


def test_release_on_pending_share_is_404(client, files_store):
    """begin without finish leaves an unbound share — nothing to release."""
    _create_file_record(files_store, file_id='pending-1')
    files_store.create_key_share('pending-1', 'aa' * 32)
    response = client.post(
        url_for('release_key', file_id='pending-1'), json={'v': 'bb' * 32})
    assert response.status_code == 404


def test_release_missing_file_is_404(client):
    response = client.post(
        url_for('release_key', file_id='ghost'), json={'v': 'bb' * 32})
    assert response.status_code == 404


@pytest.mark.parametrize('body', [
    {},
    {'v': 'short'},
    {'v': 'zz' * 32},
    {'v': 123},
    {'v': None},
])
def test_release_requires_valid_verifier(client, files_store, body):
    _bound_share(files_store, file_id='fmt-1')
    response = client.post(
        url_for('release_key', file_id='fmt-1'), json=body)
    assert response.status_code == 400
    # Malformed attempts must not drain the counter.
    assert files_store.get_key_share('fmt-1')['attempts'] == 0


def test_release_expired_file_is_410(client, files_store):
    past = (datetime.now() - timedelta(minutes=5)).isoformat()
    _bound_share(files_store, file_id='exp-1', v='bb' * 32)
    files_store.update_fields('exp-1', {'expiry_at': past})

    response = client.post(
        url_for('release_key', file_id='exp-1'), json={'v': 'bb' * 32})
    assert response.status_code == 410
    assert files_store.get_by_id('exp-1')['status'] == 'expired'


def test_release_works_after_blob_download(client, files_store, app):
    """The real order: blob first (claims download), then /release."""
    login_user(client)
    file_id, h, finish = _oracle_upload(client, content=b'real blob')
    assert finish.status_code == 200
    v = 'cc' * 32

    # download claims + serves the blob; release must still work
    download = client.get(url_for('download_file', file_id=file_id))
    assert download.status_code == 200
    assert download.data == b'real blob'

    release = client.post(
        url_for('release_key', file_id=file_id), json={'v': v})
    assert release.status_code == 200
    assert release.get_json()['h'] == h


def test_delete_file_drops_key_share(client, files_store, csrf_form_data):
    login_user(client)
    file_id, _h, finish = _oracle_upload(client)
    assert finish.status_code == 200

    response = client.post(
        url_for('delete_file', file_id=file_id),
        data=csrf_form_data(),
        follow_redirects=True,
    )
    assert response.status_code == 200
    assert files_store.get_key_share(file_id) is None


# ---------------------------------------------------------------------------
# End-to-end v3 crypto through the real routes
# ---------------------------------------------------------------------------

def _import_buzz():
    """Import cli/buzz as a module (file has no .py extension)."""
    import importlib.util
    import importlib.machinery
    buzz_path = os.path.abspath(
        os.path.join(os.path.dirname(__file__), '..', '..', 'cli', 'buzz')
    )
    loader = importlib.machinery.SourceFileLoader('buzz', buzz_path)
    spec = importlib.util.spec_from_loader('buzz', loader)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


try:
    import cryptography  # noqa: F401
    _crypto_available = True
except ImportError:
    _crypto_available = False


@pytest.mark.skipif(not _crypto_available, reason='cryptography not installed')
def test_oracle_end_to_end(client, files_store):
    """Full vertical slice: begin → v3 encrypt → finish → download →
    release → decrypt. Proves the CLI crypto and the server handshake
    agree byte-for-byte."""
    buzz = _import_buzz()
    login_user(client)

    password = 'end-to-end-password'
    plaintext = b'true one-time payload'

    begin = client.post(
        url_for('upload_begin'),
        headers={'X-Requested-With': 'XMLHttpRequest'},
    )
    file_id = begin.get_json()['file_id']
    h = bytes.fromhex(begin.get_json()['h'])

    blob, v_hex = buzz.encrypt_file_v3(plaintext, password, h)
    assert blob.startswith(b'BKV3')

    finish = client.post(
        url_for('upload_file'),
        data={
            'file': (io.BytesIO(blob), 'e2e.txt'),
            'oracle_file_id': file_id,
            'key_verifier': v_hex,
        },
        content_type='multipart/form-data',
        headers={'X-Requested-With': 'XMLHttpRequest'},
    )
    assert finish.status_code == 200

    # Wrong password first: verifier miss, no H, attempt counted.
    salt = blob[4:20]
    _kp, wrong_v = buzz.derive_oracle_keys('wrong-password', salt)
    miss = client.post(
        url_for('release_key', file_id=file_id),
        json={'v': wrong_v.hex()},
    )
    assert miss.status_code == 403

    download = client.get(url_for('download_file', file_id=file_id))
    assert download.status_code == 200
    served = download.data

    release = client.post(
        url_for('release_key', file_id=file_id), json={'v': v_hex})
    assert release.status_code == 200
    released_h = bytes.fromhex(release.get_json()['h'])
    assert released_h == h

    assert buzz.decrypt_file(served, password, h=released_h) == plaintext

    # H is single-use: the share is burned after release.
    again = client.post(
        url_for('release_key', file_id=file_id), json={'v': v_hex})
    assert again.status_code == 410
