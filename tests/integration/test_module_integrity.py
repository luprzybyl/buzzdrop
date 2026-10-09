"""
Integration tests for SRI over imported ES modules (issue #166).

Entry scripts carry an ``integrity`` attribute, but the modules they
``import`` (crypto.js, the page init modules, ...) are fetched by the
module loader, which never sees that attribute. base.html therefore
emits an import map whose ``integrity`` section pins every module under
static/js, and the CSP allows that one inline block by its SHA-256.
"""
import base64
import hashlib
import json
import re
from pathlib import Path

import pytest

JS_DIR = Path(__file__).resolve().parents[2] / 'static' / 'js'

IMPORT_MAP = re.compile(r'<script type="importmap">(.*?)</script>', re.DOTALL)
STATIC_IMPORT = re.compile(
    r"""^\s*(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]""",
    re.MULTILINE)


def _sri(path):
    return 'sha384-' + base64.b64encode(
        hashlib.sha384(path.read_bytes()).digest()).decode()


def _import_map(html):
    blocks = IMPORT_MAP.findall(html)
    assert len(blocks) == 1, 'expected exactly one import map'
    return blocks[0]


def _login(client):
    with client.session_transaction() as sess:
        sess['username'] = 'testuser'
        sess['is_admin'] = False


@pytest.mark.parametrize('path', ['/', '/login'])
def test_import_map_pins_every_static_module(client, path):
    html = client.get(path).data.decode('utf-8')
    integrity = json.loads(_import_map(html))['integrity']

    expected = {
        f'/static/js/{module.relative_to(JS_DIR).as_posix()}': _sri(module)
        for module in JS_DIR.rglob('*.js')
    }
    assert integrity == expected


def test_every_relative_import_is_pinned(client):
    """No module can be imported from a path the integrity map misses."""
    _login(client)
    integrity = json.loads(_import_map(client.get('/').data.decode('utf-8')))['integrity']

    for module in JS_DIR.rglob('*.js'):
        for specifier in STATIC_IMPORT.findall(module.read_text()):
            assert specifier.startswith('.'), \
                f'{module.name} imports a bare/absolute specifier: {specifier}'
            target = (module.parent / specifier).resolve()
            url = f'/static/js/{target.relative_to(JS_DIR).as_posix()}'
            assert url in integrity, f'{module.name} imports unpinned {url}'


def test_import_map_precedes_every_module_script(client):
    _login(client)
    html = client.get('/').data.decode('utf-8')

    map_at = html.index('<script type="importmap">')
    first_module_at = html.index('<script type="module"')
    assert map_at < first_module_at


def test_csp_allows_the_import_map_by_hash(client):
    response = client.get('/')
    content = _import_map(response.data.decode('utf-8'))
    digest = base64.b64encode(hashlib.sha256(content.encode('utf-8')).digest()).decode()

    script_src = re.search(
        r"script-src ([^;]*)", response.headers['Content-Security-Policy']).group(1)
    assert script_src.split() == ["'self'", f"'sha256-{digest}'"]


def test_import_map_tracks_module_changes(client, app, tmp_path, monkeypatch):
    """A changed module must change its pin, not keep a stale hash."""
    static = tmp_path / 'static'
    module = static / 'js' / 'lib' / 'crypto.js'
    module.parent.mkdir(parents=True)
    module.write_text('export const a = 1;\n')
    monkeypatch.setattr(app, 'static_folder', str(static))

    first = json.loads(_import_map(client.get('/login').data.decode('utf-8')))
    module.write_text('export const a = 2;\n')
    second = json.loads(_import_map(client.get('/login').data.decode('utf-8')))

    assert first['integrity']['/static/js/lib/crypto.js'] != second['integrity']['/static/js/lib/crypto.js']
    assert second['integrity']['/static/js/lib/crypto.js'] == _sri(module)


def test_non_html_responses_keep_the_base_csp(client):
    """Only pages that render the import map need its hash."""
    response = client.get('/static/js/lib/crypto.js')
    script_src = re.search(
        r"script-src ([^;]*)", response.headers['Content-Security-Policy']).group(1)
    assert script_src == "'self'"


def test_import_map_keys_follow_a_mounted_prefix(client):
    """Under a WSGI mount (Passenger), imports resolve below SCRIPT_NAME."""
    html = client.get('/login', base_url='http://localhost/buzz').data.decode('utf-8')
    integrity = json.loads(_import_map(html))['integrity']

    assert integrity
    assert all(url.startswith('/buzz/static/js/') for url in integrity)
