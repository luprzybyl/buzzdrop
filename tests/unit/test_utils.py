import pytest
from app import hash_password, allowed_file, get_users # Assuming these are directly importable from app.py
from werkzeug.security import check_password_hash
import os # For mocking
from unittest import mock # For mocking

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
