"""
Integration tests for server-gated key release .

Covers the two-phase upload (/upload/begin + /upload carrying
file_id/key_verifier/receipt_hash) and the one-time /release endpoint:
verifier checks, atomic attempt counting, lockout/burn policy, owner
binding, and expiry destroying the share.
"""
import io
import os
from datetime import datetime, timedelta

import pytest
from flask import url_for

# Fixtures: 'app', 'client', 'db_instance', 'files_store' from conftest.py
# Test users from conftest.py: 'testuser:password:false', 'adminuser:adminpass:true'


def login_user(client, username='testuser', password='password'):
    response = client.post(
        url_for('login'),
        data={'username': username, 'password': password},
        follow_redirects=True,
    )
    with client.session_transaction() as session:
        session['csrf_token'] = 'test-csrf-token'
    return response


def _clear_csrf(client):
    """Remove the seeded session CSRF token — simulate a forged request."""
    with client.session_transaction() as session:
        session.pop('csrf_token', None)


@pytest.fixture
def key_release_settings(app):
    """Mutate key-release config and restore it afterwards."""
    keys = (
        'KEY_RELEASE_RATE_LIMIT',
        'KEY_RELEASE_MAX_ATTEMPTS',
        'KEY_RELEASE_BURN_ON_LOCKOUT',
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
    """Persist a complete key share + file record, return (file_id, h, v)."""
    _create_file_record(files_store, file_id=file_id)
    files_store.create_key_share(file_id, h)
    files_store.bind_key_verifier(file_id, v)
    return file_id, h, v


def _key_release_upload(client, filename='key-release.txt', content=b'encrypted blob'):
    """Drive the full two-phase upload; returns (file_id, h, receipt_hex, upload_response)."""
    import hashlib
    import secrets
    begin = client.post(
        url_for('upload_begin'),
        headers={'X-Requested-With': 'XMLHttpRequest',
                      'X-CSRF-Token': 'test-csrf-token'},
    )
    assert begin.status_code == 200
    file_id = begin.get_json()['file_id']
    h = begin.get_json()['h']
    receipt = secrets.token_bytes(32)

    finish = client.post(
        url_for('upload_file'),
        data={
            'file': (io.BytesIO(content), filename),
            'file_id': file_id,
            'key_verifier': 'cc' * 32,
            'receipt_hash': hashlib.sha256(receipt).hexdigest(),
            'csrf_token': 'test-csrf-token',
        },
        content_type='multipart/form-data',
        headers={'X-Requested-With': 'XMLHttpRequest',
                      'X-CSRF-Token': 'test-csrf-token'},
    )
    return file_id, h, receipt.hex(), finish


# ---------------------------------------------------------------------------
# /upload/begin
# ---------------------------------------------------------------------------

def test_upload_begin_requires_auth(client):
    response = client.post(url_for('upload_begin'), follow_redirects=True)
    assert url_for('login') in response.request.path


def test_upload_begin_requires_csrf_on_session(client):
    """A session-authed POST without a CSRF token is forge-proof: 403."""
    login_user(client)
    _clear_csrf(client)
    response = client.post(
        url_for('upload_begin'),
        headers={'X-Requested-With': 'XMLHttpRequest'},
    )
    assert response.status_code == 403
    assert response.get_json()['error'] == 'CSRF validation failed'


def test_upload_begin_bearer_exempt_from_csrf(client):
    """Bearer API clients are CSRF-immune — cross-site requests cannot
    set the Authorization header, so no token is required."""
    from tokens import generate_api_token
    token = generate_api_token('testuser')
    response = client.post(
        url_for('upload_begin'),
        headers={'Authorization': f'Bearer {token}'},
    )
    assert response.status_code == 200
    assert 'h' in response.get_json()


def test_upload_begin_returns_pending_share(client, files_store):
    login_user(client)
    response = client.post(
        url_for('upload_begin'),
        headers={'X-Requested-With': 'XMLHttpRequest',
                      'X-CSRF-Token': 'test-csrf-token'},
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


# ---------------------------------------------------------------------------
# /upload finish (key-release fields)
# ---------------------------------------------------------------------------

def test_key_release_upload_binds_verifier(client, files_store):
    login_user(client)
    file_id, _h, _rcpt, finish = _key_release_upload(client)
    assert finish.status_code == 200
    assert finish.get_json()['file_id'] == file_id

    share = files_store.get_key_share(file_id)
    assert share['v'] == 'cc' * 32
    file_info = files_store.get_by_id(file_id)
    assert file_info is not None
    assert file_info['uploaded_by'] == 'testuser'


def test_key_release_upload_rejects_unknown_share(client, files_store):
    login_user(client)
    response = client.post(
        url_for('upload_file'),
        data={
            'file': (io.BytesIO(b'blob'), 'x.txt'),
            'file_id': 'does-not-exist',
            'key_verifier': 'cc' * 32,
            'receipt_hash': 'aa' * 32,
            'csrf_token': 'test-csrf-token',
        },
        content_type='multipart/form-data',
        headers={'X-Requested-With': 'XMLHttpRequest',
                      'X-CSRF-Token': 'test-csrf-token'},
    )
    assert response.status_code == 409


def test_key_release_upload_rejects_finalized_share(client, files_store):
    login_user(client)
    file_id, _h, _rcpt, finish = _key_release_upload(client)
    assert finish.status_code == 200

    second = client.post(
        url_for('upload_file'),
        data={
            'file': (io.BytesIO(b'blob2'), 'y.txt'),
            'file_id': file_id,
            'key_verifier': 'dd' * 32,
            'receipt_hash': 'aa' * 32,
            'csrf_token': 'test-csrf-token',
        },
        content_type='multipart/form-data',
        headers={'X-Requested-With': 'XMLHttpRequest',
                      'X-CSRF-Token': 'test-csrf-token'},
    )
    assert second.status_code == 409


def test_key_release_upload_rejects_partial_handshake(client):
    login_user(client)
    csrf = 'test-csrf-token'
    for data in (
        {'file': (io.BytesIO(b'b'), 'x.txt'), 'file_id': 'abc',
         'csrf_token': csrf},
        {'file': (io.BytesIO(b'b'), 'x.txt'), 'key_verifier': 'cc' * 32,
         'csrf_token': csrf},
        {'file': (io.BytesIO(b'b'), 'x.txt'),
         'file_id': 'abc', 'key_verifier': 'not-hex', 'csrf_token': csrf},
    ):
        response = client.post(
            url_for('upload_file'),
            data=data,
            content_type='multipart/form-data',
            headers={'X-Requested-With': 'XMLHttpRequest',
                      'X-CSRF-Token': 'test-csrf-token'},
        )
        assert response.status_code == 400


def test_upload_finish_requires_csrf_on_session(client, key_share):
    """/upload with session auth but no CSRF token → 403."""
    login_user(client)
    _clear_csrf(client)
    file_id, _h = key_share()
    response = client.post(
        url_for('upload_file'),
        data={
            'file': (io.BytesIO(b'blob'), 'x.txt'),
            'file_id': file_id,
            'key_verifier': 'cc' * 32,
            'receipt_hash': 'aa' * 32,
        },
        content_type='multipart/form-data',
        headers={'X-Requested-With': 'XMLHttpRequest'},
    )
    assert response.status_code == 403
    assert response.get_json()['error'] == 'CSRF validation failed'


def test_upload_finish_bearer_exempt_from_csrf(client, key_share):
    """Bearer upload completes without any CSRF token."""
    from tokens import generate_api_token
    token = generate_api_token('testuser')
    file_id, _h = key_share()
    response = client.post(
        url_for('upload_file'),
        data={
            'file': (io.BytesIO(b'blob'), 'x.txt'),
            'file_id': file_id,
            'key_verifier': 'cc' * 32,
            'receipt_hash': 'aa' * 32,
        },
        content_type='multipart/form-data',
        headers={'Authorization': f'Bearer {token}',
                 'X-Requested-With': 'XMLHttpRequest'},
    )
    assert response.status_code == 200


def test_upload_without_key_release_fields_rejected(client, files_store):
    """Every upload is two-phase — a bare multipart POST is a 400."""
    login_user(client)
    response = client.post(
        url_for('upload_file'),
        data={'file': (io.BytesIO(b'plain blob'), 'legacy.txt'),
              'csrf_token': 'test-csrf-token'},
        content_type='multipart/form-data',
        headers={'X-Requested-With': 'XMLHttpRequest',
                      'X-CSRF-Token': 'test-csrf-token'},
    )
    assert response.status_code == 400
    assert files_store.get_by(original_name='legacy.txt') is None


def test_key_release_upload_rejects_other_users_share(client, files_store):
    """Owner binding: only the account that ran begin may finish it."""
    login_user(client)  # testuser mints the pending share
    begin = client.post(
        url_for('upload_begin'),
        headers={'X-Requested-With': 'XMLHttpRequest',
                      'X-CSRF-Token': 'test-csrf-token'},
    )
    file_id = begin.get_json()['file_id']
    assert files_store.get_key_share(file_id)['created_by'] == 'testuser'

    login_user(client, 'adminuser', 'adminpass')  # different account finishes
    finish = client.post(
        url_for('upload_file'),
        data={
            'file': (io.BytesIO(b'blob'), 'x.txt'),
            'file_id': file_id,
            'key_verifier': 'cc' * 32,
            'receipt_hash': 'aa' * 32,
            'csrf_token': 'test-csrf-token',
        },
        content_type='multipart/form-data',
        headers={'X-Requested-With': 'XMLHttpRequest',
                      'X-CSRF-Token': 'test-csrf-token'},
    )
    assert finish.status_code == 403
    # the share was NOT bound — still pending, still testuser's
    share = files_store.get_key_share(file_id)
    assert share['v'] is None
    assert share['created_by'] == 'testuser'


def test_upload_missing_receipt_hash_rejected(client, key_share):
    """receipt_hash is required — it backs the decryption report proof."""
    login_user(client)
    file_id, _h = key_share()
    response = client.post(
        url_for('upload_file'),
        data={
            'file': (io.BytesIO(b'blob'), 'x.txt'),
            'file_id': file_id,
            'key_verifier': 'cc' * 32,
        },
        content_type='multipart/form-data',
        headers={'X-Requested-With': 'XMLHttpRequest',
                      'X-CSRF-Token': 'test-csrf-token'},
    )
    assert response.status_code == 400


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


def test_release_wrong_verifier_counts_attempts(client, files_store, key_release_settings):
    # Opt out of the default burn to cover the lockout-keeps-row path.
    key_release_settings['KEY_RELEASE_BURN_ON_LOCKOUT'] = False
    file_id, _h, _v = _bound_share(files_store)

    # With the default of 1 max attempt, the first wrong verifier is
    # already the lockout event — 429 on the same request.
    response = client.post(
        url_for('release_key', file_id=file_id), json={'v': 'dd' * 32})
    assert response.status_code == 429
    share = files_store.get_key_share(file_id)
    assert share['attempts'] == 1
    assert share['released_at'] is None
    # Lockout without burn keeps H in place — only releases are refused.
    assert share['h'] is not None


def test_release_lockout_after_max_attempts(client, files_store, key_release_settings):
    key_release_settings['KEY_RELEASE_MAX_ATTEMPTS'] = 2
    key_release_settings['KEY_RELEASE_BURN_ON_LOCKOUT'] = False
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


def test_release_burn_on_lockout(client, files_store, key_release_settings):
    # Burn is the default — only the attempt budget needs overriding.
    key_release_settings['KEY_RELEASE_MAX_ATTEMPTS'] = 1
    file_id, _h, _v = _bound_share(files_store)

    miss = client.post(
        url_for('release_key', file_id=file_id), json={'v': 'dd' * 32})
    assert miss.status_code == 429
    # Burned: H is gone for good, the ciphertext is mathematically dead.
    assert files_store.get_key_share(file_id) is None
    follow_up = client.post(
        url_for('release_key', file_id=file_id), json={'v': 'bb' * 32})
    assert follow_up.status_code == 404


@pytest.mark.parametrize(
    'missing', ['KEY_RELEASE_MAX_ATTEMPTS', 'KEY_RELEASE_BURN_ON_LOCKOUT'])
def test_release_raises_without_lockout_config(
        client, files_store, key_release_settings, missing):
    """A config missing a lockout key must not fall back to a weaker policy."""
    del key_release_settings[missing]
    file_id, _h, _v = _bound_share(files_store)

    with pytest.raises(KeyError, match=missing):
        client.post(
            url_for('release_key', file_id=file_id), json={'v': 'dd' * 32})
    # Nothing was attempted: the share is untouched.
    assert files_store.get_key_share(file_id)['attempts'] == 0


def test_release_without_key_share_is_404(client, files_store):
    """A file record with no share (e.g. after burn) has nothing to release."""
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
    ['not', 'a', 'dict'],
    'just-a-string',
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
    # expiry destroys the share inside the same transaction — H is gone
    assert files_store.get_key_share('exp-1') is None


def test_release_works_after_blob_download(client, files_store, app):
    """The real order: blob first (claims download), then /release."""
    login_user(client)
    file_id, h, _rcpt, finish = _key_release_upload(client, content=b'real blob')
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
    file_id, _h, _rcpt, finish = _key_release_upload(client)
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
def test_key_release_end_to_end(client, files_store, key_release_settings):
    """Full vertical slice: begin → v3 encrypt → finish → download →
    release → decrypt. Proves the CLI crypto and the server handshake
    agree byte-for-byte."""
    # Allow one miss before the winning release — the production
    # default of 1 would lock the share right after the wrong try.
    key_release_settings['KEY_RELEASE_MAX_ATTEMPTS'] = 2
    buzz = _import_buzz()
    login_user(client)

    password = 'end-to-end-password'
    plaintext = b'true one-time payload'

    begin = client.post(
        url_for('upload_begin'),
        headers={'X-Requested-With': 'XMLHttpRequest',
                      'X-CSRF-Token': 'test-csrf-token'},
    )
    file_id = begin.get_json()['file_id']
    h = bytes.fromhex(begin.get_json()['h'])

    blob, v_hex, receipt_hash = buzz.encrypt_file(plaintext, password, h)
    assert blob.startswith(b'BKV3')

    finish = client.post(
        url_for('upload_file'),
        data={
            'file': (io.BytesIO(blob), 'e2e.txt'),
            'file_id': file_id,
            'key_verifier': v_hex,
            'receipt_hash': receipt_hash,
            'csrf_token': 'test-csrf-token',
        },
        content_type='multipart/form-data',
        headers={'X-Requested-With': 'XMLHttpRequest',
                      'X-CSRF-Token': 'test-csrf-token'},
    )
    assert finish.status_code == 200

    # Wrong password first: verifier miss, no H, attempt counted.
    salt = blob[4:20]
    _kp, wrong_v = buzz.derive_key_release_keys('wrong-password', salt)
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

    data, receipt = buzz.decrypt_file(served, password, h=released_h)
    assert data == plaintext

    # The receipt proves decryption — /report_decryption accepts it.
    report = client.post(
        url_for('report_decryption', file_id=file_id),
        json={'success': True, 'receipt': receipt.hex()})
    assert report.status_code == 200
    assert files_store.get_by_id(file_id)['decryption_success'] is True

    # H is single-use: the share is burned after release.
    again = client.post(
        url_for('release_key', file_id=file_id), json={'v': v_hex})
    assert again.status_code == 410
