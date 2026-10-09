"""
The shared page chrome from templates/base.html: the header's links and
buttons and the footer note, as the server renders them per page (#232).
How the header lays out at narrow widths is a visual property; the E2E
spec tests/e2e/header.spec.js covers it.
"""
import re

import pytest
from flask import url_for


def _login(client, username='testuser', password='password'):
    response = client.post(url_for('login'), data={'username': username, 'password': password})
    assert response.status_code == 302


@pytest.fixture
def as_admin(client):
    _login(client, 'adminuser', 'adminpass')


def _region(client, endpoint, tag, **values):
    response = client.get(url_for(endpoint, **values))
    match = re.search(rf'<{tag}\b.*?</{tag}>', response.get_data(as_text=True), re.S)
    assert match, f'no <{tag}> on {endpoint}'
    return match.group(0)


def _header(client, endpoint, **values):
    return _region(client, endpoint, 'nav', **values)


def _footer(client, endpoint, **values):
    return _region(client, endpoint, 'footer', **values)


def _tag_with_text(html, text):
    """The opening tag of the element whose own text is ``text``."""
    match = re.search(rf'(<(a|button)\b[^>]*>)\s*{re.escape(text)}\s*</\2>', html)
    assert match, f'no <a>/<button> labelled {text!r}'
    return match.group(1)


def test_header_offers_login_on_the_landing_page(client):
    assert f'href="{url_for("login")}"' in _header(client, 'index')


def test_header_does_not_offer_login_on_the_login_page(client):
    assert f'href="{url_for("login")}"' not in _header(client, 'login')


def test_logout_is_not_styled_as_destructive(client):
    _login(client)
    logout = _tag_with_text(_header(client, 'index'), 'Logout')
    assert 'btn-danger' not in logout
    assert 'btn-secondary' in logout


def test_manage_users_is_marked_current_on_the_users_page(client, as_admin):
    assert 'aria-current="page"' in _tag_with_text(_header(client, 'manage_users'), 'Manage Users')


def test_manage_users_is_not_marked_current_elsewhere(client, as_admin):
    assert 'aria-current' not in _tag_with_text(_header(client, 'index'), 'Manage Users')


def test_users_page_has_no_back_to_home_link(client, as_admin):
    assert 'Back to home' not in client.get(url_for('manage_users')).get_data(as_text=True)


@pytest.mark.parametrize('endpoint, values', [
    ('login', {}),
    ('manage_users', {}),
    ('view_file', {'file_id': 'missing'}),
])
def test_footer_note_is_neutral_by_default(client, as_admin, endpoint, values):
    footer = _footer(client, endpoint, **values)
    assert 'Each drop opens once' in footer
    assert 'key' not in footer.lower()
    assert 'password' not in footer.lower()


def test_footer_tells_the_uploader_to_split_link_and_password(client):
    _login(client)
    assert 'Send the link and the password through different channels' in _footer(client, 'index')


def test_success_page_footer_tells_the_uploader_to_split_link_and_password(client, file_record):
    _login(client)
    footer = _footer(client, 'upload_success', file_id=file_record())
    assert 'Send the link and the password through different channels' in footer


def test_landing_page_footer_does_not_address_an_uploader(client):
    footer = _footer(client, 'index')
    assert 'different channels' not in footer
    assert 'Each drop opens once' in footer


@pytest.mark.parametrize('endpoint, values', [
    ('index', {}),
    ('login', {}),
    ('view_file', {'file_id': 'missing'}),
])
def test_footer_links_to_the_source_code(client, endpoint, values):
    footer = _footer(client, endpoint, **values)
    assert 'href="https://github.com/luprzybyl/buzzdrop"' in _tag_with_text(footer, 'Source code')
    assert 'agpl-3.0' in _tag_with_text(footer, 'AGPL-3.0')


def test_footer_source_link_follows_the_configured_url(app, client, monkeypatch):
    monkeypatch.setitem(app.config, 'SOURCE_CODE_URL', 'https://git.example.org/fork')
    footer = _footer(client, 'index')
    assert 'href="https://git.example.org/fork"' in _tag_with_text(footer, 'Source code')
