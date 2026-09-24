"""
API token management for Buzzdrop.
Tokens are stored as deterministic PBKDF2-HMAC-SHA256 digests with a stable
hash secret; the raw token is shown only once at generation.
"""
import hashlib
import os
import secrets
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

from flask import current_app, has_app_context
from tinydb import Query

DEFAULT_TOKEN_EXPIRY_DAYS = 30
TOKEN_HASH_ITERATIONS = 310_000
TOKEN_HASH_BYTES = 32
TOKEN_HASH_VERSION = 'pbkdf2-sha256-v1'


def _get_tokens_table():
    from app import get_db
    return get_db().table('api_tokens')


def _parse_timestamp(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def _get_token_expiry(entry: Dict[str, Any]) -> Optional[datetime]:
    expires_at = _parse_timestamp(entry.get('expires_at'))
    if expires_at is not None:
        return expires_at

    created_at = _parse_timestamp(entry.get('created_at'))
    if created_at is None:
        return None
    return created_at + timedelta(days=DEFAULT_TOKEN_EXPIRY_DAYS)


def _is_token_expired(entry: Dict[str, Any]) -> bool:
    expires_at = _get_token_expiry(entry)
    return expires_at is not None and datetime.now() >= expires_at


def _serialize_token(entry: Dict[str, Any]) -> Dict[str, Any]:
    expires_at = _get_token_expiry(entry)
    return {
        'id': entry.doc_id,
        'username': entry['username'],
        'created_at': entry.get('created_at'),
        'last_used_at': entry.get('last_used_at'),
        'expires_at': expires_at.isoformat() if expires_at is not None else None,
    }


def _get_token_hash_secret() -> bytes:
    token_hash_secret = current_app.config.get('TOKEN_HASH_SECRET') if has_app_context() else None

    if not token_hash_secret:
        token_hash_secret = os.getenv('TOKEN_HASH_SECRET') or os.getenv('FLASK_SECRET_KEY')
    if not token_hash_secret:
        raise RuntimeError('API token hashing requires TOKEN_HASH_SECRET or FLASK_SECRET_KEY')
    if isinstance(token_hash_secret, str):
        token_hash_secret = token_hash_secret.encode()
    return token_hash_secret


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


def generate_api_token(username: str, expires_at: Optional[datetime] = None) -> str:
    """
    Generate a new API token for a user, store its hash, and return the raw token.

    The raw token is returned exactly once and never stored. Future lookups use
    the derived token digest.

    Args:
        username: Username to associate with the token

    Returns:
        Raw 64-character hex token (show to user once)
    """
    now = datetime.now()
    raw_token = secrets.token_hex(32)
    token_hash = _hash_token(raw_token)
    expires_at = expires_at or (now + timedelta(days=DEFAULT_TOKEN_EXPIRY_DAYS))
    _get_tokens_table().insert({
        'token_hash': token_hash,
        'token_hash_version': TOKEN_HASH_VERSION,
        'username': username,
        'created_at': now.isoformat(),
        'last_used_at': None,
        'expires_at': expires_at.isoformat(),
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
        return None

    from auth import get_users
    if entry['username'] not in get_users():
        table.remove(doc_ids=[entry.doc_id])
        return None

    if _is_token_expired(entry):
        table.remove(doc_ids=[entry.doc_id])
        return None

    updates = {'last_used_at': datetime.now().isoformat()}
    expires_at = _get_token_expiry(entry)
    if expires_at is not None and not entry.get('expires_at'):
        updates['expires_at'] = expires_at.isoformat()

    if not entry.get('token_hash_version'):
        updates['token_hash_version'] = TOKEN_HASH_VERSION

    table.update(updates, doc_ids=[entry.doc_id])
    return entry['username']


def list_api_tokens(username: Optional[str] = None) -> List[Dict[str, Any]]:
    """
    List active API tokens, optionally scoped to a single user.

    Expired tokens are removed from storage as part of the listing operation.
    """
    table = _get_tokens_table()
    active_tokens = []
    expired_token_ids = []

    for entry in table.all():
        if _is_token_expired(entry):
            expired_token_ids.append(entry.doc_id)
            continue
        if username and entry.get('username') != username:
            continue
        active_tokens.append(_serialize_token(entry))

    if expired_token_ids:
        table.remove(doc_ids=expired_token_ids)

    return sorted(active_tokens, key=lambda token: token['created_at'] or '', reverse=True)


def get_api_token(token_id: int) -> Optional[Dict[str, Any]]:
    """Return active token metadata by TinyDB document ID."""
    table = _get_tokens_table()
    entry = table.get(doc_id=token_id)
    if not entry:
        return None
    if _is_token_expired(entry):
        table.remove(doc_ids=[token_id])
        return None
    return _serialize_token(entry)


def revoke_api_token_by_id(token_id: int) -> bool:
    """Revoke a token by TinyDB document ID."""
    table = _get_tokens_table()
    removed = table.remove(doc_ids=[token_id])
    return bool(removed)


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
