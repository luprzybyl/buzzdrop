"""
Keeps docs/how-it-works.md and the /how-it-works page in step with the code
that defines the flow they explain (#245).

The doc carries a fingerprint: a hash of the recorded protocol contract, the
browser crypto, the CLI's crypto, upload and passphrase code, the web app's
passphrase length, the database schema, the key-release defaults, and the
server code that releases, serves, expires and deletes a drop. When any of
them changes, this test fails until someone
has re-read the doc and the page against the change and pasted the new
fingerprint, the same way CI fails on stale fixtures.
"""
import ast
import hashlib
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DOC = ROOT / 'docs' / 'how-it-works.md'
PAGE = 'templates/_how_it_works_content.html'

FINGERPRINT = re.compile(r'<!-- how-it-works-fingerprint: sha256:([0-9a-f]{64}) -->')

# Whole files: any change to them can change what the flow does.
WHOLE_FILES = (
    'tests/js/fixtures/protocol-contract.json',
    'static/js/lib/crypto.js',
)

# Functions whose behaviour a claim rests on.
FUNCTIONS = {
    # The CLI's crypto and its two upload requests; the rest of cli/buzz
    # (wordlist, progress bar, token setup) doesn't change the flow.
    'cli/buzz': (
        '_derive_master', '_hkdf', 'derive_key_release_keys', '_derive_file_key',
        'encrypt_file', 'upload_begin', 'upload', 'generate_passphrase',
    ),
    # The routes behind each step: the pending sweep at begin, what upload
    # stores, the IP logged on release, the blob deleted after streaming,
    # the decryption report, manual delete and expiry.
    'app.py': (
        'upload_begin', 'upload_file', 'release_key', 'download_file',
        'report_decryption', 'delete_file', 'check_and_handle_expiry',
        'sweep_expired_files',
    ),
    # The transactions those routes run: what release wipes, what the
    # ticket claim stamps, what expiry and delete destroy.
    'db/sqlite_backend.py': (
        '_download_ticket', 'bind_key_verifier', 'attempt_key_release',
        'claim_download_with_ticket', 'record_decryption_result',
        'expire_unclaimed_releases', 'purge_stale_key_shares',
        'burn_key_share', 'delete',
    ),
}

# Lines of other files the doc quotes: the web app's passphrase length.
QUOTED_LINES = {
    'static/js/lib/passphrase.js': (r'^export const PASSPHRASE_WORDS = .*$',),
}

# What the server stores, and the defaults the doc quotes.
MODULE_ASSIGNMENTS = {
    'db/sqlite_backend.py': ('_FILES_DDL', '_FILE_KEYS_DDL'),
    'config.py': (
        'KEY_RELEASE_MAX_ATTEMPTS', 'KEY_RELEASE_BURN_ON_LOCKOUT',
        'KEY_RELEASE_DOWNLOAD_TTL_SECONDS', 'KEY_SHARE_PENDING_TTL_SECONDS',
        'EXPIRY_SWEEP_INTERVAL_SECONDS',
    ),
}


def _source_of(path, wanted, kinds):
    """The source of each top-level or class-level node named in ``wanted``."""
    source = (ROOT / path).read_text(encoding='utf-8')
    found = {}
    for node in ast.walk(ast.parse(source)):
        if not isinstance(node, kinds):
            continue
        if isinstance(node, ast.Assign):
            names = [t.id for t in node.targets if isinstance(t, ast.Name)]
        else:
            names = [node.name]
        for name in names:
            if name in wanted:
                assert name not in found, f'{path}: {name} is defined twice; fingerprint which one?'
                found[name] = ast.get_source_segment(source, node)
    missing = set(wanted) - set(found)
    assert not missing, f'{path}: no {sorted(missing)} to fingerprint; update {Path(__file__).name}'
    return [f'{path}:{name}\n{found[name]}' for name in wanted]


def compute_fingerprint():
    parts = [f'{path}\n{(ROOT / path).read_text(encoding="utf-8")}' for path in WHOLE_FILES]
    for path, names in FUNCTIONS.items():
        parts += _source_of(path, names, (ast.FunctionDef,))
    for path, names in MODULE_ASSIGNMENTS.items():
        parts += _source_of(path, names, (ast.Assign,))
    for path, patterns in QUOTED_LINES.items():
        text = (ROOT / path).read_text(encoding='utf-8')
        for pattern in patterns:
            match = re.search(pattern, text, re.M)
            assert match, f'{path}: nothing matches {pattern!r}; update {Path(__file__).name}'
            parts.append(f'{path}\n{match.group(0)}')
    return hashlib.sha256('\n\0\n'.join(parts).encode('utf-8')).hexdigest()


def test_explainer_is_in_step_with_the_flow():
    match = FINGERPRINT.search(DOC.read_text(encoding='utf-8'))
    assert match, f'{DOC.relative_to(ROOT)} has no how-it-works-fingerprint comment'

    current = compute_fingerprint()
    assert match.group(1) == current, (
        'The code behind the share flow changed since docs/how-it-works.md was '
        f'last reviewed. Re-read docs/how-it-works.md and {PAGE} against the '
        'change and fix whatever is no longer true; then set the fingerprint '
        f'in the doc to sha256:{current}'
    )

