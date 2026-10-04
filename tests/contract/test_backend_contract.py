"""
Backend contract test suite.

This suite is the acceptance bar for every storage backend. It runs
against SQLite always; additional backends activate by exporting a DSN:

    BUZZDROP_TEST_PG_DSN=postgresql://user:pass@host/db
    BUZZDROP_TEST_MYSQL_DSN=mysql://user:pass@host/db
    BUZZDROP_TEST_ORACLE_DSN=oracle://user:pass@host/service

To add a backend: implement FileStore + TokenStore (db/base.py), register
the scheme in db.create_backend(), and make this suite pass.
"""
import os
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta

import pytest

from db import create_backend

_EXTRA_DSNS = (
    ('postgresql', 'BUZZDROP_TEST_PG_DSN'),
    ('mysql', 'BUZZDROP_TEST_MYSQL_DSN'),
    ('oracle', 'BUZZDROP_TEST_ORACLE_DSN'),
)


def _backend_params():
    params = [pytest.param('sqlite', id='sqlite')]
    for name, env_var in _EXTRA_DSNS:
        if os.getenv(env_var):
            params.append(pytest.param(env_var, id=name))
    return params


@pytest.fixture(params=_backend_params())
def backend(request, tmp_path):
    """Yield a fresh, empty Backend for each configured DSN."""
    if request.param == 'sqlite':
        url = f'sqlite:///{tmp_path}/contract.db'
    else:
        url = os.environ[request.param]
        # External backends need their tables truncated between tests.
        backend = create_backend(url)
        backend.files.truncate()
        backend.tokens.truncate()
        yield backend
        backend.close()
        return

    backend = create_backend(url)
    yield backend
    backend.close()


def _file_doc(file_id='file-1', **overrides):
    doc = {
        'id': file_id,
        'original_name': 'secret.txt',
        'path': f'uploads/{file_id}',
        'created_at': datetime.now().isoformat(),
        'downloaded_at': None,
        'uploaded_by': 'testuser',
        'expiry_at': None,
        'status': 'active',
        'decryption_success': None,
        'type': 'file',
        'shared_with': ['alice', 'bob'],
        'notify_on_open': True,
        'custom_field': 'stashed-in-extra',
    }
    doc.update(overrides)
    return doc


# ---------------------------------------------------------------------------
# FileStore contract
# ---------------------------------------------------------------------------

def test_insert_and_get_by_id_roundtrip(backend):
    doc_id = backend.files.insert(_file_doc())
    assert isinstance(doc_id, int)

    stored = backend.files.get_by_id('file-1')
    assert stored is not None
    assert stored['doc_id'] == doc_id
    assert stored['original_name'] == 'secret.txt'
    assert stored['downloaded_at'] is None
    # bool and list values round-trip exactly
    assert stored['notify_on_open'] is True
    assert stored['decryption_success'] is None
    assert stored['shared_with'] == ['alice', 'bob']
    # unknown fields survive via the overflow column
    assert stored['custom_field'] == 'stashed-in-extra'


def test_get_by_id_missing(backend):
    assert backend.files.get_by_id('nope') is None


def test_insert_with_explicit_doc_id(backend):
    """Explicit doc_id round-trips and auto ids keep increasing past it."""
    doc_id = backend.files.insert(_file_doc(), doc_id=100)
    assert doc_id == 100
    assert backend.files.get_by_id('file-1')['doc_id'] == 100

    next_id = backend.files.insert(_file_doc('file-2'))
    assert next_id > 100


def test_get_by_and_list_by(backend):
    backend.files.insert(_file_doc('a', uploaded_by='u1', status='active'))
    backend.files.insert(_file_doc('b', uploaded_by='u1', status='expired'))
    backend.files.insert(_file_doc('c', uploaded_by='u2', status='active'))

    assert backend.files.get_by(original_name='secret.txt',
                                uploaded_by='u1')['id'] == 'a'
    assert [f['id'] for f in backend.files.list_by(uploaded_by='u1')] == ['a', 'b']
    assert [f['id'] for f in backend.files.list_by(status='active')] == ['a', 'c']
    assert backend.files.list_by(uploaded_by='nobody') == []


def test_all_returns_every_record(backend):
    backend.files.insert(_file_doc('x'))
    backend.files.insert(_file_doc('y'))
    assert sorted(f['id'] for f in backend.files.all()) == ['x', 'y']


def test_update_fields(backend):
    backend.files.insert(_file_doc())
    assert backend.files.update_fields('file-1', {
        'status': 'expired',
        'decryption_success': False,
        'another_extra': 42,
    }) is True

    stored = backend.files.get_by_id('file-1')
    assert stored['status'] == 'expired'
    assert stored['decryption_success'] is False
    assert stored['another_extra'] == 42
    # untouched fields preserved
    assert stored['original_name'] == 'secret.txt'


def test_update_fields_missing_id(backend):
    assert backend.files.update_fields('nope', {'status': 'x'}) is False


def test_claim_download_once(backend):
    backend.files.insert(_file_doc())
    assert backend.files.claim_download('file-1', '1.2.3.4') is True
    assert backend.files.claim_download('file-1', '5.6.7.8') is False

    stored = backend.files.get_by_id('file-1')
    assert stored['downloaded_at'] is not None
    assert stored['downloaded_by_ip'] == '1.2.3.4'


def test_claim_download_concurrent_single_winner(backend):
    """≥8 racing claims must produce exactly one winner — the one-time guarantee."""
    backend.files.insert(_file_doc())

    workers = 8
    with ThreadPoolExecutor(max_workers=workers) as pool:
        results = list(pool.map(
            lambda index: backend.files.claim_download('file-1', f'10.0.0.{index}'),
            range(workers),
        ))

    assert results.count(True) == 1

    stored = backend.files.get_by_id('file-1')
    assert stored['downloaded_at'] is not None
    assert stored['downloaded_by_ip'] in {f'10.0.0.{i}' for i in range(workers)}


def test_claim_notification_send_once(backend):
    backend.files.insert(_file_doc())
    assert backend.files.claim_notification_send('file-1') is True
    assert backend.files.claim_notification_send('file-1') is False


def test_claim_notification_send_rejects_sent(backend):
    backend.files.insert(_file_doc())
    backend.files.update_fields(
        'file-1', {'notification_sent_at': datetime.now().isoformat()}
    )
    assert backend.files.claim_notification_send('file-1') is False


def test_delete(backend):
    backend.files.insert(_file_doc())
    assert backend.files.delete('file-1') is True
    assert backend.files.get_by_id('file-1') is None
    assert backend.files.delete('file-1') is False


def test_files_truncate(backend):
    backend.files.insert(_file_doc())
    backend.files.truncate()
    assert backend.files.all() == []


# ---------------------------------------------------------------------------
# FileStore contract — server-gated key release
# ---------------------------------------------------------------------------

_H = 'aa' * 32
_V = 'bb' * 32


def test_key_share_lifecycle(backend):
    assert backend.files.create_key_share('f1', _H) is True
    # duplicate share for the same file_id is refused
    assert backend.files.create_key_share('f1', _H) is False

    share = backend.files.get_key_share('f1')
    assert share is not None
    assert share['file_id'] == 'f1'
    assert share['h'] == _H
    assert share['v'] is None
    assert share['attempts'] == 0
    assert share['released_at'] is None
    assert share['created_at'] is not None

    assert backend.files.bind_key_verifier('f1', _V) is True
    # second bind is refused — the verifier is set at upload finish, once
    assert backend.files.bind_key_verifier('f1', 'cc' * 32) is False
    assert backend.files.get_key_share('f1')['v'] == _V

    # verifier miss releases nothing and burns no release
    assert backend.files.claim_key_release('f1', 'dd' * 32) is None
    assert backend.files.get_key_share('f1')['released_at'] is None

    # correct verifier releases H exactly once — and wipes h/v with the
    # claim, so a post-release DB theft yields no crackable material
    assert backend.files.claim_key_release('f1', _V) == _H
    released = backend.files.get_key_share('f1')
    assert released['released_at'] is not None
    assert released['h'] is None and released['v'] is None
    assert backend.files.claim_key_release('f1', _V) is None


def test_key_share_get_missing(backend):
    assert backend.files.get_key_share('nope') is None
    assert backend.files.claim_key_release('nope', _V) is None
    assert backend.files.record_key_attempt('nope') is None
    assert backend.files.delete_key_share('nope') is False


def test_unbound_key_share_cannot_be_claimed(backend):
    """A pending share (finish not called) releases nothing."""
    backend.files.create_key_share('f1', _H)
    assert backend.files.claim_key_release('f1', _V) is None
    assert backend.files.claim_key_release('f1', _H) is None


def test_claim_key_release_concurrent_single_winner(backend):
    """≥8 racing releases must produce exactly one H — the key-release guarantee."""
    backend.files.create_key_share('f1', _H)
    backend.files.bind_key_verifier('f1', _V)

    workers = 8
    with ThreadPoolExecutor(max_workers=workers) as pool:
        results = list(pool.map(
            lambda _i: backend.files.claim_key_release('f1', _V),
            range(workers),
        ))

    assert results.count(_H) == 1
    assert results.count(None) == workers - 1
    assert backend.files.get_key_share('f1')['released_at'] is not None


def test_claim_key_release_concurrent_mixed_verifiers(backend):
    """Racing releases where only some hold the right V still yield one win."""
    backend.files.create_key_share('f1', _H)
    backend.files.bind_key_verifier('f1', _V)

    verifiers = [_V] * 4 + ['ee' * 32] * 4
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(
            lambda v: backend.files.claim_key_release('f1', v),
            verifiers,
        ))

    assert results.count(_H) == 1


def test_record_key_attempt_counts(backend):
    backend.files.create_key_share('f1', _H)
    assert backend.files.record_key_attempt('f1') == 1
    assert backend.files.record_key_attempt('f1') == 2
    assert backend.files.get_key_share('f1')['attempts'] == 2


def test_record_key_attempt_stops_after_release(backend):
    backend.files.create_key_share('f1', _H)
    backend.files.bind_key_verifier('f1', _V)
    backend.files.claim_key_release('f1', _V)
    assert backend.files.record_key_attempt('f1') is None
    assert backend.files.get_key_share('f1')['attempts'] == 0


def test_delete_key_share(backend):
    backend.files.create_key_share('f1', _H)
    assert backend.files.delete_key_share('f1') is True
    assert backend.files.get_key_share('f1') is None
    # burned share is gone for good — no claim can resurrect H
    assert backend.files.bind_key_verifier('f1', _V) is False
    assert backend.files.claim_key_release('f1', _V) is None


def test_truncate_clears_key_shares(backend):
    backend.files.create_key_share('f1', _H)
    backend.files.truncate()
    assert backend.files.get_key_share('f1') is None


# ---------------------------------------------------------------------------
# TokenStore contract
# ---------------------------------------------------------------------------

def _token_doc(**overrides):
    doc = {
        'token_hash': 'hash-' + os.urandom(4).hex(),
        'token_hash_version': 'pbkdf2-sha256-v1',
        'username': 'testuser',
        'created_at': datetime.now().isoformat(),
        'last_used_at': None,
        'expires_at': (datetime.now() + timedelta(days=30)).isoformat(),
    }
    doc.update(overrides)
    return doc


def test_token_insert_and_get(backend):
    doc_id = backend.tokens.insert(_token_doc(token_hash='abc123'))
    assert isinstance(doc_id, int)

    by_id = backend.tokens.get_by_id(doc_id)
    assert by_id is not None
    assert by_id['doc_id'] == doc_id
    assert by_id['token_hash'] == 'abc123'

    by_hash = backend.tokens.get_by_token_hash('abc123')
    assert by_hash['doc_id'] == doc_id
    assert backend.tokens.get_by_token_hash('missing') is None


def test_token_get_by_and_list_by(backend):
    backend.tokens.insert(_token_doc(username='u1'))
    backend.tokens.insert(_token_doc(username='u1'))
    backend.tokens.insert(_token_doc(username='u2'))

    assert backend.tokens.get_by(username='u2')['username'] == 'u2'
    assert len(backend.tokens.list_by(username='u1')) == 2


def test_token_update_fields(backend):
    doc_id = backend.tokens.insert(_token_doc())
    now = datetime.now().isoformat()
    assert backend.tokens.update_fields(doc_id, {
        'last_used_at': now,
        'token_hash_version': 'v2',
    }) is True

    stored = backend.tokens.get_by_id(doc_id)
    assert stored['last_used_at'] == now
    assert stored['token_hash_version'] == 'v2'


def test_token_remove_by_id_and_ids(backend):
    id1 = backend.tokens.insert(_token_doc())
    id2 = backend.tokens.insert(_token_doc())
    id3 = backend.tokens.insert(_token_doc())

    assert backend.tokens.remove_by_id(id1) is True
    assert backend.tokens.remove_by_id(id1) is False
    assert backend.tokens.remove_by_ids([id2, id3]) == 2
    assert backend.tokens.all() == []


def test_token_remove_by_hash(backend):
    backend.tokens.insert(_token_doc(token_hash='tok-hash-1'))
    backend.tokens.insert(_token_doc(token_hash='tok-hash-2'))

    assert backend.tokens.remove_by_hash('tok-hash-1') is True
    assert backend.tokens.remove_by_hash('tok-hash-1') is False
    assert [t['token_hash'] for t in backend.tokens.all()] == ['tok-hash-2']


def test_token_purge_expired(backend):
    past = (datetime.now() - timedelta(hours=1)).isoformat()
    future = (datetime.now() + timedelta(hours=1)).isoformat()
    backend.tokens.insert(_token_doc(expires_at=past))
    backend.tokens.insert(_token_doc(expires_at=future))
    backend.tokens.insert(_token_doc(expires_at=None))  # legacy: no stored expiry
    # malformed expiry is fail-closed: treated as expired, not kept valid
    backend.tokens.insert(_token_doc(expires_at='not-a-timestamp'))

    assert backend.tokens.purge_expired(datetime.now().isoformat()) == 2
    remaining = backend.tokens.all()
    assert len(remaining) == 2
    assert all(t['expires_at'] in (future, None) for t in remaining)


def test_tokens_truncate(backend):
    backend.tokens.insert(_token_doc())
    backend.tokens.truncate()
    assert backend.tokens.all() == []


# ---------------------------------------------------------------------------
# Factory contract
# ---------------------------------------------------------------------------

def test_create_backend_rejects_unknown_scheme():
    with pytest.raises(NotImplementedError, match='postgresql'):
        create_backend('postgresql://user:pass@host/db')
    with pytest.raises(NotImplementedError, match='mysql'):
        create_backend('mysql://user:pass@host/db')
