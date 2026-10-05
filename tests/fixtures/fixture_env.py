"""
The deterministic environment both fixture generators import ``app`` under.

Importing this module (before ``app``) keeps the developer's .env out of
the generated fixtures: ``app.py``'s load_dotenv is disabled, only the
committed .env.example is loaded, and the users and limits the fixtures
rely on are set explicitly.
"""
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

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

PASSWORDS = {'testuser': 'password', 'adminuser': 'adminpass', 'notifyuser': 'password'}
CSRF_TOKEN = 'fixture-csrf-token'
