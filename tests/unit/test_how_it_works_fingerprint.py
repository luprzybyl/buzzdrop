"""
Keeps docs/how-it-works.md and the /how-it-works page in step with the code
that defines the flow they explain (#245).

The doc carries a fingerprint: a hash of the recorded protocol contract, the
browser crypto, the CLI's crypto, upload and passphrase code, the web app's
passphrase length, the database schema and the key-release defaults. When any of them changes, this test fails until someone
has re-read the doc and the page against the change and pasted the new
fingerprint, the same way CI fails on stale fixtures.
"""
import ast
import hashlib
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DOC = ROOT / 'docs' / 'how-it-works.md'
PAGE = 'templates/how_it_works.html'

FINGERPRINT = re.compile(r'<!-- how-it-works-fingerprint: sha256:([0-9a-f]{64}) -->')

# Whole files: any change to them can change what the flow does.
WHOLE_FILES = (
    'tests/js/fixtures/protocol-contract.json',
    'static/js/lib/crypto.js',
)

# The CLI's crypto and its two upload requests; the rest of cli/buzz
# (wordlist, progress bar, token setup) doesn't change the flow.
CLI_FUNCTIONS = (
    '_derive_master', '_hkdf', 'derive_key_release_keys', '_derive_file_key',
    'encrypt_file', 'upload_begin', 'upload', 'generate_passphrase',
)

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
    parts += _source_of('cli/buzz', CLI_FUNCTIONS, (ast.FunctionDef,))
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


def test_page_has_the_doc_steps_in_order():
    step_id = re.compile(r'id="(step-[a-z-]+)"')
    doc_steps = step_id.findall(DOC.read_text(encoding='utf-8'))
    page_steps = [i for i in step_id.findall((ROOT / PAGE).read_text(encoding='utf-8'))
                  if not i.endswith('-title')]

    assert doc_steps, 'docs/how-it-works.md has no step anchors'
    assert page_steps == doc_steps
