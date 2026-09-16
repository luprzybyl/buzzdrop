"""Unit tests for API token generation and validation."""
from datetime import datetime, timedelta
import pytest


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
        assert entry.get('expires_at') is not None


def test_validate_updates_last_used_at(app, db_instance):
    with app.app_context():
        from app import get_db
        from tokens import generate_api_token, validate_api_token
        token = generate_api_token('testuser')
        # last_used_at is None before first validation
        table = get_db().table('api_tokens')
        entry_before = table.get(lambda item: item['username'] == 'testuser')
        assert entry_before['last_used_at'] is None

        validate_api_token(token)
        entry_after = table.get(doc_id=entry_before.doc_id)
        assert entry_after['last_used_at'] is not None


def test_revoke_api_token(app):
    with app.app_context():
        from tokens import generate_api_token, validate_api_token, revoke_api_token
        token = generate_api_token('testuser')
        assert validate_api_token(token) == 'testuser'
        assert revoke_api_token(token) is True
        assert validate_api_token(token) is None


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
