"""
Configuration module for Buzzdrop application.
Centralizes all configuration settings from environment variables.
"""
import os
from typing import Optional, Set


def _env_bool(name: str, default: bool) -> bool:
    """Read a boolean environment variable."""
    return os.getenv(name, str(default)).strip().lower() in {'1', 'true', 'yes', 'on'}


# Values copied verbatim from .env.example are not credentials.
_PLACEHOLDER_VALUES = {
    'changeme', 'change-me', 'change_me', 'placeholder', 'todo', 'xxx',
    'bucketname', 'bucket-name', 'accesskey', 'secretkey',
}


def _looks_like_placeholder(value: Optional[str]) -> bool:
    """Heuristic: does this config value look like a shipped placeholder?"""
    if not value:
        return False
    v = value.strip().lower()
    return (
        v in _PLACEHOLDER_VALUES
        or v.startswith('your')          # youraccesskey, your-secret-key, ...
        or v.startswith('<') and v.endswith('>')  # <access-key>
        or 'example' in v                # example-bucket, key@example.com
    )


class Config:
    """Base configuration class."""
    
    # Flask settings
    SECRET_KEY = os.getenv('FLASK_SECRET_KEY')
    TOKEN_HASH_SECRET = os.getenv('TOKEN_HASH_SECRET')
    
    # Database — scheme selects the storage backend (sqlite:// only for now)
    DATABASE_URL = os.getenv('DATABASE_URL')
    # Deprecated: plain file path; used to build a sqlite:/// URL when
    # DATABASE_URL is not set.
    DATABASE_PATH = os.getenv('DATABASE_PATH', 'buzzdrop.db')
    
    # Session cookie hardening.
    # SESSION_COOKIE_SECURE defaults to True (production-safe); development
    # and testing default it to False because the app is commonly served
    # over plain HTTP there — set SESSION_COOKIE_SECURE=true to override.
    SESSION_COOKIE_SECURE = _env_bool('SESSION_COOKIE_SECURE', True)
    SESSION_COOKIE_HTTPONLY = _env_bool('SESSION_COOKIE_HTTPONLY', True)
    SESSION_COOKIE_SAMESITE = os.getenv('SESSION_COOKIE_SAMESITE', 'Lax')
    # Lifetime of permanent sessions, in seconds (default 8 hours).
    PERMANENT_SESSION_LIFETIME = int(os.getenv('PERMANENT_SESSION_LIFETIME', str(8 * 3600)))

    # Upload settings
    UPLOAD_FOLDER = os.getenv('UPLOAD_FOLDER', 'uploads')
    MAX_CONTENT_LENGTH = int(os.getenv('MAX_CONTENT_LENGTH', str(100 * 1024 * 1024)))
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

    # Email notifications
    SMTP_HOST = os.getenv('SMTP_HOST')
    SMTP_PORT = int(os.getenv('SMTP_PORT', '587'))
    SMTP_USERNAME = os.getenv('SMTP_USERNAME')
    SMTP_PASSWORD = os.getenv('SMTP_PASSWORD')
    SMTP_FROM_EMAIL = os.getenv('SMTP_FROM_EMAIL')
    SMTP_USE_TLS = _env_bool('SMTP_USE_TLS', True)
    SMTP_USE_SSL = _env_bool('SMTP_USE_SSL', False)
    SMTP_TIMEOUT_SECONDS = int(os.getenv('SMTP_TIMEOUT_SECONDS', '10'))
    # Rate limiting
    RATE_LIMIT_ENABLED = _env_bool('RATE_LIMIT_ENABLED', True)
    RATE_LIMIT_HEADERS_ENABLED = _env_bool('RATE_LIMIT_HEADERS_ENABLED', True)
    RATE_LIMIT_STORAGE_URI = os.getenv('RATE_LIMIT_STORAGE_URI', 'memory://')
    LOGIN_RATE_LIMIT = os.getenv('LOGIN_RATE_LIMIT', '10 per minute')
    API_TOKEN_RATE_LIMIT = os.getenv('API_TOKEN_RATE_LIMIT', '10 per hour')
    # Two-phase upload: /upload/begin and /upload share this bucket —
    # one file costs 2 hits.
    UPLOAD_RATE_LIMIT = os.getenv('UPLOAD_RATE_LIMIT', '30 per hour')
    PUBLIC_FILE_RATE_LIMIT = os.getenv('PUBLIC_FILE_RATE_LIMIT', '60 per hour')
    # /report_decryption is unauthenticated — the receipt is the
    # credential — so cap it per file_id like /release.
    REPORT_DECRYPTION_RATE_LIMIT = os.getenv(
        'REPORT_DECRYPTION_RATE_LIMIT', '10 per minute')

    # Server-gated key release (docs/true-one-time.md §6) — the only
    # share format, no opt-out: uploads split the file key, the server
    # holds a random 32-byte share H and releases it exactly once,
    # after the recipient proves the password via a one-way verifier V.
    # Per-file_id rate limit on /release (rotating IPs don't help).
    KEY_RELEASE_RATE_LIMIT = os.getenv('KEY_RELEASE_RATE_LIMIT', '10 per minute')
    # Total failed verifier attempts a share tolerates before lockout.
    KEY_RELEASE_MAX_ATTEMPTS = int(os.getenv('KEY_RELEASE_MAX_ATTEMPTS', '1'))
    # What lockout does to the share: burn destroys H+V (the ciphertext
    # is mathematically dead — confidentiality over availability);
    # False keeps the row but permanently refuses releases — there is
    # currently no unlock path, so that also bricks the share in
    # practice. Strict by default per owner; kept as an option for a
    # future unlock path.
    KEY_RELEASE_BURN_ON_LOCKOUT = _env_bool('KEY_RELEASE_BURN_ON_LOCKOUT', True)
    # TTL for pending shares (/upload/begin done, /upload never finished).
    # Older unbound shares are purged at startup and on each begin call.
    KEY_SHARE_PENDING_TTL_SECONDS = int(
        os.getenv('KEY_SHARE_PENDING_TTL_SECONDS', '3600'))

    # Expired drops are always swept once at startup. This interval
    # (seconds) additionally re-sweeps on a daemon thread, so a drop
    # nobody ever opens still loses its ciphertext and key share.
    # 0 disables the periodic sweep.
    EXPIRY_SWEEP_INTERVAL_SECONDS = int(
        os.getenv('EXPIRY_SWEEP_INTERVAL_SECONDS', '300'))

    # AGPL-3.0 §13: users of a modified Buzzdrop served over the network
    # must be offered its source. The footer links here; a deployment
    # running changed code points this at its own repository.
    SOURCE_CODE_URL = os.getenv(
        'SOURCE_CODE_URL', 'https://github.com/luprzybyl/buzzdrop')

    @classmethod
    def validate(cls):
        """
        Validate required configuration values.
        
        Raises:
            ValueError: If required configuration is missing or invalid
        """
        is_production = os.getenv('FLASK_ENV', '').strip().lower() == 'production'

        # Check secret key in production
        if not cls.SECRET_KEY and is_production:
            raise ValueError("FLASK_SECRET_KEY must be set in production environment")

        # One secret must not protect both session cookies and token hashes:
        # require a dedicated TOKEN_HASH_SECRET in production. Outside
        # production a FLASK_SECRET_KEY fallback is tolerated (tokens.py).
        if is_production:
            if not cls.TOKEN_HASH_SECRET:
                raise ValueError(
                    "TOKEN_HASH_SECRET must be set in production — refusing to reuse "
                    "FLASK_SECRET_KEY for API token hashing"
                )
            if cls.TOKEN_HASH_SECRET == cls.SECRET_KEY:
                raise ValueError(
                    "TOKEN_HASH_SECRET must differ from FLASK_SECRET_KEY"
                )

        # Validate S3 configuration if using S3 backend
        if cls.STORAGE_BACKEND == 's3':
            if not all([cls.S3_BUCKET, cls.S3_ACCESS_KEY, cls.S3_SECRET_KEY]):
                raise ValueError(
                    "S3 configuration incomplete. Required: S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY"
                )
            for name, value in (
                ('S3_BUCKET', cls.S3_BUCKET),
                ('S3_ACCESS_KEY', cls.S3_ACCESS_KEY),
                ('S3_SECRET_KEY', cls.S3_SECRET_KEY),
            ):
                if _looks_like_placeholder(value):
                    raise ValueError(
                        f"{name} looks like a placeholder value — set real "
                        "credentials when STORAGE_BACKEND=s3"
                    )

        # Session cookie validation
        samesite = (cls.SESSION_COOKIE_SAMESITE or '').strip().lower()
        if samesite not in {'lax', 'strict', 'none'}:
            raise ValueError(
                "SESSION_COOKIE_SAMESITE must be one of: Lax, Strict, None"
            )
        if samesite == 'none' and not cls.SESSION_COOKIE_SECURE:
            raise ValueError(
                "SESSION_COOKIE_SAMESITE=None requires SESSION_COOKIE_SECURE=true"
            )
        if cls.PERMANENT_SESSION_LIFETIME < 60:
            raise ValueError("PERMANENT_SESSION_LIFETIME must be at least 60 seconds")

        # Validate max content length
        if cls.MAX_CONTENT_LENGTH < 1024:  # Minimum 1KB
            raise ValueError("MAX_CONTENT_LENGTH must be at least 1024 bytes")

        if cls.SMTP_PORT < 1:
            raise ValueError("SMTP_PORT must be greater than 0")

        if cls.SMTP_TIMEOUT_SECONDS < 1:
            raise ValueError("SMTP_TIMEOUT_SECONDS must be greater than 0")

        if cls.SMTP_USE_TLS and cls.SMTP_USE_SSL:
            raise ValueError("SMTP_USE_TLS and SMTP_USE_SSL cannot both be enabled")

        if cls.KEY_RELEASE_MAX_ATTEMPTS < 1:
            raise ValueError("KEY_RELEASE_MAX_ATTEMPTS must be at least 1")

        if cls.EXPIRY_SWEEP_INTERVAL_SECONDS < 0:
            raise ValueError("EXPIRY_SWEEP_INTERVAL_SECONDS must be 0 or greater")

    @classmethod
    def get_database_url(cls) -> str:
        """
        Resolve the effective DATABASE_URL.

        DATABASE_URL wins; otherwise the deprecated DATABASE_PATH is wrapped
        in a sqlite:/// URL.
        """
        if cls.DATABASE_URL:
            return cls.DATABASE_URL
        return f'sqlite:///{cls.DATABASE_PATH or "buzzdrop.db"}'

    @staticmethod
    def _sanitize_database_url(url: str) -> str:
        """Strip credentials from a DATABASE_URL before logging it."""
        try:
            from urllib.parse import urlsplit, urlunsplit
            parts = urlsplit(url)
        except ValueError:
            return url
        if not parts.password:
            return url
        netloc = parts.username or ''
        netloc += ':***'
        if parts.hostname:
            netloc += f'@{parts.hostname}'
        if parts.port:
            netloc += f':{parts.port}'
        return urlunsplit((parts.scheme, netloc, parts.path,
                           parts.query, parts.fragment))

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
            'database_url': cls._sanitize_database_url(cls.get_database_url()),
            'max_file_size_mb': cls.MAX_CONTENT_LENGTH / (1024 * 1024),
            'allowed_extensions': ', '.join(sorted(cls.ALLOWED_EXTENSIONS)),
            'rate_limit_enabled': cls.RATE_LIMIT_ENABLED,
            'login_rate_limit': cls.LOGIN_RATE_LIMIT,
            'api_token_rate_limit': cls.API_TOKEN_RATE_LIMIT,
            'upload_rate_limit': cls.UPLOAD_RATE_LIMIT,
            'public_file_rate_limit': cls.PUBLIC_FILE_RATE_LIMIT,
            'expiry_sweep_interval_seconds': cls.EXPIRY_SWEEP_INTERVAL_SECONDS,
            'report_decryption_rate_limit': cls.REPORT_DECRYPTION_RATE_LIMIT,
            's3_configured': bool(cls.S3_BUCKET) if cls.STORAGE_BACKEND == 's3' else False,
            's3_region': cls.S3_REGION if cls.STORAGE_BACKEND == 's3' else 'N/A',
            'email_notifications_configured': bool(cls.SMTP_HOST and cls.SMTP_FROM_EMAIL),
        }


class DevelopmentConfig(Config):
    """Development environment configuration."""
    DEBUG = True
    TESTING = False
    # Local dev usually runs over plain HTTP — allow cookies without TLS.
    # SESSION_COOKIE_SECURE env var still overrides when set explicitly.
    SESSION_COOKIE_SECURE = _env_bool('SESSION_COOKIE_SECURE', False)
    LOGIN_RATE_LIMIT = os.getenv('LOGIN_RATE_LIMIT', '100 per minute')
    API_TOKEN_RATE_LIMIT = os.getenv('API_TOKEN_RATE_LIMIT', '60 per hour')
    UPLOAD_RATE_LIMIT = os.getenv('UPLOAD_RATE_LIMIT', '120 per hour')
    PUBLIC_FILE_RATE_LIMIT = os.getenv('PUBLIC_FILE_RATE_LIMIT', '240 per hour')
    REPORT_DECRYPTION_RATE_LIMIT = os.getenv('REPORT_DECRYPTION_RATE_LIMIT', '100 per minute')


class TestingConfig(Config):
    """Testing environment configuration."""
    TESTING = True
    DEBUG = True
    # The test client speaks plain HTTP.
    SESSION_COOKIE_SECURE = _env_bool('SESSION_COOKIE_SECURE', False)
    # Tests will override DATABASE_URL in conftest.py
    LOGIN_RATE_LIMIT = os.getenv('LOGIN_RATE_LIMIT', '1000 per minute')
    API_TOKEN_RATE_LIMIT = os.getenv('API_TOKEN_RATE_LIMIT', '1000 per hour')
    UPLOAD_RATE_LIMIT = os.getenv('UPLOAD_RATE_LIMIT', '1000 per hour')
    PUBLIC_FILE_RATE_LIMIT = os.getenv('PUBLIC_FILE_RATE_LIMIT', '1000 per hour')
    KEY_RELEASE_RATE_LIMIT = os.getenv('KEY_RELEASE_RATE_LIMIT', '1000 per hour')
    REPORT_DECRYPTION_RATE_LIMIT = os.getenv('REPORT_DECRYPTION_RATE_LIMIT', '1000 per hour')


class ProductionConfig(Config):
    """Production environment configuration."""
    DEBUG = False
    TESTING = False
    LOGIN_RATE_LIMIT = os.getenv('LOGIN_RATE_LIMIT', '10 per minute')
    API_TOKEN_RATE_LIMIT = os.getenv('API_TOKEN_RATE_LIMIT', '10 per hour')
    UPLOAD_RATE_LIMIT = os.getenv('UPLOAD_RATE_LIMIT', '30 per hour')
    PUBLIC_FILE_RATE_LIMIT = os.getenv('PUBLIC_FILE_RATE_LIMIT', '60 per hour')
    REPORT_DECRYPTION_RATE_LIMIT = os.getenv('REPORT_DECRYPTION_RATE_LIMIT', '10 per minute')


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
