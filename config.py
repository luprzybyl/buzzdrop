"""
Configuration module for Buzzdrop application.
Centralizes all configuration settings from environment variables.
"""
import os
from typing import Set


class Config:
    """Base configuration class."""
    
    # Flask settings
    SECRET_KEY = os.getenv('FLASK_SECRET_KEY')
    
    # Database
    DATABASE_PATH = os.getenv('DATABASE_PATH', 'db.json')
    
    # Upload settings
    UPLOAD_FOLDER = os.getenv('UPLOAD_FOLDER', 'uploads')
    MAX_CONTENT_LENGTH = int(os.getenv('MAX_CONTENT_LENGTH', str(16 * 1024 * 1024)))
    ALLOWED_EXTENSIONS: Set[str] = set(
        os.getenv('ALLOWED_EXTENSIONS', 'txt,pdf,png,jpg,jpeg,gif,doc,docx,xls,xlsx').split(',')
    )
    
    # Storage backend
    STORAGE_BACKEND = os.getenv('STORAGE_BACKEND', 'local')  # 'local' or 's3'
    
    # S3 configuration (if using S3 backend)
    S3_BUCKET = os.getenv('S3_BUCKET')
    S3_ACCESS_KEY = os.getenv('S3_ACCESS_KEY')
    S3_SECRET_KEY = os.getenv('S3_SECRET_KEY')
    S3_REGION = os.getenv('S3_REGION', 'us-east-1')
    
    # Timezone
    DEFAULT_TIMEZONE = os.getenv('DEFAULT_TIMEZONE', 'Europe/Warsaw')
    
    @classmethod
    def validate(cls):
        """
        Validate required configuration values.
        
        Raises:
            ValueError: If required configuration is missing or invalid
        """
        # Check secret key in production
        if not cls.SECRET_KEY and os.getenv('FLASK_ENV') == 'production':
            raise ValueError("FLASK_SECRET_KEY must be set in production environment")
        
        # Validate S3 configuration if using S3 backend
        if cls.STORAGE_BACKEND == 's3':
            if not all([cls.S3_BUCKET, cls.S3_ACCESS_KEY, cls.S3_SECRET_KEY]):
                raise ValueError(
                    "S3 configuration incomplete. Required: S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY"
                )
        
        # Validate max content length
        if cls.MAX_CONTENT_LENGTH < 1024:  # Minimum 1KB
            raise ValueError("MAX_CONTENT_LENGTH must be at least 1024 bytes")
    
    @classmethod
    def get_display_info(cls) -> dict:
        """
        Get configuration info suitable for logging/display.
        Sanitizes sensitive information.
        
        Returns:
            Dictionary with safe configuration values
        """
        return {
            'storage_backend': cls.STORAGE_BACKEND,
            'upload_folder': cls.UPLOAD_FOLDER if cls.STORAGE_BACKEND == 'local' else 'N/A',
            'database_path': cls.DATABASE_PATH,
            'max_file_size_mb': cls.MAX_CONTENT_LENGTH / (1024 * 1024),
            'allowed_extensions': ', '.join(sorted(cls.ALLOWED_EXTENSIONS)),
            's3_configured': bool(cls.S3_BUCKET) if cls.STORAGE_BACKEND == 's3' else False,
            's3_region': cls.S3_REGION if cls.STORAGE_BACKEND == 's3' else 'N/A',
        }


class DevelopmentConfig(Config):
    """Development environment configuration."""
    DEBUG = True
    TESTING = False


class TestingConfig(Config):
    """Testing environment configuration."""
    TESTING = True
    DEBUG = True
    # Tests will override DATABASE_PATH in conftest.py


class ProductionConfig(Config):
    """Production environment configuration."""
    DEBUG = False
    TESTING = False


def get_config():
    """
    Get configuration based on FLASK_ENV environment variable.
    
    Returns:
        Config class appropriate for current environment
    """
    env = os.getenv('FLASK_ENV', 'development').lower()
    
    config_map = {
        'development': DevelopmentConfig,
        'testing': TestingConfig,
        'production': ProductionConfig,
    }
    
    return config_map.get(env, DevelopmentConfig)
