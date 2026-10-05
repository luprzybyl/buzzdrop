"""
Unit tests for the CLI encryption/decryption functions.

These tests verify that the Python encrypt_file() output can be correctly
parsed (correct header offsets, correct binary layout) and that a
round-trip encrypt→decrypt produces the original data for the key-release
(BKV3) payload format:

    'BKV3' (4B) + salt (16B) + iv (12B) + AES-GCM ciphertext
    master   = PBKDF2-SHA256(password, salt, 600k)
    Kp       = HKDF(master, salt, 'enc'); V = HKDF(master, salt, 'ver')
    file_key = HKDF(Kp ‖ H, salt, 'file')

The V3_FIXTURE hex blob below is shared verbatim with
tests/js/crypto.test.js so both implementations are pinned to identical
bytes: salt = bytes(range(16)), iv = bytes(range(16, 28)),
h = bytes(range(32, 64)), receipt = bytes(range(64, 96)),
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

# Deterministic fixtures (salt = 0x00..0x0f, iv = 0x10..0x1b,
# h = 0x20..0x3f, receipt = 0x40..0x5f).
FIXTURE_PASSWORD = 'fixture-password-123'
FIXTURE_DATA = b'fixture-data'
# v3 blob: 'BKV3' + salt(16) + iv(12) + AES-GCM('BKP-FILE' + receipt + data),
# key-release KDF.
V3_FIXTURE = bytes.fromhex(
    '424b5633'
    '000102030405060708090a0b0c0d0e0f'
    '101112131415161718191a1b'
    '9d9e3a85dc0667cf2d932f2ff111e26d53863a05b353260ca7f44e971372b9'
    '1bc0238a04ef05c5b1e79f2b61b3a603b53c45ea318ba552f5d223fffcaa'
    'e506cbea569cd3'
)
V3_FIXTURE_H = bytes.fromhex(
    '202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f'
)
V3_FIXTURE_V = (
    '0ec3a6fe37dd4e652583c3dcde17bad20e019cbbf47d8f281bbf3f028ab482db'
)
V3_FIXTURE_RECEIPT = bytes.fromhex(
    '404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f'
)


@requires_cryptography
def test_encrypt_output_length():
    buzz = _import_buzz()
    data = b'hello world'
    blob, _v, receipt_hash = buzz.encrypt_file(
        data, 'test-password', h=os.urandom(32))
    # magic(4) + salt(16) + iv(12) + AES-GCM(tag=16 + plaintext with
    # 8-byte header + 32-byte receipt)
    expected_min = 4 + 16 + 12 + 16 + 8 + 32 + len(data)
    assert len(blob) == expected_min
    assert len(receipt_hash) == 64


@requires_cryptography
def test_encrypt_receipt_hash_matches_payload():
    """The stored receipt_hash is SHA-256 of the in-plaintext receipt."""
    import hashlib
    buzz = _import_buzz()
    h = os.urandom(32)
    blob, _v, receipt_hash = buzz.encrypt_file(b'data', 'pw', h)
    _data, receipt = buzz.decrypt_file(blob, 'pw', h)
    assert hashlib.sha256(receipt).hexdigest() == receipt_hash


@requires_cryptography
def test_encrypt_produces_v3_envelope():
    """encrypt_file() must emit the BKV3 envelope magic at offset 0."""
    buzz = _import_buzz()
    blob, v_hex, _rh = buzz.encrypt_file(b'data', 'pw', h=os.urandom(32))
    assert blob[:4] == buzz.MAGIC_V3 == b'BKV3'
    assert len(v_hex) == 64


@requires_cryptography
def test_encrypt_rejects_bad_h_length():
    buzz = _import_buzz()
    with pytest.raises(ValueError):
        buzz.encrypt_file(b'data', 'pw', h=b'too-short')


@requires_cryptography
def test_encrypt_decrypt_roundtrip():
    """encrypt_file + decrypt_file(h) returns the original bytes."""
    buzz = _import_buzz()
    original = b'key-release payload \x00\xff'
    h = os.urandom(32)
    blob, _v, _rh = buzz.encrypt_file(original, 'pw', h)
    data, receipt = buzz.decrypt_file(blob, 'pw', h=h)
    assert data == original
    assert len(receipt) == 32


@requires_cryptography
def test_v3_fixture_decrypts_and_verifier_matches():
    """Pinned v3 fixture: same bytes in JS test (crypto.test.js)."""
    buzz = _import_buzz()
    data, receipt = buzz.decrypt_file(
        V3_FIXTURE, FIXTURE_PASSWORD, h=V3_FIXTURE_H)
    assert data == FIXTURE_DATA
    assert receipt == V3_FIXTURE_RECEIPT
    # The verifier the client binds is derivable from password + blob salt.
    salt = V3_FIXTURE[4:20]
    _kp, v = buzz.derive_key_release_keys(FIXTURE_PASSWORD, salt)
    assert v.hex() == V3_FIXTURE_V


@requires_cryptography
def test_decrypt_requires_v3_magic():
    """Only BKV3 is supported — other formats fail loudly."""
    buzz = _import_buzz()
    with pytest.raises(ValueError):
        buzz.decrypt_file(b'BKV2' + V3_FIXTURE[4:], FIXTURE_PASSWORD, h=V3_FIXTURE_H)
    with pytest.raises(ValueError):
        buzz.decrypt_file(os.urandom(64), FIXTURE_PASSWORD, h=V3_FIXTURE_H)


@requires_cryptography
def test_decrypt_requires_server_share():
    """The whole point: a blob alone cannot be decrypted."""
    buzz = _import_buzz()
    with pytest.raises(ValueError):
        buzz.decrypt_file(V3_FIXTURE, FIXTURE_PASSWORD, h=None)
    with pytest.raises(ValueError):
        buzz.decrypt_file(V3_FIXTURE, FIXTURE_PASSWORD, h=b'short')


@requires_cryptography
def test_wrong_password_or_h_fails():
    from cryptography.exceptions import InvalidTag
    buzz = _import_buzz()
    with pytest.raises(InvalidTag):
        buzz.decrypt_file(V3_FIXTURE, 'wrong-password', h=V3_FIXTURE_H)
    with pytest.raises(InvalidTag):
        buzz.decrypt_file(V3_FIXTURE, FIXTURE_PASSWORD, h=os.urandom(32))


@requires_cryptography
def test_hkdf_domain_separation():
    """Kp, V and file_key must be pairwise distinct for the same master."""
    buzz = _import_buzz()
    salt = bytes(range(16))
    kp, v = buzz.derive_key_release_keys('pw', salt)
    fk = buzz._derive_file_key(kp, bytes(range(32, 64)), salt)
    assert kp != v != fk


@requires_cryptography
def test_encrypt_is_non_deterministic():
    """Each call should produce different ciphertext (random salt+iv)."""
    buzz = _import_buzz()
    h = os.urandom(32)
    blob1, _v1, _r1 = buzz.encrypt_file(b'same data', 'same-password', h)
    blob2, _v2, _r2 = buzz.encrypt_file(b'same data', 'same-password', h)
    assert blob1 != blob2


@requires_cryptography
def test_unicode_password():
    """Non-ASCII passwords should work and round-trip correctly."""
    buzz = _import_buzz()
    original = b'secret data'
    password = 'pässwörd-日本語'
    h = os.urandom(32)

    blob, _v, _rh = buzz.encrypt_file(original, password, h)
    data, _receipt = buzz.decrypt_file(blob, password, h=h)
    assert data == original


def test_generate_passphrase_format():
    buzz = _import_buzz()
    phrase = buzz.generate_passphrase()
    # Four EFF words contain a hyphen ('yo-yo', 't-shirt', ...), so a
    # naive split('-') overcounts. Re-merge fragments when the joined
    # form is a real word, then check the word count.
    raw = phrase.split('-')
    parts = []
    i = 0
    while i < len(raw):
        if i + 1 < len(raw) and f"{raw[i]}-{raw[i + 1]}" in buzz._WORDS:
            parts.append(f"{raw[i]}-{raw[i + 1]}")
            i += 2
        else:
            parts.append(raw[i])
            i += 1
    assert len(parts) == 6
    for part in parts:
        assert part in buzz._WORDS


def test_wordlist_is_eff_large_wordlist():
    """The bundled list must be the full EFF large wordlist.

    Regression protection: an earlier list claimed ~400 words but had
    duplicates and only 691 entries — the whole point of a passphrase
    generator is entropy, so guard the list size and uniqueness.
    """
    buzz = _import_buzz()
    assert len(buzz._WORDS) == 7776
    assert len(set(buzz._WORDS)) == 7776


def test_js_wordlist_matches_cli():
    """static/js/eff-wordlist.js must be the same list as cli/buzz's."""
    import re
    buzz = _import_buzz()
    js_path = os.path.abspath(
        os.path.join(os.path.dirname(__file__), '..', '..',
                     'static', 'js', 'eff-wordlist.js')
    )
    with open(js_path) as fh:
        js_words = re.findall(r"'([a-z-]+)'", fh.read())
    assert js_words == buzz._WORDS


def test_generate_passphrase_entropy():
    """Default passphrases should carry ~77.5 bits of entropy."""
    import math
    buzz = _import_buzz()
    bits_per_word = math.log2(len(buzz._WORDS))
    assert 6 * bits_per_word >= 75


def test_generate_passphrase_is_random():
    buzz = _import_buzz()
    phrases = {buzz.generate_passphrase() for _ in range(20)}
    assert len(phrases) > 1
