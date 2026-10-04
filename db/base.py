"""
Backend-agnostic storage interfaces for Buzzdrop.

These ABCs define the contract every storage backend must implement —
SQLite today, MySQL/PostgreSQL/Oracle later. Records are plain dicts:
``doc_id`` (int row id) plus the stored fields. New backends implement
:class:`FileStore` and :class:`TokenStore`, register in
:func:`db.create_backend`, and pass the contract suite in
``tests/contract/test_backend_contract.py``.
"""
from abc import ABC, abstractmethod
from typing import Any, Dict, Iterable, List, Mapping, Optional


class FileStore(ABC):
    """Storage operations for file/share records."""

    @abstractmethod
    def insert(self, doc: Mapping[str, Any], doc_id: Optional[int] = None) -> int:
        """
        Insert a file record.

        Args:
            doc: Field dict; ``doc['id']`` is the public file id.
            doc_id: Explicit row id (used only by the db.json migration path).

        Returns:
            The row doc_id (int).
        """

    @abstractmethod
    def get_by_id(self, file_id: str) -> Optional[Dict[str, Any]]:
        """Return the record with the given public file id, or None."""

    @abstractmethod
    def get_by(self, **filters: Any) -> Optional[Dict[str, Any]]:
        """Return the first record where every named field equals its value."""

    @abstractmethod
    def list_by(self, **filters: Any) -> List[Dict[str, Any]]:
        """Return all records where every named field equals its value."""

    @abstractmethod
    def all(self) -> List[Dict[str, Any]]:
        """Return every file record."""

    @abstractmethod
    def update_fields(self, file_id: str, fields: Mapping[str, Any]) -> bool:
        """Set the given fields on one record; True when a row was updated."""

    @abstractmethod
    def claim_download(self, file_id: str, ip_address: str) -> bool:
        """
        Atomically mark the record downloaded.

        MUST be a single conditional statement (e.g.
        ``UPDATE ... SET downloaded_at=..., downloaded_by_ip=...
        WHERE id=? AND downloaded_at IS NULL AND <not expired>``) so
        exactly one of any number of concurrent callers wins the claim.
        Expired records must not be claimable.

        Returns:
            True when this call won the download claim, False otherwise.
        """

    @abstractmethod
    def claim_notification_send(self, file_id: str) -> bool:
        """
        Atomically claim the pending uploader-notification slot.

        Sets ``notification_claimed_at`` iff both ``notification_sent_at``
        and ``notification_claimed_at`` are currently NULL.

        Returns:
            True when the claim succeeded, False otherwise.
        """

    @abstractmethod
    def delete(self, file_id: str) -> bool:
        """Delete the record; True when a row was removed."""

    # -- server-gated key release (oracle) ----------------------------------
    #
    # The oracle design (docs/true-one-time.md §6) splits the file key in
    # two: Kp is derived client-side from the password, H is a random
    # 32-byte share the server holds and releases exactly once. The server
    # stores {H, V, attempts, released_at} per file_id where V is a
    # one-way password verifier (HKDF domain-separated from Kp — the
    # server can check the password without ever seeing it or the key).
    # Rows are created by /upload/begin (H only, V unbound) and completed
    # by /upload/finish. Legacy v1/v2 shares simply have no key-share row.

    @abstractmethod
    def create_key_share(self, file_id: str, h_hex: str) -> bool:
        """
        Insert a pending key share holding only the server half ``h_hex``.

        The share is unbound (``v is None``) until the upload finishes.
        Implementations MUST treat ``released_at`` as NULL and
        ``attempts`` as 0 for a fresh share.

        Returns:
            True when the share was created, False when one already
            exists for this file_id.
        """

    @abstractmethod
    def bind_key_verifier(self, file_id: str, v_hex: str) -> bool:
        """
        Bind the password verifier to a pending share.

        Sets ``v`` iff the share exists, is not yet bound
        (``v IS NULL``), and has not been released.

        Returns:
            True when the verifier was bound, False otherwise.
        """

    @abstractmethod
    def get_key_share(self, file_id: str) -> Optional[Dict[str, Any]]:
        """
        Return the key-share record for a file_id, or None.

        Dict shape: ``{file_id, h, v, attempts, released_at, created_at}``.
        ``v is None`` marks a pending (unfinished) share.
        """

    @abstractmethod
    def claim_key_release(self, file_id: str, v_hex: str) -> Optional[str]:
        """
        Atomically verify the verifier and release the server half H.

        The verifier comparison MUST be constant-time
        (``secrets.compare_digest``) and the release itself MUST be a
        single conditional write
        (``UPDATE ... SET released_at=... WHERE released_at IS NULL``)
        so exactly one of any number of concurrent callers wins.

        Returns:
            The stored ``h`` when this call is the unique winner and the
            verifier matches; None on a verifier miss, an already
            released/unbound share, or a lost race.
        """

    @abstractmethod
    def record_key_attempt(self, file_id: str) -> Optional[int]:
        """
        Atomically increment the failed-attempts counter.

        Returns:
            The new attempts value, or None when no live share exists.
        """

    @abstractmethod
    def delete_key_share(self, file_id: str) -> bool:
        """
        Delete the key share (lockout burn or file cleanup).

        Deleting the share destroys H — the ciphertext becomes
        mathematically dead regardless of where copies survive.

        Returns:
            True when a row was removed.
        """

    @abstractmethod
    def truncate(self) -> None:
        """Remove every record. Used by tests to isolate state."""


class TokenStore(ABC):
    """Storage operations for API token records."""

    @abstractmethod
    def insert(self, doc: Mapping[str, Any], doc_id: Optional[int] = None) -> int:
        """
        Insert a token record.

        Args:
            doc: Field dict (``token_hash``, ``username``, ``created_at``, ...).
            doc_id: Explicit row id (used only by the db.json migration path).

        Returns:
            The row doc_id (int) — this is the public token id.
        """

    @abstractmethod
    def get_by_id(self, doc_id: int) -> Optional[Dict[str, Any]]:
        """Return the token with the given row id, or None."""

    @abstractmethod
    def get_by_token_hash(self, token_hash: str) -> Optional[Dict[str, Any]]:
        """Return the token with the given stored digest, or None."""

    @abstractmethod
    def get_by(self, **filters: Any) -> Optional[Dict[str, Any]]:
        """Return the first token where every named field equals its value."""

    @abstractmethod
    def list_by(self, **filters: Any) -> List[Dict[str, Any]]:
        """Return all tokens where every named field equals its value."""

    @abstractmethod
    def all(self) -> List[Dict[str, Any]]:
        """Return every token record."""

    @abstractmethod
    def update_fields(self, doc_id: int, fields: Mapping[str, Any]) -> bool:
        """Set the given fields on one token; True when a row was updated."""

    @abstractmethod
    def remove_by_id(self, doc_id: int) -> bool:
        """Delete one token by row id; True when a row was removed."""

    @abstractmethod
    def remove_by_ids(self, doc_ids: Iterable[int]) -> int:
        """Delete tokens by row ids; returns the number removed."""

    @abstractmethod
    def remove_by_hash(self, token_hash: str) -> bool:
        """Delete the token with the given stored digest."""

    @abstractmethod
    def purge_expired(self, now_iso: str) -> int:
        """
        Delete tokens whose stored ``expires_at`` is earlier than ``now_iso``.

        Tokens without a stored ``expires_at`` are left alone — the
        application-level fallback expiry is handled by tokens.py.

        Returns:
            Number of tokens removed.
        """

    @abstractmethod
    def truncate(self) -> None:
        """Remove every record. Used by tests to isolate state."""


class Backend(ABC):
    """
    A concrete storage backend: one FileStore + one TokenStore.

    Attributes:
        url: The canonicalized DATABASE_URL this backend was created from.
        files: FileStore implementation.
        tokens: TokenStore implementation.
        closed: True after close() — implementations should refuse work then.
    """

    url: str
    files: FileStore
    tokens: TokenStore
    closed: bool = False

    @abstractmethod
    def close(self) -> None:
        """Release any held connections/resources and mark the backend closed."""
