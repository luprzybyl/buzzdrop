"""Unit tests for API token generation and validation."""
import pytest


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


def test_validate_api_token_rejects_removed_user(app, monkeypatch, clear_user_cache):
    with app.app_context():
        from app import get_db
        from tokens import _hash_token
        from tokens import generate_api_token, validate_api_token
        from tinydb import Query

        token = generate_api_token('testuser')
        token_hash = _hash_token(token)

        monkeypatch.delenv('FLASK_USER_1', raising=False)
        from auth import get_users
        get_users.cache_clear()

        assert validate_api_token(token) is None

        entry = get_db().table('api_tokens').get(Query().token_hash == token_hash)
        assert entry['last_used_at'] is None


def test_token_stored_as_hash_not_plaintext(app):
    with app.app_context():
        from app import get_db
        from tokens import _hash_token, generate_api_token
        token = generate_api_token('testuser')
        table = get_db().table('api_tokens')
        entry = table.all()[-1]
        assert 'token_hash' in entry
        assert entry.get('token_hash') != token
        expected_hash = _hash_token(token)
        assert entry['token_hash'] == expected_hash


def test_token_hash_does_not_depend_on_temporary_session_key(app, monkeypatch):
    with app.app_context():
        from tokens import _hash_token

        monkeypatch.delenv('FLASK_SECRET_KEY', raising=False)
        app.config.pop('TOKEN_HASH_SECRET', None)

        app.config['SECRET_KEY'] = 'temporary-session-key-1'
        first_hash = _hash_token('a' * 64)

        app.config['SECRET_KEY'] = 'temporary-session-key-2'
        second_hash = _hash_token('a' * 64)

        assert first_hash == second_hash


def test_validate_api_token_accepts_legacy_hash(app):
    with app.app_context():
        from app import get_db
        from tokens import _hash_token, _hash_token_legacy, validate_api_token
        from tinydb import Query

        token = 'a' * 64
        legacy_hash = _hash_token_legacy(token)
        get_db().table('api_tokens').insert({
            'token_hash': legacy_hash,
            'username': 'testuser',
            'created_at': '2026-09-16T00:00:00',
            'last_used_at': None,
        })

        assert validate_api_token(token) == 'testuser'
        migrated_entry = get_db().table('api_tokens').get(Query().token_hash == _hash_token(token))
        assert migrated_entry is not None


def test_validate_updates_last_used_at(app):
    with app.app_context():
        from app import get_db
        from tokens import _hash_token, generate_api_token, validate_api_token
        from tinydb import Query
        token = generate_api_token('testuser')
        # last_used_at is None before first validation
        Q = Query()
        table = get_db().table('api_tokens')
        token_hash = _hash_token(token)
        entry_before = table.get(Q.token_hash == token_hash)
        assert entry_before['last_used_at'] is None

        validate_api_token(token)
        entry_after = table.get(Q.token_hash == token_hash)
        assert entry_after['last_used_at'] is not None


def test_revoke_api_token(app):
    with app.app_context():
        from tokens import generate_api_token, validate_api_token, revoke_api_token
        token = generate_api_token('testuser')
        assert validate_api_token(token) == 'testuser'
        assert revoke_api_token(token) is True
        assert validate_api_token(token) is None


def test_revoke_api_token_removes_legacy_hash(app):
    with app.app_context():
        from app import get_db
        from tokens import _hash_token_legacy, revoke_api_token
        from tinydb import Query

        token = 'a' * 64
        legacy_hash = _hash_token_legacy(token)
        table = get_db().table('api_tokens')
        table.insert({
            'token_hash': legacy_hash,
            'username': 'testuser',
            'created_at': '2026-09-16T00:00:00',
            'last_used_at': None,
        })

        assert revoke_api_token(token) is True
        assert table.get(Query().token_hash == legacy_hash) is None


def test_revoke_nonexistent_token(app):
    with app.app_context():
        from tokens import revoke_api_token
        assert revoke_api_token('0' * 64) is False
