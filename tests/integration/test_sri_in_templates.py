"""
Integration tests for Subresource Integrity (SRI) in rendered templates.

Tests verify that:
1. SRI integrity attributes are present in HTML
2. crossorigin attributes are set correctly
3. All JavaScript files have SRI protection
"""
import re
import pytest
from io import BytesIO


def test_index_page_has_sri_for_main_js(client):
    """Test that index page includes SRI integrity check for main.js."""
    # Login to access the page
    client.post('/login', data={
        'username': 'testuser',
        'password': 'password'
    }, follow_redirects=True)
    
    response = client.get('/')
    assert response.status_code == 200
    
    html = response.data.decode('utf-8')
    
    # Check for integrity attribute with sha384
    assert 'integrity="sha384-' in html, "main.js should have integrity attribute"
    
    # Check for crossorigin attribute
    assert 'crossorigin="anonymous"' in html, "main.js should have crossorigin attribute"
    
    # Verify the script tag structure
    pattern = r'<script[^>]*src="[^"]*js/main\.js"[^>]*integrity="sha384-[A-Za-z0-9+/=]+"[^>]*crossorigin="anonymous"[^>]*>'
    assert re.search(pattern, html), "main.js script tag should have correct SRI attributes"


def test_view_page_has_sri_for_view_js(client, db_instance, files_table):
    """Test that view page includes SRI integrity check for view.js."""
    # Login first
    with client.session_transaction() as sess:
        sess['username'] = 'testuser'
        sess['is_admin'] = False
    
    # Upload a test file
    client.post('/upload', data={
        'file': (BytesIO(b'test content'), 'test.txt'),
        'expiry': ''
    }, content_type='multipart/form-data')
    
    # Get file_id from database
    from tinydb import Query
    File = Query()
    file_info = files_table.get(File.original_name == 'test.txt')
    assert file_info is not None
    file_id = file_info['id']
    
    # Visit the confirm view page (this renders view.html)
    response = client.post(f'/view/{file_id}/confirm', follow_redirects=False)
    assert response.status_code == 200
    
    html = response.data.decode('utf-8')
    
    # Check for integrity attribute
    assert 'integrity="sha384-' in html, "view.js should have integrity attribute"
    assert 'crossorigin="anonymous"' in html, "view.js should have crossorigin attribute"
    
    # Verify the script tag structure
    pattern = r'<script[^>]*src="[^"]*js/view\.js"[^>]*integrity="sha384-[A-Za-z0-9+/=]+"[^>]*crossorigin="anonymous"[^>]*>'
    assert re.search(pattern, html), "view.js script tag should have correct SRI attributes"


def test_success_page_has_sri_for_success_js(client, db_instance, files_table):
    """Test that success page includes SRI integrity check for success.js."""
    with client.session_transaction() as sess:
        sess['username'] = 'testuser'
        sess['is_admin'] = False
    
    # Upload a test file to get to success page
    client.post('/upload', data={
        'file': (BytesIO(b'test content'), 'success_test.txt'),
        'expiry': ''
    }, content_type='multipart/form-data')
    
    # Get file_id from database
    from tinydb import Query
    File = Query()
    file_info = files_table.get(File.original_name == 'success_test.txt')
    assert file_info is not None
    file_id = file_info['id']
    
    # Visit success page
    response = client.get(f'/success/{file_id}')
    assert response.status_code == 200
    
    html = response.data.decode('utf-8')
    
    # Check for integrity attribute
    assert 'integrity="sha384-' in html, "success.js should have integrity attribute"
    assert 'crossorigin="anonymous"' in html, "success.js should have crossorigin attribute"
    
    # Verify the script tag structure
    pattern = r'<script[^>]*src="[^"]*js/success\.js"[^>]*integrity="sha384-[A-Za-z0-9+/=]+"[^>]*crossorigin="anonymous"[^>]*>'
    assert re.search(pattern, html), "success.js script tag should have correct SRI attributes"


def test_sri_hashes_are_valid_base64(client):
    """Test that all SRI hashes in HTML are valid base64."""
    client.post('/login', data={
        'username': 'testuser',
        'password': 'password'
    }, follow_redirects=True)
    
    response = client.get('/')
    html = response.data.decode('utf-8')
    
    # Extract all integrity values
    integrity_pattern = r'integrity="(sha384-[A-Za-z0-9+/=]+)"'
    matches = re.findall(integrity_pattern, html)
    
    assert len(matches) > 0, "Should find at least one integrity attribute"
    
    for integrity_value in matches:
        # Verify format
        assert integrity_value.startswith('sha384-'), "Should use SHA-384"
        
        # Extract base64 part
        hash_value = integrity_value.replace('sha384-', '')
        
        # Verify it's valid base64 (SHA-384 produces 48 bytes = 64 base64 chars)
        assert len(hash_value) == 64, f"Hash should be 64 characters: {hash_value}"
        
        # Verify base64 character set
        import base64
        try:
            decoded = base64.b64decode(hash_value)
            assert len(decoded) == 48, "SHA-384 should produce 48 bytes"
        except Exception as e:
            pytest.fail(f"Invalid base64 in hash: {hash_value}, error: {e}")


def test_module_scripts_maintain_type_attribute(client):
    """Test that ES6 module scripts still have type='module' attribute along with SRI."""
    client.post('/login', data={
        'username': 'testuser',
        'password': 'password'
    }, follow_redirects=True)
    
    response = client.get('/')
    html = response.data.decode('utf-8')
    
    # Check that main.js has both type="module" and integrity
    assert 'type="module"' in html, "Should maintain ES6 module support"
    assert 'integrity="sha384-' in html, "Should have SRI"
    
    # Verify both are on the same script tag for main.js
    pattern = r'<script[^>]*type="module"[^>]*src="[^"]*js/main\.js"[^>]*integrity="sha384-[^"]*"[^>]*>'
    assert re.search(pattern, html), "main.js should have both type='module' and integrity"
