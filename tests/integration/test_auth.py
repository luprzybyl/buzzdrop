import pytest
from flask import session, url_for, get_flashed_messages
# Fixtures 'app', 'client' will be injected from conftest.py
# The 'app' fixture in conftest.py sets up test users:
# os.environ['FLASK_USER_1'] = 'testuser:password:false'
# os.environ['FLASK_USER_2'] = 'adminuser:adminpass:true'

def test_login_page_loads(client):
    response = client.get(url_for('login'))
    assert response.status_code == 200
    assert b'Login' in response.data # Check for a keyword in login.html

def test_login_successful_normal_user(client, app):
    # 'testuser:password:false'
    response = client.post(url_for('login'), data={
        'username': 'testuser',
        'password': 'password'
    }, follow_redirects=True)
    assert response.status_code == 200
    assert url_for('index') in response.request.path # Should redirect to index
    with client.session_transaction() as sess:
        assert sess['username'] == 'testuser'
        assert sess['is_admin'] == False
    assert b'Logged in successfully' in response.data # Check flash message

def test_login_successful_admin_user(client, app):
    # 'adminuser:adminpass:true'
    response = client.post(url_for('login'), data={
        'username': 'adminuser',
        'password': 'adminpass'
    }, follow_redirects=True)
    assert response.status_code == 200
    assert url_for('index') in response.request.path
    with client.session_transaction() as sess:
        assert sess['username'] == 'adminuser'
        assert sess['is_admin'] == True
    assert b'Logged in successfully' in response.data

def test_login_invalid_username(client):
    response = client.post(url_for('login'), data={
        'username': 'wronguser',
        'password': 'password'
    }, follow_redirects=True)
    assert response.status_code == 200 # Stays on login page
    assert url_for('login') in response.request.path
    with client.session_transaction() as sess:
        assert 'username' not in sess
    assert b'Invalid username or password' in response.data

def test_login_invalid_password(client):
    response = client.post(url_for('login'), data={
        'username': 'testuser',
        'password': 'wrongpassword'
    }, follow_redirects=True)
    assert response.status_code == 200
    assert url_for('login') in response.request.path
    with client.session_transaction() as sess:
        assert 'username' not in sess
    assert b'Invalid username or password' in response.data

def test_logout(client, app):
    # First, log in a user
    client.post(url_for('login'), data={'username': 'testuser', 'password': 'password'})

    # Then, log out
    response = client.get(url_for('logout'), follow_redirects=True)
    assert response.status_code == 200
    assert url_for('index') in response.request.path
    with client.session_transaction() as sess:
        assert 'username' not in sess
        assert 'is_admin' not in sess
    assert b'Logged out successfully' in response.data

def test_login_required_redirects_to_login(client):
    # Accessing a login-required page like upload_success without being logged in
    response = client.get(url_for('upload_success', file_id='somefile'), follow_redirects=True)
    assert response.status_code == 200
    assert url_for('login') in response.request.path # Should redirect to login
    assert b'Please log in to access this page' in response.data

def test_login_required_allows_access_when_logged_in(client, app):
    # Log in first
    client.post(url_for('login'), data={'username': 'testuser', 'password': 'password'})

    # Now access the protected page. This will likely fail if 'somefile' doesn't exist,
    # but the point is to get past the login_required check.
    # We expect a different error or success, not a redirect to login.
    # For upload_success, it expects a valid file_id which might not exist, leading to a flash message.
    # A better test would be a simple GET route that is login_required.
    # Let's assume there's a hypothetical '/profile' page that's login_required.
    # For now, we'll test with an existing one like '/success/some_id'
    # The `upload_success` route itself renders a template.
    # If the file_id isn't found by `view_file` (called by `url_for`), it might redirect.
    # Let's use the `upload_file` (POST) route's GET access attempt which is not allowed method-wise,
    # but the login_required check happens first.

    response_upload_get = client.get(url_for('upload_file')) # GET request to a POST route
    # If not logged in, this would redirect to login.
    # If logged in, it should be a 405 Method Not Allowed, or redirect to index if GET is not handled.
    assert response_upload_get.status_code != 302 # Ensure not redirected to login
    # Check flash message if any (e.g. "No file part" if it hits the route logic)
    # A 405 is also acceptable here, or a redirect to index with a flash.
    # Depending on how the app handles GET to a POST-only @login_required route.
    # Common behavior for Flask is 405 if the route explicitly only defines POST.
    # If GET is not defined, it might also be a 404 if not caught by login_required first.
    # Given login_required is hit first, and then method check, a 405 is most likely if logged in.
    assert response_upload_get.status_code == 405 or b'No file part' in response_upload_get.data or b'Method Not Allowed' in response_upload_get.data


def test_admin_required_redirects_non_admin_to_index(client, app):
    # Log in as a normal user
    client.post(url_for('login'), data={'username': 'testuser', 'password': 'password'})

    response = client.get(url_for('manage_users'), follow_redirects=True)
    assert response.status_code == 200
    assert url_for('index') in response.request.path # Should redirect to index
    assert b'Admin access required' in response.data

def test_admin_required_redirects_anonymous_to_login(client, app):
    response = client.get(url_for('manage_users'), follow_redirects=True)
    assert response.status_code == 200
    assert url_for('login') in response.request.path # Redirect to login
    assert b'Please log in to access this page' in response.data

def test_admin_required_allows_admin_access(client, app):
    # Log in as an admin user
    client.post(url_for('login'), data={'username': 'adminuser', 'password': 'adminpass'})

    response = client.get(url_for('manage_users'))
    assert response.status_code == 200
    assert b'Manage Users' in response.data # Check for content from users.html
    # Check if user list is present (e.g., testuser, adminuser)
    assert b'testuser' in response.data
    assert b'adminuser' in response.data
