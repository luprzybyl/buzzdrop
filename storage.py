"""
Storage backend abstraction for Buzzdrop.
Provides unified interface for local and S3 storage.
"""
import os
from abc import ABC, abstractmethod
from io import BytesIO
from typing import Iterator
import boto3
from botocore.exceptions import ClientError


class StorageBackend(ABC):
    """Abstract base class for storage backends."""
    
    @property
    @abstractmethod
    def backend_type(self) -> str:
        """Return the type of storage backend ('local' or 's3')."""
        pass
    
    @abstractmethod
    def save(self, file_id: str, file_data) -> str:
        """
        Save file data and return storage path.
        
        Args:
            file_id: Unique identifier for the file
            file_data: File-like object or bytes to save
        
        Returns:
            Storage path/key for the saved file
        
        Raises:
            StorageError: If save operation fails
        """
        pass
    
    @abstractmethod
    def retrieve(self, path: str) -> Iterator[bytes]:
        """
        Retrieve file data as an iterator of chunks.
        
        Args:
            path: Storage path/key for the file
        
        Yields:
            Chunks of file data (bytes)
        
        Raises:
            StorageError: If file not found or retrieval fails
        """
        pass
    
    @abstractmethod
    def delete(self, path: str) -> None:
        """
        Delete file from storage.
        
        Args:
            path: Storage path/key for the file
        
        Raises:
            StorageError: If deletion fails (file not found is not an error)
        """
        pass
    
    @abstractmethod
    def exists(self, path: str) -> bool:
        """
        Check if file exists in storage.
        
        Args:
            path: Storage path/key for the file
        
        Returns:
            True if file exists, False otherwise
        """
        pass


class LocalStorage(StorageBackend):
    """Local filesystem storage backend."""
    
    def __init__(self, upload_folder: str):
        """
        Initialize local storage backend.
        
        Args:
            upload_folder: Path to directory for storing files
        """
        self.upload_folder = upload_folder
        os.makedirs(self.upload_folder, exist_ok=True)
    
    @property
    def backend_type(self) -> str:
        return 'local'
    
    def save(self, file_id: str, file_data) -> str:
        """Save file to local filesystem."""
        file_path = os.path.join(self.upload_folder, file_id)
        
        try:
            # Handle both file-like objects and bytes
            if isinstance(file_data, bytes):
                with open(file_path, 'wb') as f:
                    f.write(file_data)
            else:
                # Assume file-like object
                file_data.save(file_path)
            
            return file_path
        
        except Exception as e:
            raise StorageError(f"Failed to save file {file_id}: {str(e)}") from e
    
    def retrieve(self, path: str) -> Iterator[bytes]:
        """Retrieve file from local filesystem in chunks."""
        try:
            with open(path, 'rb') as f:
                while True:
                    chunk = f.read(8192)  # 8KB chunks
                    if not chunk:
                        break
                    yield chunk
        
        except FileNotFoundError as e:
            raise StorageError(f"File not found: {path}") from e
        except Exception as e:
            raise StorageError(f"Failed to retrieve file {path}: {str(e)}") from e
    
    def delete(self, path: str) -> None:
        """Delete file from local filesystem."""
        try:
            if os.path.exists(path):
                os.remove(path)
        except Exception as e:
            # Log error but don't raise - file might already be deleted
            pass
    
    def exists(self, path: str) -> bool:
        """Check if file exists on local filesystem."""
        return os.path.exists(path)
    
    def list_files(self):
        """List all files in upload directory."""
        try:
            return os.listdir(self.upload_folder)
        except Exception:
            return []


class S3Storage(StorageBackend):
    """Amazon S3 storage backend."""
    
    def __init__(self, bucket: str, access_key: str, secret_key: str, region: str = 'us-east-1'):
        """
        Initialize S3 storage backend.
        
        Args:
            bucket: S3 bucket name
            access_key: AWS access key ID
            secret_key: AWS secret access key
            region: AWS region (default: us-east-1)
        """
        self.bucket = bucket
        self.client = boto3.client(
            's3',
            aws_access_key_id=access_key,
            aws_secret_access_key=secret_key,
            region_name=region
        )
        self.region = region
    
    @property
    def backend_type(self) -> str:
        return 's3'
    
    def _get_s3_key(self, file_id: str) -> str:
        """Generate S3 key for a file ID."""
        return f"uploads/{file_id}"
    
    def save(self, file_id: str, file_data) -> str:
        """Save file to S3."""
        s3_key = self._get_s3_key(file_id)
        
        try:
            # Handle both file-like objects and bytes
            if isinstance(file_data, bytes):
                self.client.upload_fileobj(BytesIO(file_data), self.bucket, s3_key)
            else:
                # Assume file-like object (Flask FileStorage)
                self.client.upload_fileobj(file_data, self.bucket, s3_key)
            
            return s3_key
        
        except ClientError as e:
            raise StorageError(f"S3 upload failed for {file_id}: {str(e)}") from e
        except Exception as e:
            raise StorageError(f"Failed to save file {file_id}: {str(e)}") from e
    
    def retrieve(self, s3_key: str) -> Iterator[bytes]:
        """Retrieve file from S3 in chunks."""
        try:
            response = self.client.get_object(Bucket=self.bucket, Key=s3_key)
            
            # Stream the response body in chunks
            for chunk in iter(lambda: response['Body'].read(8192), b''):
                yield chunk
        
        except ClientError as e:
            if e.response['Error']['Code'] == 'NoSuchKey':
                raise StorageError(f"File not found in S3: {s3_key}") from e
            raise StorageError(f"S3 retrieval failed for {s3_key}: {str(e)}") from e
        except Exception as e:
            raise StorageError(f"Failed to retrieve file {s3_key}: {str(e)}") from e
    
    def delete(self, s3_key: str) -> None:
        """Delete file from S3."""
        try:
            self.client.delete_object(Bucket=self.bucket, Key=s3_key)
        except Exception:
            # Log error but don't raise - file might already be deleted
            pass
    
    def exists(self, s3_key: str) -> bool:
        """Check if file exists in S3."""
        try:
            self.client.head_object(Bucket=self.bucket, Key=s3_key)
            return True
        except ClientError:
            return False
    
    def test_connection(self) -> bool:
        """
        Test S3 connection by listing buckets.
        
        Returns:
            True if connection successful, False otherwise
        """
        try:
            self.client.list_buckets()
            return True
        except Exception:
            return False


class StorageError(Exception):
    """Exception raised for storage operation errors."""
    pass


def get_storage_backend(config) -> StorageBackend:
    """
    Factory function to create appropriate storage backend.
    
    Args:
        config: Configuration object or dict with storage settings
    
    Returns:
        StorageBackend instance (LocalStorage or S3Storage)
    
    Raises:
        ValueError: If storage backend configuration is invalid
    """
    # Handle both Config class and dict
    if hasattr(config, 'STORAGE_BACKEND'):
        backend_type = config.STORAGE_BACKEND
    else:
        backend_type = config.get('STORAGE_BACKEND', 'local')
    
    if backend_type == 's3':
        # Get S3 configuration
        if hasattr(config, 'S3_BUCKET'):
            bucket = config.S3_BUCKET
            access_key = config.S3_ACCESS_KEY
            secret_key = config.S3_SECRET_KEY
            region = config.S3_REGION
        else:
            bucket = config.get('S3_BUCKET')
            access_key = config.get('S3_ACCESS_KEY')
            secret_key = config.get('S3_SECRET_KEY')
            region = config.get('S3_REGION', 'us-east-1')
        
        if not all([bucket, access_key, secret_key]):
            raise ValueError("S3 configuration incomplete")
        
        return S3Storage(bucket, access_key, secret_key, region)
    
    elif backend_type == 'local':
        # Get upload folder
        if hasattr(config, 'UPLOAD_FOLDER'):
            upload_folder = config.UPLOAD_FOLDER
        else:
            upload_folder = config.get('UPLOAD_FOLDER', 'uploads')
        
        return LocalStorage(upload_folder)
    
    else:
        raise ValueError(f"Unknown storage backend: {backend_type}")


def print_backend_info(storage: StorageBackend):
    """
    Print storage backend information on startup.
    
    Args:
        storage: Storage backend instance
    """
    print(f"\n[Startup] Storage backend: {storage.backend_type}")
    
    if isinstance(storage, S3Storage):
        if storage.test_connection():
            print(f"[Startup] S3 connection OK (region: {storage.region})")
            print(f"[Startup] Using S3 bucket: {storage.bucket}")
        else:
            print("[Startup] S3 connection FAILED - check credentials and permissions")
    
    elif isinstance(storage, LocalStorage):
        print(f"[Startup] Using local storage: {storage.upload_folder}")
