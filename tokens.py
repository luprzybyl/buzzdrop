"""
API token management for Buzzdrop.
Tokens are stored as PBKDF2-HMAC-SHA256 fingerprints; the raw token is shown only once at generation.
"""
import hashlib
import hmac
import secrets
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

from flask import current_app
from tinydb import Query


def _get_tokens_table():
    from app import get_db
    return get_db().table('api_tokens')


DEFAULT_TOKEN_EXPIRY_DAYS = 30
TOKEN_HASH_ITERATIONS = 10_000


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


def _hash_token(raw_token: str) -> str:
    secret_key = current_app.config.get('SECRET_KEY', '')
    return hashlib.pbkdf2_hmac(
        'sha256',
        raw_token.encode(),
        secret_key.encode(),
        TOKEN_HASH_ITERATIONS,
    ).hex()


def _legacy_hash_token(raw_token: str) -> str:
    secret_key = current_app.config.get('SECRET_KEY', '')
    return hmac.new(secret_key.encode(), raw_token.encode(), hashlib.sha256).hexdigest()


def generate_api_token(username: str, expires_at: Optional[datetime] = None) -> str:
    """
    Generate a new API token for a user, store its hash, and return the raw token.

    The raw token is returned exactly once and never stored. Future lookups use
    a PBKDF2-HMAC-SHA256 fingerprint.

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
    Q = Query()
    table = _get_tokens_table()
    token_hash = _hash_token(raw_token)
    entry = table.get(Q.token_hash == token_hash)
    is_legacy_entry = False
    if not entry:
        legacy_token_hash = _legacy_hash_token(raw_token)
        entry = table.get(Q.token_hash == legacy_token_hash)
        is_legacy_entry = entry is not None
    if not entry:
        return None
    if _is_token_expired(entry):
        table.remove(doc_ids=[entry.doc_id])
        return None
    updates = {'last_used_at': datetime.now().isoformat()}
    if not entry.get('expires_at'):
        expires_at = _get_token_expiry(entry)
        if expires_at is not None:
            updates['expires_at'] = expires_at.isoformat()
    if is_legacy_entry:
        updates['token_hash'] = token_hash
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
    if removed:
        return True
    removed = table.remove(Q.token_hash == _legacy_hash_token(raw_token))
    return bool(removed)
