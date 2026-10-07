"""
The recipient's password step (templates/view.html) as the server renders
it: the labelled field, the attempts warning that follows
KEY_RELEASE_MAX_ATTEMPTS, and what it says about the password (#227).
"""
import re
from datetime import datetime

import pytest
from flask import url_for

FILE_ID = '00000000-0000-4000-8000-000000000227'


@pytest.fixture
def key_release_settings(app):
    """Mutate key-release config and restore it afterwards."""
    original = {'KEY_RELEASE_MAX_ATTEMPTS': app.config['KEY_RELEASE_MAX_ATTEMPTS']}
    yield app.config
    app.config.update(original)


def _view_page(client, files_store, csrf_form_data, file_type='file'):
    files_store.insert({
        'id': FILE_ID,
        'original_name': 'secret.txt',
        'path': f'nonexistent/{FILE_ID}',
        'created_at': datetime.now().isoformat(),
        'downloaded_at': None,
        'uploaded_by': 'testuser',
        'expiry_at': None,
        'status': 'active',
        'type': file_type,
    })
    response = client.post(url_for('confirm_view_file', file_id=FILE_ID), data=csrf_form_data())
    assert response.status_code == 200
    return response.get_data(as_text=True)


def test_password_field_has_a_label(client, files_store, csrf_form_data):
    html = _view_page(client, files_store, csrf_form_data)

    assert re.search(r'<label for="password-input"[^>]*>Password</label>', html)


def test_warns_of_a_single_attempt_by_default(client, files_store, csrf_form_data):
    html = _view_page(client, files_store, csrf_form_data)

    assert 'You have one attempt' in html


def test_attempts_warning_follows_the_configured_limit(client, files_store, csrf_form_data, key_release_settings):
    key_release_settings['KEY_RELEASE_MAX_ATTEMPTS'] = 3

    html = _view_page(client, files_store, csrf_form_data)

    assert 'You have 3 attempts' in html
    assert 'one attempt' not in html


def test_says_only_a_derived_value_leaves_the_browser(client, files_store, csrf_form_data):
    html = _view_page(client, files_store, csrf_form_data)

    assert 'Your password stays in your browser; only a derived check value is sent.' in html
    assert 'never sent to the server' not in html


def test_note_tells_the_recipient_to_copy_it_now(client, files_store, csrf_form_data):
    html = _view_page(client, files_store, csrf_form_data, file_type='text')

    assert 'Copy it now — this page can’t be reopened.' in html


def test_auto_filled_password_names_the_button_to_press(client, files_store, csrf_form_data):
    html = _view_page(client, files_store, csrf_form_data)

    assert 'Your link included the password — just press Decrypt and download.' in html


def test_note_has_no_press_decrypt_hint(client, files_store, csrf_form_data):
    html = _view_page(client, files_store, csrf_form_data, file_type='text')

    assert 'password-status' not in html
    assert 'Your link included the password' not in html
