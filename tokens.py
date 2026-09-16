"""
API token management for Buzzdrop.
Tokens are stored as deterministic PBKDF2-HMAC-SHA256 digests with a stable
hash secret; the raw token is shown only once at generation. Legacy SHA-256
token hashes remain valid.
"""
import hashlib
import os
import secrets
from datetime import datetime
from typing import Optional

from tinydb import Query

TOKEN_HASH_ITERATIONS = 310_000
TOKEN_HASH_BYTES = 32
DEFAULT_TOKEN_HASH_SECRET = b'buzzdrop-api-token-v1'


def _get_tokens_table():
    from app import get_db
    return get_db().table('api_tokens')


def _get_token_hash_secret() -> bytes:
    from app import app as flask_app

    token_hash_secret = flask_app.config.get('TOKEN_HASH_SECRET')
    if not token_hash_secret:
        token_hash_secret = os.getenv('TOKEN_HASH_SECRET') or os.getenv('FLASK_SECRET_KEY')
    if isinstance(token_hash_secret, str):
        token_hash_secret = token_hash_secret.encode()
    return token_hash_secret or DEFAULT_TOKEN_HASH_SECRET


def _hash_token(raw_token: str) -> str:
    """Derive the current deterministic digest for API token storage and lookup."""
    digest = hashlib.pbkdf2_hmac(
        'sha256',
        raw_token.encode(),
        _get_token_hash_secret(),
        TOKEN_HASH_ITERATIONS,
        dklen=TOKEN_HASH_BYTES,
    )
    return digest.hex()


def generate_api_token(username: str) -> str:
    """
    Generate a new API token for a user, store its hash, and return the raw token.

    The raw token is returned exactly once and never stored. Future lookups use
    the derived token digest.

    Args:
        username: Username to associate with the token

    Returns:
        Raw 64-character hex token (show to user once)
    """
    raw_token = secrets.token_hex(32)
    token_hash = _hash_token(raw_token)
    _get_tokens_table().insert({
        'token_hash': token_hash,
        'username': username,
        'created_at': datetime.now().isoformat(),
        'last_used_at': None,
    })
    return raw_token


def validate_api_token(raw_token: str) -> Optional[str]:
    """
    Validate a raw token and return its associated username, or None if invalid.

    Also updates last_used_at on success.

    Args:
        raw_token: Raw token string from the Authorization header

    Returns:
        Username string if valid, None otherwise
    """
    token_hash = _hash_token(raw_token)
    Q = Query()
    table = _get_tokens_table()

    entry = table.get(Q.token_hash == token_hash)
    if not entry:
        legacy_token_hash = hashlib.new('sha256', raw_token.encode()).hexdigest()
        entry = table.get(Q.token_hash == legacy_token_hash)
        if not entry:
            return None
        table.update({'token_hash': token_hash}, Q.token_hash == legacy_token_hash)

    from auth import get_users
    if entry['username'] not in get_users():
        return None
    table.update({'last_used_at': datetime.now().isoformat()}, Q.token_hash == token_hash)
    return entry['username']


def revoke_api_token(raw_token: str) -> bool:
    """
    Revoke a token by removing it from the store.

    Args:
        raw_token: Raw token string to revoke

    Returns:
        True if the token existed and was removed, False otherwise
    """
    token_hash = _hash_token(raw_token)
    Q = Query()
    table = _get_tokens_table()
    removed = table.remove(Q.token_hash == token_hash)
    return bool(removed)
