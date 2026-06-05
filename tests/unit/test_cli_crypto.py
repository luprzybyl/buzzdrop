"""
Unit tests for the CLI encryption function.

These tests verify that the Python encrypt_file() output can be correctly
parsed (correct header offsets, correct binary layout) and that a
round-trip encrypt→decrypt produces the original data.
"""
import os
import sys

import pytest

# Make cli/buzz importable as a module
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'cli'))


def _import_buzz():
    """Import cli/buzz as a module (file has no .py extension)."""
    import importlib.util
    import importlib.machinery
    buzz_path = os.path.abspath(
        os.path.join(os.path.dirname(__file__), '..', '..', 'cli', 'buzz')
    )
    loader = importlib.machinery.SourceFileLoader('buzz', buzz_path)
    spec = importlib.util.spec_from_loader('buzz', loader)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


try:
    _cryptography_available = True
    import cryptography  # noqa: F401
except ImportError:
    _cryptography_available = False

requires_cryptography = pytest.mark.skipif(
    not _cryptography_available,
    reason='cryptography package not installed',
)


@requires_cryptography
def test_encrypt_output_length():
    buzz = _import_buzz()
    data = b'hello world'
    password = 'test-password'
    result = buzz.encrypt_file(data, password)
    # salt(16) + iv(12) + AES-GCM(tag=16 + plaintext with 8-byte header)
    expected_min = 16 + 12 + 16 + 8 + len(data)
    assert len(result) == expected_min


@requires_cryptography
def test_encrypt_decrypt_roundtrip():
    """Python-encrypted data should decrypt to original bytes."""
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
    from cryptography.hazmat.primitives import hashes

    buzz = _import_buzz()
    original = b'The quick brown fox jumps over the lazy dog'
    password = 'correct-horse-battery-staple'

    encrypted = buzz.encrypt_file(original, password)

    # Parse the binary format
    salt = encrypted[:16]
    iv = encrypted[16:28]
    ciphertext = encrypted[28:]

    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=salt,
        iterations=100_000,
    )
    key = kdf.derive(password.encode('utf-8'))
    plaintext = AESGCM(key).decrypt(iv, ciphertext, None)

    assert plaintext[:8] == b'BKP-FILE'
    assert plaintext[8:] == original


@requires_cryptography
def test_encrypt_is_non_deterministic():
    """Each call should produce different ciphertext (random salt+iv)."""
    buzz = _import_buzz()
    data = b'same data'
    password = 'same-password'
    result1 = buzz.encrypt_file(data, password)
    result2 = buzz.encrypt_file(data, password)
    assert result1 != result2


@requires_cryptography
def test_wrong_password_raises():
    """Decrypting with the wrong password should raise an exception."""
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
    from cryptography.hazmat.primitives import hashes
    from cryptography.exceptions import InvalidTag

    buzz = _import_buzz()
    encrypted = buzz.encrypt_file(b'secret', 'correct')

    salt = encrypted[:16]
    iv = encrypted[16:28]
    ciphertext = encrypted[28:]

    kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=100_000)
    key = kdf.derive('wrong'.encode('utf-8'))

    with pytest.raises(InvalidTag):
        AESGCM(key).decrypt(iv, ciphertext, None)


@requires_cryptography
def test_unicode_password():
    """Non-ASCII passwords should work and round-trip correctly."""
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
    from cryptography.hazmat.primitives import hashes

    buzz = _import_buzz()
    original = b'secret data'
    password = 'pässwörd-日本語'

    encrypted = buzz.encrypt_file(original, password)
    salt = encrypted[:16]
    iv = encrypted[16:28]
    ciphertext = encrypted[28:]

    kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=100_000)
    key = kdf.derive(password.encode('utf-8'))
    plaintext = AESGCM(key).decrypt(iv, ciphertext, None)
    assert plaintext[8:] == original


def test_generate_passphrase_format():
    buzz = _import_buzz()
    phrase = buzz.generate_passphrase()
    parts = phrase.split('-')
    assert len(parts) == 4
    for part in parts:
        assert part in buzz._WORDS


def test_generate_passphrase_is_random():
    buzz = _import_buzz()
    phrases = {buzz.generate_passphrase() for _ in range(20)}
    assert len(phrases) > 1
