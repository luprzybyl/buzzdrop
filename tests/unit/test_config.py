"""Unit tests for configuration validation and session cookie hardening."""
import os
import subprocess
import sys

import pytest

from config import Config, DevelopmentConfig, ProductionConfig, _looks_like_placeholder


@pytest.fixture
def s3_config(monkeypatch):
    """Config patched to STORAGE_BACKEND=s3 with real-looking credentials."""
    monkeypatch.setattr(Config, 'STORAGE_BACKEND', 's3')
    monkeypatch.setattr(Config, 'S3_BUCKET', 'real-bucket')
    monkeypatch.setattr(Config, 'S3_ACCESS_KEY', 'AKIAIOSFODNN7X71REAL')
    monkeypatch.setattr(Config, 'S3_SECRET_KEY', 'wJalrXUtnFEMI-K7MDENG-bPxRfiCY-real')


def test_session_cookie_defaults(app):
    assert app.config['SESSION_COOKIE_HTTPONLY'] is True
    assert app.config['SESSION_COOKIE_SAMESITE'] == 'Lax'
    assert app.config['PERMANENT_SESSION_LIFETIME'] == 8 * 3600


def test_session_cookie_secure_env_split():
    # Development defaults to non-Secure (plain HTTP dev); production
    # and the base config default to Secure.
    assert Config.SESSION_COOKIE_SECURE is True
    assert DevelopmentConfig.SESSION_COOKIE_SECURE is False
    assert ProductionConfig.SESSION_COOKIE_SECURE is True


def test_max_content_length_aligned_with_env_example(app):
    # .env.example ships MAX_CONTENT_LENGTH=104857600 — the code default
    # must match (100 MB).
    assert app.config['MAX_CONTENT_LENGTH'] == 100 * 1024 * 1024


def test_validate_requires_token_hash_secret_in_production(monkeypatch):
    monkeypatch.setenv('FLASK_ENV', 'production')
    monkeypatch.setattr(Config, 'SECRET_KEY', 'session-secret')
    monkeypatch.setattr(Config, 'TOKEN_HASH_SECRET', None)

    with pytest.raises(ValueError, match='TOKEN_HASH_SECRET must be set in production'):
        Config.validate()


def test_validate_rejects_token_hash_secret_equal_to_secret_key(monkeypatch):
    monkeypatch.setenv('FLASK_ENV', 'production')
    monkeypatch.setattr(Config, 'SECRET_KEY', 'shared-secret')
    monkeypatch.setattr(Config, 'TOKEN_HASH_SECRET', 'shared-secret')

    with pytest.raises(ValueError, match='must differ from FLASK_SECRET_KEY'):
        Config.validate()


def test_validate_allows_distinct_token_hash_secret_in_production(monkeypatch):
    monkeypatch.setenv('FLASK_ENV', 'production')
    monkeypatch.setattr(Config, 'SECRET_KEY', 'session-secret')
    monkeypatch.setattr(Config, 'TOKEN_HASH_SECRET', 'token-secret')

    Config.validate()


def test_validate_allows_token_secret_fallback_outside_production(monkeypatch):
    monkeypatch.setenv('FLASK_ENV', 'development')
    monkeypatch.setattr(Config, 'SECRET_KEY', 'session-secret')
    monkeypatch.setattr(Config, 'TOKEN_HASH_SECRET', None)

    Config.validate()


@pytest.mark.parametrize('placeholder', [
    'youraccesskey', 'your-access-key', 'changeme', 'change-me',
    '<access-key>', 'my-example-bucket', 'bucketname',
])
def test_validate_rejects_placeholder_s3_values(s3_config, monkeypatch, placeholder):
    monkeypatch.setattr(Config, 'S3_ACCESS_KEY', placeholder)

    with pytest.raises(ValueError, match='placeholder'):
        Config.validate()


def test_validate_accepts_real_s3_credentials(s3_config):
    Config.validate()


def test_validate_still_requires_all_s3_vars(s3_config, monkeypatch):
    monkeypatch.setattr(Config, 'S3_SECRET_KEY', None)

    with pytest.raises(ValueError, match='S3 configuration incomplete'):
        Config.validate()


def test_validate_rejects_samesite_none_without_secure(monkeypatch):
    monkeypatch.setattr(Config, 'SESSION_COOKIE_SAMESITE', 'None')
    monkeypatch.setattr(Config, 'SESSION_COOKIE_SECURE', False)

    with pytest.raises(ValueError, match='SESSION_COOKIE_SAMESITE'):
        Config.validate()


def test_validate_rejects_invalid_samesite(monkeypatch):
    monkeypatch.setattr(Config, 'SESSION_COOKIE_SAMESITE', 'bogus')

    with pytest.raises(ValueError, match='SESSION_COOKIE_SAMESITE'):
        Config.validate()


@pytest.mark.parametrize('value,expected', [
    ('youraccesskey', True),
    ('YOUR-SECRET', True),
    ('changeme', True),
    ('<key>', True),
    ('bucketname', True),
    ('example-creds', True),
    ('AKIAIOSFODNN7X7REAL', False),
    ('prod-buzzdrop-uploads', False),
    (None, False),
    ('', False),
])
def test_looks_like_placeholder(value, expected):
    assert _looks_like_placeholder(value) is expected


@pytest.mark.parametrize('value', ['', '   '])
def test_empty_source_code_url_falls_back_to_the_upstream_repository(value):
    # Config reads the environment at import time, so import it afresh in a
    # child process; an empty value must not render the footer link as href="".
    env = {**os.environ, 'SOURCE_CODE_URL': value}
    result = subprocess.run(
        [sys.executable, '-c', 'from config import Config; print(Config.SOURCE_CODE_URL)'],
        env=env, capture_output=True, text=True, check=True,
        cwd=os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
    assert result.stdout.strip() == 'https://github.com/buzzdrop/buzzdrop'
