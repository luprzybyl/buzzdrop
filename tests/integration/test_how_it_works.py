"""
The public "How it works" page (#245): it renders without a login, loads its
script under SRI, is linked from every footer and from the recipient's pages,
and renders the view its address names (?sender=…&content=…), so a linked
view reads right before the page script runs.
"""
import re

import pytest
from flask import url_for

FILE_ID = '00000000-0000-4000-8000-000000000245'


def _page(client, **query):
    response = client.get(url_for('how_it_works', **query))
    assert response.status_code == 200
    return response.get_data(as_text=True)


def _radio(html, value):
    """The opening tag of the radio button with this value."""
    match = re.search(rf'<input\b[^>]*type="radio"[^>]*value="{value}"[^>]*>', html)
    assert match, f'no radio with value {value!r}'
    return match.group(0)


def test_renders_without_a_login(client):
    html = _page(client)

    assert '<h1' in html and 'How Buzzdrop works' in html


def test_loads_its_script_under_sri(client):
    html = _page(client)

    assert re.search(
        r'<script[^>]*src="[^"]*js/pages/how-it-works/entry\.js"'
        r'[^>]*integrity="sha384-[A-Za-z0-9+/=]+"[^>]*crossorigin="anonymous"', html)


def test_footer_links_to_it(client):
    response = client.get(url_for('login'))
    footer = re.search(r'<footer\b.*?</footer>', response.get_data(as_text=True), re.S).group(0)

    assert f'href="{url_for("how_it_works")}"' in footer


@pytest.fixture
def open_drop(file_record, bound_share):
    file_record(FILE_ID)
    bound_share(FILE_ID)


def test_confirm_page_links_to_it(client, open_drop):
    html = client.get(url_for('view_file', file_id=FILE_ID)).get_data(as_text=True)
    main = re.search(r'<main\b.*?</main>', html, re.S).group(0)

    assert f'href="{url_for("how_it_works")}"' in main


def test_password_page_links_to_it(client, open_drop, csrf_form_data):
    html = client.post(url_for('confirm_view_file', file_id=FILE_ID),
                       data=csrf_form_data()).get_data(as_text=True)
    main = re.search(r'<main\b.*?</main>', html, re.S).group(0)

    assert f'href="{url_for("how_it_works")}"' in main


def test_defaults_to_the_web_app_sending_a_file(client):
    html = _page(client)

    assert 'checked' in _radio(html, 'web')
    assert 'checked' in _radio(html, 'file')


def test_renders_the_view_its_address_names(client):
    html = _page(client, sender='cli', content='file')

    assert 'checked' in _radio(html, 'cli')
    assert 'checked' not in _radio(html, 'web')
    assert 'Authorization: Bearer' in html


def test_text_is_disabled_when_the_cli_sends(client):
    html = _page(client, sender='cli')

    assert 'disabled' in _radio(html, 'text')
    assert 'the CLI sends files only' in html


def test_cli_with_text_falls_back_to_a_file(client):
    # The combination doesn't exist yet (#247), so a link naming it shows
    # what the CLI really does.
    html = _page(client, sender='cli', content='text')

    assert 'checked' in _radio(html, 'file')
    assert 'checked' not in _radio(html, 'text')


def test_unknown_values_fall_back_to_the_default(client):
    html = _page(client, sender='fax', content='pigeon')

    assert 'checked' in _radio(html, 'web')
    assert 'checked' in _radio(html, 'file')


def test_says_plainly_that_the_filename_is_visible(client):
    # Until filenames are encrypted (#246) the page must not claim the
    # server knows nothing.
    html = _page(client)

    assert 'original filename' in html
    assert 'knows nothing' not in html


def test_recipient_pages_open_it_in_a_new_tab(client, open_drop, csrf_form_data):
    # Leaving the one-time password page would lose it.
    pages = (
        client.get(url_for('view_file', file_id=FILE_ID)),
        client.post(url_for('confirm_view_file', file_id=FILE_ID), data=csrf_form_data()),
    )
    for response in pages:
        links = re.findall(rf'<a\b[^>]*href="{url_for("how_it_works")}"[^>]*>', response.get_data(as_text=True))
        assert links
        assert all('target="_blank"' in link for link in links)
