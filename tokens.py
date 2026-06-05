"""
API token management for Buzzdrop.
Tokens are stored as SHA-256 hashes; the raw token is shown only once at generation.
"""
import hashlib
import secrets
from datetime import datetime
from typing import Optional

from tinydb import Query


def _get_tokens_table():
    from app import get_db
    return get_db().table('api_tokens')


def generate_api_token(username: str) -> str:
    """
    Generate a new API token for a user, store its hash, and return the raw token.

    The raw token is returned exactly once and never stored. Future lookups use
    the SHA-256 hash.

    Args:
        username: Username to associate with the token

    Returns:
        Raw 64-character hex token (show to user once)
    """
    raw_token = secrets.token_hex(32)
    token_hash = hashlib.sha256(raw_token.encode()).hexdigest()
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
    token_hash = hashlib.sha256(raw_token.encode()).hexdigest()
    Q = Query()
    table = _get_tokens_table()
    entry = table.get(Q.token_hash == token_hash)
    if not entry:
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
    token_hash = hashlib.sha256(raw_token.encode()).hexdigest()
    Q = Query()
    table = _get_tokens_table()
    removed = table.remove(Q.token_hash == token_hash)
    return bool(removed)
