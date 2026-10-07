"""
The recipient's password step (templates/view.html) as the server renders
it: the labelled field, the attempts warning that follows
KEY_RELEASE_MAX_ATTEMPTS, and what it says about the password (#227).
"""
import os
import re
from datetime import datetime

from flask import url_for

FILE_ID = '00000000-0000-4000-8000-000000000227'
# A BKV3 envelope prefix: confirm_view_file reads the salt out of the
# stored blob, so the record needs a real file in the uploads dir.
BLOB = b'BKV3' + b'\x5a' * 16 + b'\x00' * 12 + b'ciphertext'


def _view_page(client, files_store, csrf_form_data, file_type='file', app=None):
    blob_path = os.path.join(app.config['UPLOAD_FOLDER'], FILE_ID)
    with open(blob_path, 'wb') as handle:
        handle.write(BLOB)
    files_store.insert({
        'id': FILE_ID,
        'original_name': 'secret.txt',
        'path': blob_path,
        'created_at': datetime.now().isoformat(),
        'downloaded_at': None,
        'uploaded_by': 'testuser',
        'expiry_at': None,
        'status': 'active',
        'type': file_type,
    })
    # A live key share: without one the public pages treat the record as
    # already claimed.
    files_store.create_key_share(FILE_ID, 'aa' * 32, created_by='testuser')
    files_store.bind_key_verifier(FILE_ID, 'bb' * 32)
    response = client.post(url_for('confirm_view_file', file_id=FILE_ID), data=csrf_form_data())
    assert response.status_code == 200
    return response.get_data(as_text=True)


def test_password_field_has_a_label(client, files_store, csrf_form_data, app):
    html = _view_page(client, files_store, csrf_form_data, app=app)

    assert re.search(r'<label for="password-input"[^>]*>Password</label>', html)


def test_warns_of_a_single_attempt_by_default(client, files_store, csrf_form_data, app):
    html = _view_page(client, files_store, csrf_form_data, app=app)

    assert 'You have one attempt' in html


def test_attempts_warning_follows_the_configured_limit(client, files_store, csrf_form_data, key_release_settings, app):
    key_release_settings['KEY_RELEASE_MAX_ATTEMPTS'] = 3

    html = _view_page(client, files_store, csrf_form_data, app=app)

    assert 'You have 3 attempts' in html
    assert 'one attempt' not in html


def test_says_only_a_derived_value_leaves_the_browser(client, files_store, csrf_form_data, app):
    html = _view_page(client, files_store, csrf_form_data, app=app)

    assert 'Your password stays in your browser; only a derived check value is sent.' in html
    assert 'never sent to the server' not in html


def test_note_tells_the_recipient_to_copy_it_now(client, files_store, csrf_form_data, app):
    html = _view_page(client, files_store, csrf_form_data, file_type='text', app=app)

    assert 'Copy it now — this page can’t be reopened.' in html


def test_auto_filled_password_names_the_button_to_press(client, files_store, csrf_form_data, app):
    html = _view_page(client, files_store, csrf_form_data, app=app)

    assert 'Your link included the password — just press Decrypt and download.' in html


def test_note_has_no_press_decrypt_hint(client, files_store, csrf_form_data, app):
    html = _view_page(client, files_store, csrf_form_data, file_type='text', app=app)

    assert 'password-status' not in html
    assert 'Your link included the password' not in html


def test_config_carries_the_blob_salt(client, files_store, csrf_form_data, app):
    """V is proven before the download, so the salt must reach the page
    ahead of the blob — out of the envelope's unencrypted prefix."""
    html = _view_page(client, files_store, csrf_form_data, app=app)

    assert f'"salt": "{BLOB[4:20].hex()}"' in html
