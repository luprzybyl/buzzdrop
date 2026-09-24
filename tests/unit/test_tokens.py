"""Unit tests for API token generation and validation."""
import hashlib
from datetime import datetime, timedelta

import pytest


def _historical_legacy_token_hash(raw_token: str) -> str:
    return hashlib.pbkdf2_hmac(
        'sha256',
        raw_token.encode(),
        b'buzzdrop-api-token-legacy-v1',
        120_000,
        dklen=32,
    ).hex()


@pytest.fixture
def clear_user_cache(monkeypatch):
    from auth import get_users
    get_users.cache_clear()
    yield
    monkeypatch.undo()
    get_users.cache_clear()


def test_generate_api_token_returns_hex_string(app):
    with app.app_context():
        from tokens import generate_api_token
        token = generate_api_token('testuser')
        assert isinstance(token, str)
        assert len(token) == 64  # secrets.token_hex(32)
        int(token, 16)  # must be valid hex


def test_validate_api_token_valid(app):
    with app.app_context():
        from tokens import generate_api_token, validate_api_token
        token = generate_api_token('testuser')
        assert validate_api_token(token) == 'testuser'


def test_validate_api_token_invalid(app):
    with app.app_context():
        from tokens import validate_api_token
        assert validate_api_token('0' * 64) is None


def test_validate_api_token_expired(app, db_instance):
    with app.app_context():
        from app import get_db
        from tokens import generate_api_token, validate_api_token

        token = generate_api_token('testuser', expires_at=datetime.now() - timedelta(minutes=1))
        assert validate_api_token(token) is None
        assert get_db().table('api_tokens').all() == []


def test_validate_api_token_rejects_removed_user(app, monkeypatch, clear_user_cache):
    with app.app_context():
        from app import get_db
        from auth import get_users
        from tinydb import Query
        from tokens import _hash_token, generate_api_token, validate_api_token

        token = generate_api_token('testuser')
        token_hash = _hash_token(token)

        monkeypatch.delenv('FLASK_USER_1', raising=False)
        get_users.cache_clear()

        assert validate_api_token(token) is None

        entry = get_db().table('api_tokens').get(Query().token_hash == token_hash)
        assert entry is None


def test_token_stored_as_hash_not_plaintext(app):
    with app.app_context():
        from app import get_db
        from tokens import TOKEN_HASH_VERSION, _hash_token, generate_api_token

        token = generate_api_token('testuser')
        table = get_db().table('api_tokens')
        entry = table.all()[-1]
        assert 'token_hash' in entry
        assert entry.get('token_hash') != token
        assert entry['token_hash'] == _hash_token(token)
        assert entry['token_hash_version'] == TOKEN_HASH_VERSION
        assert entry.get('expires_at') is not None


def test_token_hash_uses_current_app_secret_when_no_explicit_hash_secret_is_configured(app, monkeypatch):
    with app.app_context():
        from tokens import _hash_token

        monkeypatch.delenv('FLASK_SECRET_KEY', raising=False)
        app.config.pop('TOKEN_HASH_SECRET', None)

        app.config['SECRET_KEY'] = 'temporary-session-key-1'
        first_hash = _hash_token('a' * 64)

        app.config['SECRET_KEY'] = 'temporary-session-key-2'
        second_hash = _hash_token('a' * 64)

        assert first_hash != second_hash


def test_validate_api_token_rejects_legacy_hash(app, db_instance):
    with app.app_context():
        from app import get_db
        from tokens import validate_api_token

        token = 'a' * 64
        legacy_hash = _historical_legacy_token_hash(token)
        get_db().table('api_tokens').insert({
            'token_hash': legacy_hash,
            'token_hash_version': 'legacy-pbkdf2-sha256-v1',
            'username': 'testuser',
            'created_at': datetime.now().isoformat(),
            'last_used_at': None,
        })

        assert validate_api_token(token) is None
        stored_entry = get_db().table('api_tokens').all()[-1]
        assert stored_entry['token_hash'] == legacy_hash
        assert stored_entry['token_hash_version'] == 'legacy-pbkdf2-sha256-v1'
        assert stored_entry.get('last_used_at') is None


def test_validate_api_token_sets_missing_hash_version(app, db_instance):
    with app.app_context():
        from app import get_db
        from tinydb import Query
        from tokens import TOKEN_HASH_VERSION, _hash_token, validate_api_token

        token = 'b' * 64
        token_hash = _hash_token(token)
        table = get_db().table('api_tokens')
        table.insert({
            'token_hash': token_hash,
            'username': 'testuser',
            'created_at': datetime.now().isoformat(),
            'last_used_at': None,
        })

        assert validate_api_token(token) == 'testuser'
        entry = table.get(Query().token_hash == token_hash)
        assert entry['token_hash_version'] == TOKEN_HASH_VERSION
        assert entry['last_used_at'] is not None


def test_validate_updates_last_used_at(app, db_instance):
    with app.app_context():
        from app import get_db
        from tinydb import Query
        from tokens import _hash_token, generate_api_token, validate_api_token

        token = generate_api_token('testuser')
        table = get_db().table('api_tokens')
        token_hash = _hash_token(token)
        entry_before = table.get(Query().token_hash == token_hash)
        assert entry_before['last_used_at'] is None

        validate_api_token(token)
        entry_after = table.get(Query().token_hash == token_hash)
        assert entry_after['last_used_at'] is not None


def test_revoke_api_token(app):
    with app.app_context():
        from tokens import generate_api_token, revoke_api_token, validate_api_token

        token = generate_api_token('testuser')
        assert validate_api_token(token) == 'testuser'
        assert revoke_api_token(token) is True
        assert validate_api_token(token) is None


def test_revoke_api_token_does_not_remove_legacy_hash(app, db_instance):
    with app.app_context():
        from app import get_db
        from tinydb import Query
        from tokens import revoke_api_token

        token = 'a' * 64
        legacy_hash = _historical_legacy_token_hash(token)
        table = get_db().table('api_tokens')
        table.insert({
            'token_hash': legacy_hash,
            'token_hash_version': 'legacy-pbkdf2-sha256-v1',
            'username': 'testuser',
            'created_at': datetime.now().isoformat(),
            'last_used_at': None,
        })

        assert revoke_api_token(token) is False
        assert table.get(Query().token_hash == legacy_hash) is not None


def test_revoke_nonexistent_token(app):
    with app.app_context():
        from tokens import revoke_api_token
        assert revoke_api_token('0' * 64) is False


def test_list_api_tokens_filters_expired_and_legacy_tokens(app, db_instance):
    with app.app_context():
        from app import get_db
        from tokens import list_api_tokens

        table = get_db().table('api_tokens')
        table.insert({
            'token_hash': 'legacy-active',
            'username': 'testuser',
            'created_at': datetime.now().isoformat(),
            'last_used_at': None,
        })
        table.insert({
            'token_hash': 'legacy-expired',
            'username': 'testuser',
            'created_at': (datetime.now() - timedelta(days=31)).isoformat(),
            'last_used_at': None,
        })

        tokens = list_api_tokens('testuser')

        assert len(tokens) == 1
        assert tokens[0]['username'] == 'testuser'
        assert tokens[0]['expires_at'] is not None
        assert len(table.all()) == 1
