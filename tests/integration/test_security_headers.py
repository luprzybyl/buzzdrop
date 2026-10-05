"""
Integration tests for the baseline security headers (issue #131).

The ``set_security_headers`` after_request hook emits CSP, X-Frame-Options,
X-Content-Type-Options, Referrer-Policy, HSTS, and Permissions-Policy on
every response. These tests assert the headers on representative routes and
that the markup stays compatible with ``script-src 'self'`` (no inline
executable <script> and no inline on* handlers — only static SRI'd files
and type="application/json" data islands).
"""
import base64
import hashlib
import re
from io import BytesIO


EXPECTED_HEADERS = [
    'Content-Security-Policy',
    'X-Frame-Options',
    'X-Content-Type-Options',
    'Referrer-Policy',
    'Strict-Transport-Security',
    'Permissions-Policy',
]


def _login(client):
    with client.session_transaction() as sess:
        sess['username'] = 'testuser'
        sess['is_admin'] = False


def _upload_file(client, key_release_upload):
    """Upload a file via the two-phase flow and return its file_id."""
    file_id, _h, _receipt, response = key_release_upload()
    assert response.status_code == 200
    return file_id


def _assert_no_inline_script(response):
    """
    Every <script> tag must either load an external file (src=...), be a
    non-executable data island (type="application/json"), or be an inline
    block whose SHA-256 the response's CSP allows (base.html's import map).
    Anything else is inline JS, which CSP script-src 'self' forbids.
    """
    html = response.data.decode('utf-8')
    csp = response.headers['Content-Security-Policy']
    for tag, content in re.findall(r'(<script[^>]*>)(.*?)</script>', html, re.DOTALL):
        if 'src=' in tag or 'type="application/json"' in tag:
            continue
        digest = base64.b64encode(hashlib.sha256(content.encode('utf-8')).digest()).decode()
        assert f"'sha256-{digest}'" in csp, f"inline <script> blocked by CSP: {tag}"


def _assert_no_inline_handlers(html):
    """Inline event-handler attributes are also blocked by CSP."""
    assert not re.search(r'\son[a-z]+\s*=', html, re.IGNORECASE), \
        "inline event handler attribute found"


def test_index_has_all_security_headers(client):
    response = client.get('/')
    assert response.status_code == 200
    for header in EXPECTED_HEADERS:
        assert header in response.headers, f"{header} missing from /"


def test_login_has_all_security_headers(client):
    response = client.get('/login')
    assert response.status_code == 200
    for header in EXPECTED_HEADERS:
        assert header in response.headers, f"{header} missing from /login"


def test_view_page_has_all_security_headers(client, key_release_upload):
    _login(client)
    file_id = _upload_file(client, key_release_upload)

    response = client.get(f'/view/{file_id}')
    assert response.status_code == 200
    for header in EXPECTED_HEADERS:
        assert header in response.headers, \
            f"{header} missing from /view/<id>"


def test_security_headers_on_json_endpoint(client, key_release_upload):
    """Headers apply to API/JSON responses too, not just HTML pages."""
    _login(client)
    file_id = _upload_file(client, key_release_upload)

    response = client.post(f'/release/{file_id}', json={'v': 'cc' * 32})
    for header in EXPECTED_HEADERS:
        assert header in response.headers, \
            f"{header} missing from /release/<id>"


def test_csp_policy_directives(client):
    response = client.get('/')
    csp = response.headers['Content-Security-Policy']

    # All markup ships scripts as SRI'd static files — no inline escape
    # hatch beyond the import map's own hash.
    assert "script-src 'self'" in csp
    script_src = re.search(r"script-src ([^;]*)", csp).group(1)
    assert "'unsafe-inline'" not in script_src

    # Templates still use inline style attributes — keep style-src honest.
    assert "style-src 'self' 'unsafe-inline'" in csp

    # Clickjacking guard and lockdown directives.
    assert "frame-ancestors 'none'" in csp
    assert "object-src 'none'" in csp
    assert "base-uri 'none'" in csp
    assert "form-action 'self'" in csp
    assert "default-src 'self'" in csp


def test_frame_deny_headers(client):
    """X-Frame-Options backs up frame-ancestors for older browsers."""
    response = client.get('/login')
    assert response.headers['X-Frame-Options'] == 'DENY'


def test_referrer_policy(client):
    """Share links must not leak via the Referer header."""
    response = client.get('/')
    assert response.headers['Referrer-Policy'] == 'no-referrer'


def test_hsts_header(client):
    response = client.get('/')
    hsts = response.headers['Strict-Transport-Security']
    assert 'max-age=' in hsts
    max_age = int(re.search(r'max-age=(\d+)', hsts).group(1))
    assert max_age >= 86400, "HSTS max-age should be meaningful"


def test_nosniff_header(client):
    response = client.get('/')
    assert response.headers['X-Content-Type-Options'] == 'nosniff'


def test_permissions_policy_is_restrictive(client):
    response = client.get('/')
    policy = response.headers['Permissions-Policy']
    for feature in ('camera', 'microphone', 'geolocation', 'payment'):
        assert f'{feature}=()' in policy


def test_no_inline_scripts_in_templates(client, key_release_upload):
    """The rendered pages must not rely on inline JS that CSP blocks."""
    _login(client)

    for path in ('/', '/login'):
        response = client.get(path)
        _assert_no_inline_script(response)
        _assert_no_inline_handlers(response.data.decode('utf-8'))

    # /view/<id> (confirm_download.html) — the page that used to carry an
    # inline fragment→sessionStorage script.
    file_id = _upload_file(client, key_release_upload)
    response = client.get(f'/view/{file_id}')
    html = response.data.decode('utf-8')
    _assert_no_inline_script(response)
    _assert_no_inline_handlers(html)
    assert 'js/confirm-download.js' in html

    # view.html — the page that used to inject window.* URLs inline.
    response = client.post(
        f'/view/{file_id}/confirm',
        data={'csrf_token': 'test-csrf-token'},
    )
    html = response.data.decode('utf-8')
    _assert_no_inline_script(response)
    _assert_no_inline_handlers(html)
    assert 'id="view-config-json"' in html


def test_upload_endpoints_json_islands_render(client):
    """index.html must inject upload endpoints as a JSON data island."""
    _login(client)
    html = client.get('/').data.decode('utf-8')

    match = re.search(
        r'<script[^>]*id="upload-endpoints-json"[^>]*type="application/json"[^>]*>'
        r'(.*?)</script>',
        html, re.DOTALL)
    assert match, "upload-endpoints-json data island missing"

    import json
    endpoints = json.loads(match.group(1))
    assert endpoints['uploadUrl'] == '/upload'
    assert endpoints['uploadBeginUrl'] == '/upload/begin'


def test_key_release_no_store_still_applied(client, key_release_upload):
    """The pre-existing no-store hook must keep working alongside the new one."""
    _login(client)
    file_id = _upload_file(client, key_release_upload)

    response = client.post(f'/release/{file_id}', json={'v': 'cc' * 32})
    assert response.headers['Cache-Control'] == 'no-store'

    response = client.post('/upload/begin', headers={
        'X-CSRF-Token': 'test-csrf-token',
    })
    assert response.headers['Cache-Control'] == 'no-store'
