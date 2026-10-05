"""
Render the DOM-test fixtures from the real Jinja templates.

Each fixture is the full HTML a browser receives from a real route,
requested through Flask's ``test_client`` against seeded, deterministic
state (docs/frontend-test-strategy.md §4). Output goes to
``tests/js/fixtures/html/<template>--<state>.html`` and is committed; CI
reruns this script and fails if the output changes (the drift check).

Determinism comes from the source: fixed users, file IDs, timestamps
and session CSRF token, and expiry dates far in the past or future so
``datetime.now()`` never changes a branch. Only the SRI/asset hashes are
rewritten afterwards, and ``<script src>`` tags and the import map are
stripped (tests import the page modules themselves, and the map would
churn whenever a JS file changes; JSON config blocks are kept).

Usage: python tests/fixtures/render_dom_fixtures.py   (or: npm run fixtures)
"""
import os
import re
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT_DIR = ROOT / 'tests' / 'js' / 'fixtures' / 'html'

# The developer's .env must not leak into fixtures: keep app.py's
# load_dotenv from reading it, and load only the committed example.
import dotenv  # noqa: E402

dotenv.load_dotenv(ROOT / '.env.example', override=False)
dotenv.load_dotenv = lambda *args, **kwargs: False

for key in [k for k in os.environ if k.startswith('FLASK_USER_')]:
    del os.environ[key]
os.environ.update({
    'FLASK_ENV': 'testing',
    'FLASK_SECRET_KEY': 'dom-fixture-secret-key',
    'FLASK_USER_1': 'testuser:password:false',
    'FLASK_USER_2': 'adminuser:adminpass:true',
    'FLASK_USER_3': 'notifyuser:password:false:notify@example.test',
    'EXPIRY_SWEEP_INTERVAL_SECONDS': '0',
    'ALLOWED_EXTENSIONS': 'txt,pdf,png,jpg,jpeg,gif,doc,docx,xls,xlsx,mp4',
    'MAX_CONTENT_LENGTH': '104857600',
})

sys.path.insert(0, str(ROOT))

from app import app as flask_app, get_backend, limiter  # noqa: E402

CSRF_TOKEN = 'fixture-csrf-token'
PASSWORDS = {'testuser': 'password', 'adminuser': 'adminpass', 'notifyuser': 'password'}
CREATED_AT = '2025-01-01T12:00:00'
FUTURE = '2099-01-01T00:00:00'
PAST = '2000-01-01T00:00:00'
RECEIPT_HASH = 'ab' * 32


def _file(file_id, name, **fields):
    record = {
        'id': file_id,
        'original_name': name,
        'path': f'uploads/{file_id}',
        'uploaded_by': 'testuser',
        'created_at': CREATED_AT,
        'downloaded_at': None,
        'expiry_at': None,
        'status': 'active',
        'type': 'file',
        'receipt_hash': RECEIPT_HASH,
    }
    record.update(fields)
    return record


# One row per status the index list renders, plus a file shared with
# testuser by another account.
LISTED_FILES = [
    _file('00000000-0000-4000-8000-000000000001', 'report.pdf', expiry_at=FUTURE),
    _file('00000000-0000-4000-8000-000000000002', 'Secret Note', type='text',
          private_note='For the auditor'),
    _file('00000000-0000-4000-8000-000000000003', 'photo.png',
          downloaded_at='2025-01-02T09:30:00', downloaded_by_ip='203.0.113.7'),
    _file('00000000-0000-4000-8000-000000000004', 'old.txt',
          expiry_at=PAST, status='expired'),
    _file('00000000-0000-4000-8000-000000000005', 'shared.docx',
          uploaded_by='adminuser', shared_with=['testuser']),
]
# One existing token so the /users token table renders a row.
API_TOKENS = [{
    'token_hash': 'cd' * 32,
    'username': 'testuser',
    'created_at': CREATED_AT,
    'last_used_at': None,
    'expires_at': FUTURE,
}]
SHARE_FILE = _file('00000000-0000-4000-8000-0000000000f1', 'contract.pdf')
SHARE_TEXT = _file('00000000-0000-4000-8000-0000000000f2', 'Secret Note', type='text')

SCRIPT_SRC_TAG = re.compile(r'[ \t]*<script\b[^>]*\bsrc=[^>]*>\s*</script>[ \t]*\n?')
IMPORT_MAP_TAG = re.compile(r'[ \t]*<script type="importmap">.*?</script>[ \t]*\n?', re.DOTALL)
SRI_HASH = re.compile(r'sha384-[A-Za-z0-9+/=%]+')


def _reset(files, tokens=()):
    limiter.reset()
    with flask_app.app_context():
        backend = get_backend()
        backend.files.truncate()
        backend.tokens.truncate()
        for record in files:
            backend.files.insert(dict(record))
        for doc_id, token in enumerate(tokens, start=1):
            backend.tokens.insert(dict(token), doc_id=doc_id)


def _client(username=None):
    client = flask_app.test_client()
    if username:
        response = client.post('/login', data={
            'username': username, 'password': PASSWORDS[username]})
        assert response.status_code == 302, f'login failed for {username}'
    with client.session_transaction() as session:
        session['csrf_token'] = CSRF_TOKEN
    return client


def _clean(html):
    html = SCRIPT_SRC_TAG.sub('', html)
    html = IMPORT_MAP_TAG.sub('', html)
    return SRI_HASH.sub('sha384-FIXTURE', html)


def _render(name, client, method, path, data=None):
    response = client.open(path, method=method, data=data)
    assert response.status_code == 200, f'{name}: {method} {path} -> {response.status_code}'
    return name, _clean(response.get_data(as_text=True))


def render_all():
    fixtures = []

    _reset([])
    fixtures.append(_render('index--anonymous', _client(), 'GET', '/'))
    fixtures.append(_render('index--empty', _client('testuser'), 'GET', '/'))
    fixtures.append(_render('index--admin', _client('adminuser'), 'GET', '/'))
    fixtures.append(_render('index--notification-email', _client('notifyuser'), 'GET', '/'))

    _reset(LISTED_FILES)
    fixtures.append(_render('index--files', _client('testuser'), 'GET', '/'))

    _reset([], API_TOKENS)
    fixtures.append(_render('users--admin', _client('adminuser'), 'GET', '/users'))

    for kind, record in (('file', SHARE_FILE), ('text', SHARE_TEXT)):
        _reset([record])
        view_path = f"/view/{record['id']}"
        fixtures.append(_render(f'confirm_download--{kind}', _client(), 'GET', view_path))
        fixtures.append(_render(f'view--{kind}', _client(), 'POST', f'{view_path}/confirm',
                                data={'csrf_token': CSRF_TOKEN}))
        fixtures.append(_render(f'success--{kind}', _client('testuser'), 'GET',
                                f"/success/{record['id']}"))
    return fixtures


def main():
    with tempfile.TemporaryDirectory() as tmp:
        flask_app.config.update({
            'TESTING': True,
            'DATABASE_URL': f'sqlite:///{tmp}/fixtures.db',
            'UPLOAD_FOLDER': tmp,
        })
        with flask_app.app_context():
            flask_app.backend = get_backend()
        try:
            fixtures = render_all()
            if fixtures != render_all():
                sys.exit('render_dom_fixtures: output differs between two runs')
        finally:
            with flask_app.app_context():
                flask_app.backend.close()

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for stale in OUT_DIR.glob('*.html'):
        stale.unlink()
    for name, html in fixtures:
        (OUT_DIR / f'{name}.html').write_text(html, encoding='utf-8')
    print(f'Wrote {len(fixtures)} fixtures to {OUT_DIR.relative_to(ROOT)}')


if __name__ == '__main__':
    main()
