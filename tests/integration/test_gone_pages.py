"""
Pages for links that lead nowhere (#228): a drop link that was already
opened, expired or never existed gets one uniform "gone" page, and unknown
URLs get a themed 404 instead of Werkzeug's default.
"""
from datetime import datetime, timedelta

import pytest
from flask import url_for
from werkzeug.exceptions import InternalServerError

from app import handle_server_error

GONE_HEADING = 'This drop is gone'


def _gone_drops(file_record):
    """One id per way a drop can be gone, plus one that never existed."""
    file_record('opened-file', downloaded_at=datetime.now().isoformat())
    file_record('opened-note', type='text', downloaded_at=datetime.now().isoformat())
    file_record('expired-file',
                expiry_at=(datetime.now() - timedelta(minutes=1)).isoformat())
    return ['opened-file', 'opened-note', 'expired-file', 'never-existed']


def _open_link(client, csrf_form_data, file_id, step):
    if step == 'view':
        return client.get(url_for('view_file', file_id=file_id))
    return client.post(url_for('confirm_view_file', file_id=file_id), data=csrf_form_data())


@pytest.mark.parametrize('step', ['view', 'confirm'])
def test_gone_drop_renders_its_own_page(client, file_record, csrf_form_data, step):
    for file_id in _gone_drops(file_record):
        response = _open_link(client, csrf_form_data, file_id, step)

        assert response.status_code == 404, file_id
        html = response.get_data(as_text=True)
        assert GONE_HEADING in html
        assert 'Ask the sender for a new one.' in html
        assert 'File not found' not in html


@pytest.mark.parametrize('step', ['view', 'confirm'])
def test_gone_page_does_not_reveal_why(client, file_record, csrf_form_data, step):
    bodies = {file_id: _open_link(client, csrf_form_data, file_id, step).get_data()
              for file_id in _gone_drops(file_record)}

    assert len(set(bodies.values())) == 1, sorted(bodies)


@pytest.mark.parametrize('step', ['view', 'confirm'])
def test_released_drop_renders_the_gone_page(
        client, file_record, bound_share, files_store, csrf_form_data, step):
    """A share that was released but never downloaded leads nowhere: its
    H is spent, so the link is dead — the same uniform 404."""
    file_record('released-drop')
    bound_share('released-drop', v_hex='cc' * 32)
    files_store.attempt_key_release('released-drop', 'cc' * 32, 1, True)

    response = _open_link(client, csrf_form_data, 'released-drop', step)

    assert response.status_code == 404
    assert GONE_HEADING in response.get_data(as_text=True)


def test_gone_page_is_the_same_logged_in(client, file_record):
    with client.session_transaction() as session:
        session['username'] = 'testuser'
    _gone_drops(file_record)

    response = client.get(url_for('view_file', file_id='opened-note'))

    assert response.status_code == 404
    assert GONE_HEADING in response.get_data(as_text=True)


def test_unknown_url_gets_a_themed_404(client):
    response = client.get('/does-not-exist')

    assert response.status_code == 404
    html = response.get_data(as_text=True)
    assert 'Page not found' in html
    # Themed: rendered inside base.html, not Werkzeug's bare page.
    assert 'css/app.css' in html
    assert GONE_HEADING not in html


def test_unknown_url_answers_api_clients_with_json(client):
    response = client.get('/api/does-not-exist')

    assert response.status_code == 404
    assert response.get_json() == {'error': 'Not found'}


def test_server_error_page_is_themed(app):
    # Under TESTING exceptions propagate instead of reaching the handler.
    with app.test_request_context('/'):
        response = app.make_response(handle_server_error(InternalServerError()))

    assert response.status_code == 500
    html = response.get_data(as_text=True)
    assert 'Something went wrong' in html
    assert 'css/app.css' in html
