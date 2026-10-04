"""
Data models and repository pattern for Buzzdrop.
Provides abstraction over database operations — the public facade stays
stable while the actual storage lives behind the FileStore interface
(see db/base.py).
"""
import secrets
import uuid
from datetime import datetime
from typing import Optional, List, Iterable, Tuple

from db import FileStore


class FileRepository:
    """Repository for file database operations."""

    def __init__(self, files_store: Optional[FileStore] = None):
        """
        Initialize file repository.

        Args:
            files_store: FileStore implementation (optional, will use
                get_files_store() if not provided)
        """
        self._store = files_store

    @property
    def store(self) -> FileStore:
        """Get the files store, using get_files_store if not set."""
        if self._store is None:
            from app import get_files_store
            return get_files_store()
        return self._store

    def record_decryption_result(self, file_id: str, success: bool) -> bool:
        """
        Record the decryption outcome — first receipt-valid report wins.

        Returns:
            True when this call wrote the outcome.
        """
        return self.store.record_decryption_result(file_id, success)

    def create(self, file_data: dict, file_id: Optional[str] = None) -> str:
        """
        Create a new file entry.

        Args:
            file_data: Dictionary with file information
                Required: original_name, path, uploaded_by
                Optional: expiry_at, type, shared_with
            file_id: Optional file ID (if not provided, generates UUID)

        Returns:
            File ID (UUID string)
        """
        if file_id is None:
            file_id = str(uuid.uuid4())

        entry = {
            'id': file_id,
            'original_name': file_data['original_name'],
            'path': file_data['path'],
            'created_at': datetime.now().isoformat(),
            'downloaded_at': None,
            'uploaded_by': file_data['uploaded_by'],
            'expiry_at': file_data.get('expiry_at'),
            'status': 'active',
            'decryption_success': None,
            'type': file_data.get('type', 'file'),
            'private_note': file_data.get('private_note'),
            'shared_with': file_data.get('shared_with', []),
            'notify_on_open': file_data.get('notify_on_open', False),
            'notification_email': file_data.get('notification_email'),
            'notification_sent_at': file_data.get('notification_sent_at'),
            'notification_claimed_at': file_data.get('notification_claimed_at'),
            'receipt_hash': file_data.get('receipt_hash'),
        }

        self.store.insert(entry)
        return file_id

    def get_by_id(self, file_id: str) -> Optional[dict]:
        """
        Get file by ID.

        Args:
            file_id: File UUID

        Returns:
            File dictionary or None if not found
        """
        return self.store.get_by_id(file_id)

    def get_user_files(self, username: str) -> List[dict]:
        """
        Get all files uploaded by a user.

        Args:
            username: Username

        Returns:
            List of file dictionaries
        """
        return self.store.list_by(uploaded_by=username)

    def get_user_files_by_ids(self, username: str,
                              file_ids: Iterable[str]) -> List[dict]:
        """
        Get files uploaded by a user, restricted to the given file ids.

        Args:
            username: Username
            file_ids: Iterable of file UUIDs

        Returns:
            List of file dictionaries (uploaded_by == username and id in file_ids)
        """
        wanted = set(file_ids)
        if not wanted:
            return []
        return [
            file_info for file_info in self.store.list_by(uploaded_by=username)
            if file_info.get('id') in wanted
        ]

    def get_shared_files(self, username: str) -> List[dict]:
        """
        Get files shared with a user (excluding files uploaded by the user).

        Args:
            username: Username

        Returns:
            List of file dictionaries
        """
        return [
            file_info for file_info in self.store.all()
            if username in (file_info.get('shared_with') or [])
            and file_info.get('uploaded_by') != username
        ]

    def get_all_active(self) -> List[dict]:
        """
        Get all active (non-expired) files.

        Returns:
            List of active file dictionaries
        """
        return self.store.list_by(status='active')

    def get_all(self) -> List[dict]:
        """
        Get all files.

        Returns:
            List of all file dictionaries
        """
        return self.store.all()

    def mark_downloaded(self, file_id: str, ip_address: str) -> bool:
        """
        Atomically claim the file as downloaded.

        Runs as a single conditional UPDATE (``WHERE id = ? AND
        downloaded_at IS NULL``), so only the first of any concurrent
        requests wins the claim.

        Args:
            file_id: File UUID
            ip_address: IP address of downloader

        Returns:
            True when this call won the download claim, False otherwise
        """
        return self.store.claim_download(file_id, ip_address)

    def mark_expired(self, file_id: str):
        """
        Mark file as expired.

        Args:
            file_id: File UUID
        """
        self.store.update_fields(file_id, {'status': 'expired'})

    def delete(self, file_id: str):
        """
        Delete file entry from database.

        Also drops the key-release share when present — a deleted share
        must not leave its server half behind.

        Args:
            file_id: File UUID
        """
        self.store.delete(file_id)
        self.store.delete_key_share(file_id)

    # -- server-gated key release ----------------------------------

    def create_key_share(self, created_by: Optional[str] = None
                         ) -> Tuple[str, str]:
        """
        Begin a two-phase key-release upload: mint a file_id plus the random
        32-byte server share H, and persist the pending share bound to
        the uploader's username.

        Returns:
            (file_id, h_hex) — H leaves the server exactly twice in its
            lifetime: here to the uploader's browser (it holds the
            plaintext anyway) and once via attempt_key_release.
        """
        file_id = str(uuid.uuid4())
        h_hex = secrets.token_hex(32)
        self.store.create_key_share(file_id, h_hex, created_by=created_by)
        return file_id, h_hex

    def get_key_share(self, file_id: str) -> Optional[dict]:
        """Return the key-share record for a file_id, or None."""
        return self.store.get_key_share(file_id)

    def bind_key_verifier(self, file_id: str, v_hex: str) -> bool:
        """Bind the password verifier to a pending share."""
        return self.store.bind_key_verifier(file_id, v_hex)

    def attempt_key_release(self, file_id: str, v_hex: str,
                            max_attempts: int,
                            burn_on_lockout: bool) -> dict:
        """
        One atomic release attempt — see FileStore.attempt_key_release.

        Returns:
            The store's structured result dict (status + payload).
        """
        return self.store.attempt_key_release(
            file_id, v_hex, max_attempts, burn_on_lockout)

    def purge_stale_key_shares(self, older_than_seconds: int) -> int:
        """Delete pending shares older than the TTL; returns the count."""
        return self.store.purge_stale_key_shares(older_than_seconds)

    def burn_key_share(self, file_id: str) -> bool:
        """Destroy the share (and with it H) on lockout burn or expiry."""
        return self.store.burn_key_share(file_id)

    def mark_notification_sent(self, file_id: str):
        """Mark uploader notification as sent."""
        self.store.update_fields(file_id, {
            'notification_sent_at': datetime.now().isoformat(),
            'notification_claimed_at': None,
        })

    def claim_notification_send(self, file_id: str) -> bool:
        """Claim a pending notification send slot for a share."""
        return self.store.claim_notification_send(file_id)

    def clear_notification_claim(self, file_id: str):
        """Release a notification claim after a failed send attempt."""
        self.store.update_fields(file_id, {'notification_claimed_at': None})

    def get_downloaded_before(self, cutoff_datetime: datetime) -> List[dict]:
        """
        Get files downloaded before a certain datetime.

        Args:
            cutoff_datetime: Cutoff datetime

        Returns:
            List of file dictionaries
        """
        cutoff_iso = cutoff_datetime.isoformat()
        return [
            file_info for file_info in self.store.all()
            if file_info.get('downloaded_at')
            and file_info['downloaded_at'] < cutoff_iso
        ]
