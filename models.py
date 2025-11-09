"""
Data models and repository pattern for Buzzdrop.
Provides abstraction over database operations.
"""
import uuid
from datetime import datetime
from typing import Optional, List
from tinydb import Query


class FileRepository:
    """Repository for file database operations."""
    
    def __init__(self, files_table=None):
        """
        Initialize file repository.
        
        Args:
            files_table: TinyDB table instance (optional, will use get_files_table if not provided)
        """
        self._table = files_table
        self.query = Query()
    
    @property
    def table(self):
        """Get files table, using get_files_table if not set."""
        if self._table is None:
            from app import get_files_table
            return get_files_table()
        return self._table
    
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
            'shared_with': file_data.get('shared_with', []),
        }
        
        self.table.insert(entry)
        return file_id
    
    def get_by_id(self, file_id: str) -> Optional[dict]:
        """
        Get file by ID.
        
        Args:
            file_id: File UUID
        
        Returns:
            File dictionary or None if not found
        """
        return self.table.get(self.query.id == file_id)
    
    def get_user_files(self, username: str) -> List[dict]:
        """
        Get all files uploaded by a user.
        
        Args:
            username: Username
        
        Returns:
            List of file dictionaries
        """
        return self.table.search(self.query.uploaded_by == username)
    
    def get_shared_files(self, username: str) -> List[dict]:
        """
        Get files shared with a user (excluding files uploaded by the user).
        
        Args:
            username: Username
        
        Returns:
            List of file dictionaries
        """
        return self.table.search(
            (self.query.shared_with.any([username])) &
            (self.query.uploaded_by != username)
        )
    
    def get_all_active(self) -> List[dict]:
        """
        Get all active (non-expired) files.
        
        Returns:
            List of active file dictionaries
        """
        return self.table.search(self.query.status == 'active')
    
    def get_all(self) -> List[dict]:
        """
        Get all files.
        
        Returns:
            List of all file dictionaries
        """
        return self.table.all()
    
    def mark_downloaded(self, file_id: str, ip_address: str):
        """
        Mark file as downloaded with timestamp and IP address.
        
        Args:
            file_id: File UUID
            ip_address: IP address of downloader
        """
        self.table.update({
            'downloaded_at': datetime.now().isoformat(),
            'downloaded_by_ip': ip_address
        }, self.query.id == file_id)
    
    def mark_expired(self, file_id: str):
        """
        Mark file as expired.
        
        Args:
            file_id: File UUID
        """
        self.table.update({'status': 'expired'}, self.query.id == file_id)
    
    def update_decryption_status(self, file_id: str, success: bool):
        """
        Update decryption success status.
        
        Args:
            file_id: File UUID
            success: Whether decryption was successful
        """
        self.table.update({'decryption_success': success}, self.query.id == file_id)
    
    def delete(self, file_id: str):
        """
        Delete file entry from database.
        
        Args:
            file_id: File UUID
        """
        self.table.remove(self.query.id == file_id)
    
    def get_downloaded_before(self, cutoff_datetime: datetime) -> List[dict]:
        """
        Get files downloaded before a certain datetime.
        
        Args:
            cutoff_datetime: Cutoff datetime
        
        Returns:
            List of file dictionaries
        """
        cutoff_iso = cutoff_datetime.isoformat()
        
        def is_before_cutoff(file_dict):
            downloaded_at = file_dict.get('downloaded_at')
            if not downloaded_at:
                return False
            return downloaded_at < cutoff_iso
        
        return self.table.search(self.query.downloaded_at.test(lambda x: x is not None and x < cutoff_iso))
