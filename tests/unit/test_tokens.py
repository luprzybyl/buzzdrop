"""Unit tests for API token generation and validation."""
import hashlib
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


def test_token_stored_as_hash_not_plaintext(app):
    with app.app_context():
        from app import get_db
        from tokens import generate_api_token
        token = generate_api_token('testuser')
        table = get_db().table('api_tokens')
        entry = table.all()[-1]
        assert 'token_hash' in entry
        assert entry.get('token_hash') != token
        expected_hash = hashlib.sha256(token.encode()).hexdigest()
        assert entry['token_hash'] == expected_hash


def test_validate_updates_last_used_at(app):
    with app.app_context():
        from app import get_db
        from tokens import generate_api_token, validate_api_token
        from tinydb import Query
        token = generate_api_token('testuser')
        # last_used_at is None before first validation
        Q = Query()
        table = get_db().table('api_tokens')
        token_hash = hashlib.sha256(token.encode()).hexdigest()
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


def test_revoke_nonexistent_token(app):
    with app.app_context():
        from tokens import revoke_api_token
        assert revoke_api_token('0' * 64) is False
