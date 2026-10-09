"""
Record the protocol contract the JS protocol fake is held to.

Replays every scenario in ``protocol_scenarios.py`` through Flask's
``test_client`` (``follow_redirects=False``), each from a fresh server:
empty database, reset rate limiter, its own config overrides. Every
request and its response go to ``tests/js/fixtures/protocol-contract.json``,
which is committed; ``tests/js/integration/protocol-contract.test.js``
replays the same requests against the fake and compares
(docs/frontend-test-strategy.md §6). CI reruns this script and fails if
the output changes (the drift check).

Recorded per response: status, Content-Type, Location (when set),
Cache-Control on /release, and the body — parsed JSON for JSON responses,
base64 for any other body except a redirect's. Server-minted values are
normalised to ``<uuid>`` / ``<hex64>``. The script fails if a step raises
or if two runs differ.

Usage: python tests/fixtures/record_protocol_contract.py   (or: npm run fixtures)
"""
import base64
import hashlib
import hmac
import io
import json
import logging
import re
import sys
import tempfile

from fixture_env import CSRF_TOKEN, PASSWORDS, ROOT

from app import app as flask_app, get_backend, limiter
from auth import get_users
from protocol_scenarios import SCENARIOS

OUT_FILE = ROOT / 'tests' / 'js' / 'fixtures' / 'protocol-contract.json'
DEFAULT_USER = 'testuser'
# Recorded with every scenario, overridden or not: the fake takes them as
# its maxAttempts / burnOnLockout / downloadTtlSeconds options, plus
# NOTIFICATIONS_CONFIGURED (SMTP set up, as app.py's
# _notifications_configured decides) as notificationsConfigured.
FAKE_CONFIG = ('KEY_RELEASE_MAX_ATTEMPTS', 'KEY_RELEASE_BURN_ON_LOCKOUT',
               'KEY_RELEASE_DOWNLOAD_TTL_SECONDS')

UUID = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')
HEX64 = re.compile(r'\b[0-9a-f]{64}\b')


# _normalise, _resolve and _record are mirrored by normalise, resolve and
# toRecorded in tests/js/integration/protocol-contract.test.js: change them
# together.


def _normalise(value):
    if isinstance(value, str):
        return HEX64.sub('<hex64>', UUID.sub('<uuid>', value))
    if isinstance(value, dict):
        return {key: _normalise(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_normalise(item) for item in value]
    return value


def _download_ticket(h_hex):
    """The ticket /download requires, derived as the client derives it —
    RFC 5869 HKDF-SHA256(ikm=H, salt=zero, info='buzzdrop-download-ticket').
    Independent of db/sqlite_backend's copy, so a divergence breaks the
    recorded contract loudly."""
    prk = hmac.new(b'\x00' * 32, bytes.fromhex(h_hex), hashlib.sha256).digest()
    return hmac.new(prk, b'buzzdrop-download-ticket' + b'\x01',
                    hashlib.sha256).hexdigest()


def _resolve(value, responses):
    """Replace ``{"$ref": "<step>.<field>"}`` with that step's response
    field, and ``{"$ticket": "<step>"}`` with the download ticket derived
    from the H that step's release returned."""
    if isinstance(value, dict) and set(value) == {'$ref'}:
        step, field = value['$ref'].split('.', 1)
        return responses[step][field]
    if isinstance(value, dict) and set(value) == {'$ticket'}:
        return _download_ticket(responses[value['$ticket']]['h'])
    if isinstance(value, dict):
        return {key: _resolve(item, responses) for key, item in value.items()}
    if isinstance(value, list):
        return [_resolve(item, responses) for item in value]
    return value


def _client(username):
    client = flask_app.test_client()
    if username:
        response = client.post('/login', data={
            'username': username, 'password': PASSWORDS[username]})
        assert response.status_code == 302, f'login failed for {username}'
    with client.session_transaction() as session:
        session['csrf_token'] = CSRF_TOKEN
    return client


def _fresh_server(config):
    limiter.reset()
    with flask_app.app_context():
        backend = get_backend()
        backend.files.truncate()
        backend.tokens.truncate()
    flask_app.config.update(config)


def _send(client, step, responses):
    request = _resolve(step, responses)
    kwargs = {'headers': request.get('headers') or {}}
    if request.get('json') is not None:
        kwargs['data'] = json.dumps(request['json'])
    if 'form' in request or 'files' in request:
        data = dict(request.get('form') or {})
        for field, upload in (request.get('files') or {}).items():
            data[field] = (io.BytesIO(upload['content'].encode()), upload['filename'])
        kwargs['data'] = data
        kwargs['content_type'] = 'multipart/form-data'
    return client.open(''.join(request['path']), method=request['method'],
                       follow_redirects=False, **kwargs)


def _record(path, response):
    content_type = response.headers.get('Content-Type')
    recorded = {'status': response.status_code, 'headers': {'Content-Type': content_type}}
    if 'Location' in response.headers:
        recorded['headers']['Location'] = response.headers['Location']
    if path.startswith('/release/'):
        recorded['headers']['Cache-Control'] = response.headers.get('Cache-Control')
    if response.is_json:
        recorded['json'] = response.get_json()
    elif not 300 <= response.status_code < 400:
        recorded['bodyBase64'] = base64.b64encode(response.get_data()).decode()
    return _normalise(recorded)


def record_scenario(scenario):
    defaults = {key: flask_app.config.get(key) for key in scenario.get('config', {})}
    _fresh_server(scenario.get('config', {}))
    clients = {}
    responses = {}
    steps = []
    try:
        for step in scenario['steps']:
            username = step.get('as', DEFAULT_USER)
            if username not in clients:
                clients[username] = _client(username)
            request = {key: step[key] for key in
                       ('method', 'path', 'headers', 'json', 'form', 'files') if key in step}
            try:
                response = _send(clients[username], request, responses)
            except Exception as exc:
                raise RuntimeError(
                    f"{scenario['name']}/{step['name']}: the request raised") from exc
            if response.is_json:
                responses[step['name']] = response.get_json()
            steps.append({
                'name': step['name'],
                'as': username,
                **({'injected': True} if step.get('injected') else {}),
                'request': request,
                'response': _record(''.join(_resolve(request['path'], responses)), response),
            })
        config = {key: flask_app.config[key] for key in FAKE_CONFIG}
        config.update(scenario.get('config', {}))
        config['NOTIFICATIONS_CONFIGURED'] = bool(
            flask_app.config.get('SMTP_HOST') and flask_app.config.get('SMTP_FROM_EMAIL'))
    finally:
        flask_app.config.update(defaults)
    return {'name': scenario['name'], 'config': config, 'steps': steps}


def record_all():
    names = [scenario['name'] for scenario in SCENARIOS]
    assert len(names) == len(set(names)), 'scenario names must be unique'
    return {
        'csrfToken': CSRF_TOKEN,
        'defaultUser': DEFAULT_USER,
        # The fake's accountEmails option: who may ask for open notifications.
        'accountEmails': {name: user['email'] for name, user in sorted(get_users().items())
                          if user.get('email')},
        'scenarios': [record_scenario(scenario) for scenario in SCENARIOS],
    }


def main():
    # Release attempts log at INFO/WARNING; the recording is the output.
    flask_app.logger.setLevel(logging.ERROR)
    with tempfile.TemporaryDirectory() as tmp:
        flask_app.config.update({
            'TESTING': True,
            'DATABASE_URL': f'sqlite:///{tmp}/contract.db',
            'UPLOAD_FOLDER': tmp,
        })
        with flask_app.app_context():
            flask_app.backend = get_backend()
        try:
            contract = record_all()
            if contract != record_all():
                sys.exit('record_protocol_contract: output differs between two runs')
        finally:
            with flask_app.app_context():
                flask_app.backend.close()

    OUT_FILE.write_text(json.dumps(contract, indent=2) + '\n', encoding='utf-8')
    print(f"Recorded {len(contract['scenarios'])} scenarios to {OUT_FILE.relative_to(ROOT)}")


if __name__ == '__main__':
    main()
