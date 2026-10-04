"""
Unit tests for the CLI encryption/decryption functions.

These tests verify that the Python encrypt_file() output can be correctly
parsed (correct header offsets, correct binary layout), that a round-trip
encrypt→decrypt produces the original data, and that the versioned payload
format is honoured:

    v2: 'BKV2' (4B) + salt (16B) + iv (12B) + AES-GCM ciphertext, 600k iters
    v1 (legacy): salt (16B) + iv (12B) + AES-GCM ciphertext,      100k iters

The V1_FIXTURE/V2_FIXTURE hex blobs below are shared verbatim with
tests/js/crypto.test.mjs so both implementations are pinned to identical
bytes: salt = bytes(range(16)), iv = bytes(range(16, 28)),
password = 'fixture-password-123', plaintext payload = b'fixture-data'.
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

# Deterministic fixtures (salt = 0x00..0x0f, iv = 0x10..0x1b).
FIXTURE_PASSWORD = 'fixture-password-123'
FIXTURE_DATA = b'fixture-data'
# Legacy v1 blob: salt(16) + iv(12) + AES-GCM('BKP-FILE' + data), 100k iters.
V1_FIXTURE = bytes.fromhex(
    '000102030405060708090a0b0c0d0e0f'
    '101112131415161718191a1b'
    'd56b4e5b1641d0eaeacce061df6849f4af753cdfd77c893e82c18731742215deb41d16c7'
)
# v2 blob: 'BKV2' + salt(16) + iv(12) + AES-GCM('BKP-FILE' + data), 600k iters.
V2_FIXTURE = bytes.fromhex(
    '424b5632'
    '000102030405060708090a0b0c0d0e0f'
    '101112131415161718191a1b'
    'e3e9c2fdac1fb1a52e4bbc89c1ba01a137ea1936f57eec0d0ccf39fff550f508ee017e67'
)


def _manual_decrypt(blob: bytes, password: str, iterations: int, offset: int = 0) -> bytes:
    """Decrypt salt+iv+ct at `offset` with an explicit iteration count."""
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
    from cryptography.hazmat.primitives import hashes

    salt = blob[offset:offset + 16]
    iv = blob[offset + 16:offset + 28]
    ciphertext = blob[offset + 28:]
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=salt,
        iterations=iterations,
    )
    key = kdf.derive(password.encode('utf-8'))
    return AESGCM(key).decrypt(iv, ciphertext, None)


@requires_cryptography
def test_encrypt_output_length():
    buzz = _import_buzz()
    data = b'hello world'
    password = 'test-password'
    result = buzz.encrypt_file(data, password)
    # magic(4) + salt(16) + iv(12) + AES-GCM(tag=16 + plaintext with 8-byte header)
    expected_min = 4 + 16 + 12 + 16 + 8 + len(data)
    assert len(result) == expected_min


@requires_cryptography
def test_encrypt_produces_v2_envelope():
    """encrypt_file() must emit the v2 envelope magic at offset 0."""
    buzz = _import_buzz()
    result = buzz.encrypt_file(b'data', 'pw')
    assert result[:4] == buzz.MAGIC_V2 == b'BKV2'


@requires_cryptography
def test_encrypt_decrypt_roundtrip():
    """Python-encrypted v2 data should decrypt to original bytes."""
    buzz = _import_buzz()
    original = b'The quick brown fox jumps over the lazy dog'
    password = 'correct-horse-battery-staple'

    encrypted = buzz.encrypt_file(original, password)

    # Parse the v2 binary format: magic(4) + salt(16) + iv(12) + ct
    plaintext = _manual_decrypt(encrypted, password, iterations=600_000, offset=4)

    assert plaintext[:8] == b'BKP-FILE'
    assert plaintext[8:] == original


@requires_cryptography
def test_decrypt_file_v2_roundtrip():
    """decrypt_file() round-trips encrypt_file() output."""
    buzz = _import_buzz()
    original = b'roundtrip me \x00\x01\xff'
    encrypted = buzz.encrypt_file(original, 'some-password')
    assert buzz.decrypt_file(encrypted, 'some-password') == original


@requires_cryptography
def test_decrypt_file_v2_fixture():
    """Pinned v2 fixture decrypts (anchors Python/JS to identical bytes)."""
    buzz = _import_buzz()
    assert buzz.decrypt_file(V2_FIXTURE, FIXTURE_PASSWORD) == FIXTURE_DATA


@requires_cryptography
def test_decrypt_file_v1_legacy_fixture():
    """Existing v1 shares (no magic, 100k iterations) must still decrypt."""
    buzz = _import_buzz()
    assert not V1_FIXTURE.startswith(buzz.MAGIC_V2)
    assert buzz.decrypt_file(V1_FIXTURE, FIXTURE_PASSWORD) == FIXTURE_DATA


@requires_cryptography
def test_v2_actually_uses_600k_iterations():
    """v2 payloads must not decrypt with the legacy 100k iteration count."""
    from cryptography.exceptions import InvalidTag

    buzz = _import_buzz()
    encrypted = buzz.encrypt_file(b'secret', 'pw')

    # Legacy iteration count fails...
    with pytest.raises(InvalidTag):
        _manual_decrypt(encrypted, 'pw', iterations=100_000, offset=4)
    # ...while the v2 count succeeds.
    assert _manual_decrypt(encrypted, 'pw', iterations=600_000, offset=4)


@requires_cryptography
def test_v1_fixture_actually_uses_100k_iterations():
    """The pinned v1 blob must fail under v2 iterations and pass under v1."""
    from cryptography.exceptions import InvalidTag

    with pytest.raises(InvalidTag):
        _manual_decrypt(V1_FIXTURE, FIXTURE_PASSWORD, iterations=600_000)
    plaintext = _manual_decrypt(V1_FIXTURE, FIXTURE_PASSWORD, iterations=100_000)
    assert plaintext[8:] == FIXTURE_DATA


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
    from cryptography.exceptions import InvalidTag

    buzz = _import_buzz()
    encrypted = buzz.encrypt_file(b'secret', 'correct')

    with pytest.raises(InvalidTag):
        _manual_decrypt(encrypted, 'wrong', iterations=600_000, offset=4)

    with pytest.raises((InvalidTag, ValueError)):
        buzz.decrypt_file(encrypted, 'wrong')


@requires_cryptography
def test_unicode_password():
    """Non-ASCII passwords should work and round-trip correctly."""
    buzz = _import_buzz()
    original = b'secret data'
    password = 'pässwörd-日本語'

    encrypted = buzz.encrypt_file(original, password)
    plaintext = _manual_decrypt(encrypted, password, iterations=600_000, offset=4)
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
