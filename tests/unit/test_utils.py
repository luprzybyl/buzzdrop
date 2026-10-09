import pytest
from auth import hash_password, get_users
from utils import allowed_file
from werkzeug.security import check_password_hash
import os # For mocking
from unittest import mock # For mocking

# Fixture to clear get_users cache before each test that uses it
@pytest.fixture(autouse=True)
def clear_user_cache():
    """Clear the LRU cache on get_users before each test."""
    get_users.cache_clear()
    yield
    get_users.cache_clear()

def test_hash_password():
    password = "testpassword"
    hashed = hash_password(password)
    assert hashed is not None
    assert isinstance(hashed, str)
    # With PBKDF2, each hash is different due to random salt (secure behavior)
    # So we check if the hash can verify the original password
    assert check_password_hash(hashed, password)
    assert hashed != password # Ensure it's not returning the plain password
    # Verify hashes are different each time (random salt)
    hashed2 = hash_password(password)
    assert hashed != hashed2  # Different salt = different hash

def test_hash_password_different_passwords():
    password_a = "testpasswordA"
    password_b = "testpasswordB"
    assert hash_password(password_a) != hash_password(password_b)

# This test requires the app context to access app.config['ALLOWED_EXTENSIONS']
# The 'app' fixture from conftest.py will provide this
def test_allowed_file_with_app_context(app):
    with app.app_context():
        # Test with default extensions from conftest.py app fixture if not overridden
        # Or, set them directly for more precise testing if needed:
        # current_app.config['ALLOWED_EXTENSIONS'] = {'txt', 'pdf', 'png'}

        assert allowed_file("test.txt") == True
        assert allowed_file("document.pdf") == True
        assert allowed_file("image.PNG") == True # Test case insensitivity
        assert allowed_file("archive.zip") == False
        assert allowed_file("no_extension") == False
        assert allowed_file(".hiddenfile") == False # No extension part
        assert allowed_file("image.jpeg") == True # From default list
        assert allowed_file("archive.tar.gz") == False # Only last part is considered

@mock.patch.dict(os.environ, {}, clear=True) # Start with a clean slate for os.environ
def test_get_users_no_users():
    users = get_users()
    assert users == {}

@mock.patch.dict(os.environ, {"FLASK_USER_1": "user1:pass1:false"}, clear=True)
def test_get_users_single_user():
    users = get_users()
    assert "user1" in users
    # Check password can verify the original plaintext (hashes differ due to salt)
    assert check_password_hash(users["user1"]["password"], "pass1")
    assert users["user1"]["is_admin"] == False

@mock.patch.dict(os.environ, {
    "FLASK_USER_1": "user1:pass1:false",
    "FLASK_USER_2": "admin:adminpass:true"
}, clear=True)
def test_get_users_multiple_users():
    users = get_users()
    assert "user1" in users
    assert "admin" in users
    assert users["user1"]["is_admin"] == False
    assert users["admin"]["is_admin"] == True
    # Check password can verify the original plaintext
    assert check_password_hash(users["admin"]["password"], "adminpass")

@mock.patch.dict(os.environ, {
    "FLASK_USER_1": "user1:pass1:false:user1@example.com",
}, clear=True)
def test_get_users_optional_email_metadata():
    users = get_users()
    assert users["user1"]["email"] == "user1@example.com"

@mock.patch.dict(os.environ, {
    "FLASK_USER_1": "user1:pa:ss:false",
}, clear=True)
def test_get_users_password_with_colon():
    users = get_users()
    assert check_password_hash(users["user1"]["password"], "pa:ss")

@mock.patch.dict(os.environ, {
    "FLASK_USER_1": "user1:pa:false:true",
}, clear=True)
def test_get_users_legacy_format_password_not_misread_as_email():
    users = get_users()
    assert check_password_hash(users["user1"]["password"], "pa:false")
    assert users["user1"]["is_admin"] is True
    assert users["user1"]["email"] is None

@mock.patch.dict(os.environ, {"FLASK_USER_1": "user1:pass1:invalid_bool"}, clear=True)
def test_get_users_invalid_admin_flag():
    users = get_users()
    assert "user1" in users # User should still be processed
    assert users["user1"]["is_admin"] == False # Defaults to False or handles error gracefully

@mock.patch.dict(os.environ, {"FLASK_USER_1": "user1_too_few_parts"}, clear=True)
def test_get_users_invalid_format_parts(capsys): # capsys to capture print warnings
    users = get_users()
    assert users == {} # User with invalid format should be skipped
    captured = capsys.readouterr()
    assert "Warning: Invalid user format in environment variable FLASK_USER_1" in captured.out # or captured.err

@mock.patch.dict(os.environ, {
    "FLASK_USER_1": "user1:pass1:false",
    "FLASK_USER_X": "invalid_variable_name", # Should be ignored by the loop
    "FLASK_USER_3": "user3:pass3:true" # Test non-sequential numbering
}, clear=True)
def test_get_users_non_sequential_and_invalid_vars():
    users = get_users()
    assert "user1" in users
    assert "user3" in users
    assert "FLASK_USER_X" not in users # Ensure it's not misinterpreted
    assert len(users) == 2


from utils import enhance_file_display


def test_status_display_downloaded_without_decryption_report():
    """Wrong-password flow: blob claimed, no report → 'Downloaded', not Active."""
    f = {
        'status': 'active',
        'downloaded_at': '2026-10-04T21:21:08',
        'decryption_success': None,
    }
    enhance_file_display(f)
    assert f['status_display'] == 'Downloaded'
    assert f['status_key'] == 'downloaded'


def test_status_display_decrypted():
    f = {
        'status': 'active',
        'downloaded_at': '2026-10-04T21:21:08',
        'decryption_success': True,
    }
    enhance_file_display(f)
    assert (f['status_key'], f['status_display']) == ('decrypted', 'Decrypted')


def test_status_display_lockout_with_or_without_download():
    """Key-release lockout stamps decryption_success=False. The browser
    downloads the blob before asking for the key, so the real flow has a
    download; a direct /release call doesn't."""
    for downloaded_at in ('2026-10-04T21:21:08', None):
        f = {'status': 'active', 'downloaded_at': downloaded_at,
             'decryption_success': False}
        enhance_file_display(f)
        assert (f['status_key'], f['status_display']) == ('locked-out', 'Locked out')


def test_status_display_expired_and_active():
    expired = {'status': 'expired', 'downloaded_at': None, 'decryption_success': None}
    enhance_file_display(expired)
    assert (expired['status_key'], expired['status_display']) == ('expired', 'Expired')

    active = {'status': 'active', 'downloaded_at': None, 'decryption_success': None}
    enhance_file_display(active)
    assert (active['status_key'], active['status_display']) == ('active', 'Active')


def test_enhance_keeps_machine_readable_timestamps():
    f = {'created_at': '2026-10-06T21:35:29', 'downloaded_at': None,
         'expiry_at': '2026-01-15T10:30:00'}
    enhance_file_display(f)
    assert f['created_at'] == '2026-10-06 21:35:29 CEST'
    assert f['created_at_iso'] == '2026-10-06T21:35:29+02:00'
    assert f['expiry_at_iso'] == '2026-01-15T10:30:00+01:00'
    assert f['downloaded_at_iso'] is None


def test_display_name_of_a_file_is_its_name():
    f = {'type': 'file', 'original_name': 'report.pdf', 'private_note': 'Q3',
         'created_at': '2026-10-06T21:35:29'}
    enhance_file_display(f)
    assert f['display_name'] == 'report.pdf'


def test_display_name_of_a_text_note_is_its_private_note():
    f = {'type': 'text', 'original_name': 'Secret Note',
         'private_note': '  For the auditor ', 'created_at': '2026-10-06T21:35:29'}
    enhance_file_display(f)
    assert f['display_name'] == 'For the auditor'


def test_display_name_of_a_text_note_without_a_note_carries_its_time():
    f = {'type': 'text', 'original_name': 'Secret Note', 'private_note': '',
         'created_at': '2026-10-06T21:35:29'}
    enhance_file_display(f)
    assert f['display_name'] == 'Text note \u00b7 21:35'
