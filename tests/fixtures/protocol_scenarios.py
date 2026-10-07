"""
The protocol scenarios the JS protocol fake is held to.

Each scenario is a named request sequence that ``record_protocol_contract.py``
replays against a fresh server, recording every response into
``tests/js/fixtures/protocol-contract.json``; the JS contract test replays
the same requests against the fake and must get the same answers
(docs/frontend-test-strategy.md §6).

A scenario is a dict:

- ``name``: unique, kebab-case.
- ``config``: optional ``app.config`` overrides for this scenario only
  (``KEY_RELEASE_MAX_ATTEMPTS``, ``KEY_RELEASE_BURN_ON_LOCKOUT``,
  ``MAX_CONTENT_LENGTH``, the rate limits).
- ``steps``: the requests, in order. A step is a dict with ``name``,
  ``method`` and ``path``, and optionally ``headers``, ``json`` (a JSON
  body), ``form`` (multipart fields), ``files`` (multipart files, as
  ``{field: {"filename": ..., "content": <text>}}``), ``as`` (the
  account the step is sent as; default ``testuser``, ``None`` for an
  anonymous request) and ``injected`` (see below).

A later step refers to an earlier step's JSON response field with
``{"$ref": "<step>.<field>"}``, anywhere in ``path`` (a list of parts) or
in a ``json``/``form`` value.

``injected: True`` marks a response the fake cannot produce from its own
state (413, rate-limit 429): the fake's replay injects it with
``failNext(route, status)``, which defaults to this recorded body.

The server never checks crypto, so verifiers and receipt hashes are fixed
64-hex dummies; the one receipt that must hash to a stored
``receipt_hash`` is ``RECEIPT``.
"""
import base64
import hashlib

from fixture_env import CSRF_TOKEN

V = '11' * 32
WRONG_V = '22' * 32
RECEIPT = '33' * 32
RECEIPT_HASH = hashlib.sha256(bytes.fromhex(RECEIPT)).hexdigest()
WRONG_RECEIPT = '44' * 32
FILE_CONTENT = 'BKV3 dummy ciphertext'
NOTE_BYTES = b'BKV3 dummy note ciphertext'
PAST_EXPIRY = '2000-01-01T00:00'
MISSING_ID = '00000000-0000-4000-8000-00000000dead'

# What the browser sends: index-page.js sets both on begin and on the
# upload XHR; view-page.js sets X-Requested-With on /release only.
XHR = {'X-Requested-With': 'XMLHttpRequest'}
SESSION_XHR = {**XHR, 'X-CSRF-Token': CSRF_TOKEN}
JSON_XHR = {**XHR, 'Content-Type': 'application/json'}
JSON = {'Content-Type': 'application/json'}


def ref(field):
    return {'$ref': field}


def file_id(share):
    """The file_id a ``share`` step minted, or ``share`` itself if it is a literal ID."""
    return share if share == MISSING_ID else ref(f'{share}.file_id')


def begin(name='begin', **extra):
    return {'name': name, 'method': 'POST', 'path': ['/upload/begin'],
            'headers': SESSION_XHR, **extra}


def upload_file(name='upload', share='begin', verifier=V, **form):
    return {
        'name': name, 'method': 'POST', 'path': ['/upload'], 'headers': SESSION_XHR,
        'form': {'file_id': ref(f'{share}.file_id'), 'key_verifier': verifier,
                 'receipt_hash': RECEIPT_HASH, **form},
        'files': {'file': {'filename': 'report.pdf', 'content': FILE_CONTENT}},
    }


def upload_note(name='upload', share='begin'):
    return {
        'name': name, 'method': 'POST', 'path': ['/upload'], 'headers': SESSION_XHR,
        'form': {'note_text': base64.b64encode(NOTE_BYTES).decode(), 'type': 'text',
                 'file_id': ref(f'{share}.file_id'), 'key_verifier': V,
                 'receipt_hash': RECEIPT_HASH},
    }


def download(name='download', share='begin', ticket='release', raw=None):
    """GET /download. ``ticket`` names the release step whose ``ticket``
    response field goes into the X-Download-Ticket header — the credential
    /download demands since the blob is served only after a key release.
    ``raw`` sends a literal header value (a wrong ticket); ``ticket=None``
    sends no header at all.
    """
    step = {'name': name, 'method': 'GET', 'as': None,
            'path': ['/download/', file_id(share)]}
    if raw is not None:
        step['headers'] = {'X-Download-Ticket': raw}
    elif ticket is not None:
        step['headers'] = {'X-Download-Ticket': ref(f'{ticket}.ticket')}
    return step


def release(name='release', share='begin', v=V):
    return {'name': name, 'method': 'POST', 'as': None, 'headers': JSON_XHR,
            'path': ['/release/', file_id(share)], 'json': {'v': v}}


def report(name='report', share='begin', **body):
    return {'name': name, 'method': 'POST', 'as': None, 'headers': JSON,
            'path': ['/report_decryption/', file_id(share)],
            'json': {'success': True, 'receipt': RECEIPT, **body}}


SCENARIOS = [
    # --- Happy paths -------------------------------------------------------
    {
        'name': 'file-round-trip',
        'steps': [begin(), upload_file(), release(), download(), report(),
                  download('download-again'), release('release-again')],
    },
    {
        'name': 'note-round-trip',
        'steps': [begin(), upload_note(), release(), download(), report()],
    },
    {
        'name': 'report-first-valid-wins',
        'steps': [begin(), upload_file(), release(), report(),
                  report('report-again', success=False)],
    },

    # --- Release: wrong password, lockout, expiry, missing -----------------
    {
        'name': 'release-wrong-v-then-right',
        'config': {'KEY_RELEASE_MAX_ATTEMPTS': 3},
        'steps': [begin(), upload_file(), release('wrong', v=WRONG_V),
                  release('wrong-again', v=WRONG_V), release()],
    },
    {
        'name': 'release-lockout-burn-off',
        'config': {'KEY_RELEASE_MAX_ATTEMPTS': 2, 'KEY_RELEASE_BURN_ON_LOCKOUT': False},
        'steps': [begin(), upload_file(), release('wrong', v=WRONG_V),
                  release('locking', v=WRONG_V), release('right-after-lockout')],
    },
    {
        'name': 'release-lockout-burn-on',
        'steps': [begin(), upload_file(), release('locking', v=WRONG_V),
                  release('right-after-burn')],
    },
    {
        'name': 'release-expired',
        'steps': [begin(), upload_file(expiry=PAST_EXPIRY), release('expired'),
                  release('expired-again'), download(ticket=None)],
    },
    {
        'name': 'release-missing-or-pending',
        'steps': [release('missing-file', share=MISSING_ID),
                  begin('begin-unfinished'),
                  release('pending', share='begin-unfinished')],
    },
    {
        'name': 'release-invalid-verifier',
        'steps': [begin(), upload_file(), release('short-v', v='abc'),
                  {**release('no-body'), 'json': None, 'headers': XHR}],
    },

    # --- Upload: enforcement -----------------------------------------------
    {
        'name': 'upload-csrf',
        'steps': [begin('begin-no-csrf', headers=XHR), begin(),
                  {**upload_file(), 'headers': XHR}],
    },
    {
        'name': 'upload-invalid-material',
        'steps': [begin(), upload_file(verifier='not-hex')],
    },
    {
        'name': 'upload-refinish',
        'steps': [begin(), upload_file(), upload_note('refinish')],
    },
    {
        'name': 'upload-unknown-share',
        'steps': [{**upload_file(), 'form': {
            'file_id': MISSING_ID, 'key_verifier': V, 'receipt_hash': RECEIPT_HASH}}],
    },
    {
        # Open notifications are checked before the key material: only to the
        # account's own configured email, and only when SMTP is configured.
        'name': 'upload-notify-on-open',
        'steps': [
            begin(), upload_file('no-account-email', notify_on_open='true'),
            begin('begin-notify', **{'as': 'notifyuser'}),
            {**upload_file('other-email', share='begin-notify', notify_on_open='true',
                           notification_email='other@example.test'), 'as': 'notifyuser'},
            {**upload_file('own-email', share='begin-notify', notify_on_open='true',
                           notification_email='notify@example.test'), 'as': 'notifyuser'},
        ],
    },
    {
        'name': 'upload-notify-unconfigured',
        'config': {'SMTP_HOST': None},
        'steps': [begin(**{'as': 'notifyuser'}),
                  {**upload_file(notify_on_open='true'), 'as': 'notifyuser'}],
    },
    {
        'name': 'upload-other-owner',
        'steps': [begin(**{'as': 'adminuser'}), upload_file()],
    },

    # --- Download / report edge cases --------------------------------------
    {
        'name': 'download-missing',
        'steps': [download('missing-file', share=MISSING_ID, ticket=None),
                  begin('begin-unfinished'),
                  download('pending', share='begin-unfinished', ticket=None)],
    },
    {
        # The blob is gated by the one-time ticket the winning /release
        # mints: no header or a wrong one is a 403, and the share is NOT
        # consumed — the same ticket then serves it.
        'name': 'download-requires-ticket',
        'steps': [begin(), upload_file(),
                  download('no-ticket', ticket=None),
                  download('wrong-ticket', raw='ef' * 32),
                  release(), download()],
    },
    {
        'name': 'report-enforcement',
        'steps': [report('missing-file', share=MISSING_ID), begin(), upload_file(),
                  report('wrong-receipt', receipt=WRONG_RECEIPT),
                  report('no-success', success='yes')],
    },

    # --- Injected: body size and rate limits -------------------------------
    {
        'name': 'upload-too-large',
        'config': {'MAX_CONTENT_LENGTH': 64},
        'steps': [begin(), {**upload_file(), 'injected': True}],
    },
    {
        'name': 'rate-limit-upload-begin',
        'config': {'UPLOAD_RATE_LIMIT': '1 per minute'},
        'steps': [begin(), {**begin('begin-limited'), 'injected': True}],
    },
    {
        'name': 'rate-limit-upload',
        'config': {'UPLOAD_RATE_LIMIT': '1 per minute'},
        'steps': [begin(), upload_file(), {**upload_file('upload-limited'), 'injected': True}],
    },
    {
        'name': 'rate-limit-download',
        'config': {'PUBLIC_FILE_RATE_LIMIT': '1 per minute'},
        'steps': [begin(), upload_file(), release(), download(),
                  {**download('download-limited'), 'injected': True}],
    },
    {
        'name': 'rate-limit-release',
        'config': {'KEY_RELEASE_RATE_LIMIT': '1 per minute', 'KEY_RELEASE_MAX_ATTEMPTS': 3},
        'steps': [begin(), upload_file(), release('wrong', v=WRONG_V),
                  {**release('release-limited'), 'injected': True}],
    },
    {
        'name': 'rate-limit-report',
        'config': {'REPORT_DECRYPTION_RATE_LIMIT': '1 per minute'},
        'steps': [begin(), upload_file(), report(),
                  {**report('report-limited'), 'injected': True}],
    },
]
