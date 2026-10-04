"""
SQLite storage backend for Buzzdrop.

Implements FileStore/TokenStore from db.base with stdlib sqlite3 — no ORM,
no extra dependencies. Records are typed columns; fields without a column
are preserved in an ``extra`` JSON column so the schema can grow.

Each thread gets its own connection (thread-local storage) with WAL mode
and a busy timeout, so concurrent writers serialize through SQLite locking
instead of racing a shared file. Per-thread connections live as long as
their worker threads; they are all closed by Backend.close().
"""
import json
import logging
import os
import re
import secrets
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime
from typing import Any, Dict, Iterable, List, Mapping, Optional, Tuple

from db.base import Backend, FileStore, TokenStore

_SQLITE_MAGIC = b'SQLite format 3\x00'

# SQLite variable limit is 999 (newer builds allow more); chunk well under it.
_MAX_VARS_PER_STATEMENT = 500

_SAFE_IDENTIFIER = re.compile(r'^[A-Za-z_][A-Za-z0-9_]*$')


def _is_iso_timestamp(value: Any) -> int:
    """SQLite UDF: 1 when the value parses as an ISO-8601 timestamp."""
    if not isinstance(value, str):
        return 0
    try:
        datetime.fromisoformat(value)
        return 1
    except ValueError:
        return 0

# Columns stored as INTEGER 0/1/NULL and decoded back to bool/None.
FILE_BOOL_COLUMNS = frozenset({'decryption_success', 'notify_on_open'})
# Columns stored as JSON text and decoded back to Python objects.
FILE_JSON_COLUMNS = frozenset({'shared_with'})
FILE_TEXT_COLUMNS = frozenset({
    'id', 'original_name', 'path', 'created_at', 'downloaded_at',
    'downloaded_by_ip', 'expiry_at', 'uploaded_by', 'status', 'type',
    'private_note', 'notification_email', 'notification_sent_at',
    'notification_claimed_at',
})
FILE_COLUMNS = FILE_BOOL_COLUMNS | FILE_JSON_COLUMNS | FILE_TEXT_COLUMNS

TOKEN_BOOL_COLUMNS = frozenset()
TOKEN_JSON_COLUMNS = frozenset()
TOKEN_TEXT_COLUMNS = frozenset({
    'token_hash', 'token_hash_version', 'username', 'created_at',
    'last_used_at', 'expires_at',
})
TOKEN_COLUMNS = TOKEN_BOOL_COLUMNS | TOKEN_JSON_COLUMNS | TOKEN_TEXT_COLUMNS

_FILES_DDL = """
CREATE TABLE IF NOT EXISTS files (
    doc_id INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT UNIQUE,
    original_name TEXT,
    path TEXT,
    created_at TEXT,
    downloaded_at TEXT,
    downloaded_by_ip TEXT,
    expiry_at TEXT,
    uploaded_by TEXT,
    status TEXT,
    decryption_success INTEGER,
    type TEXT,
    private_note TEXT,
    shared_with TEXT,
    notify_on_open INTEGER,
    notification_email TEXT,
    notification_sent_at TEXT,
    notification_claimed_at TEXT,
    extra TEXT
)
"""

_TOKENS_DDL = """
CREATE TABLE IF NOT EXISTS api_tokens (
    doc_id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash TEXT,
    token_hash_version TEXT,
    username TEXT,
    created_at TEXT,
    last_used_at TEXT,
    expires_at TEXT,
    extra TEXT
)
"""

_TOKENS_HASH_INDEX = """
CREATE INDEX IF NOT EXISTS idx_api_tokens_hash ON api_tokens (token_hash)
"""

# Columns addable via ALTER TABLE for databases created before they
# existed. Plain types only — UNIQUE/NOT NULL can't come through ALTER.
_FILE_MIGRATABLE_COLUMNS = {
    c: ('INTEGER' if c in FILE_BOOL_COLUMNS else 'TEXT')
    for c in FILE_COLUMNS
} | {'extra': 'TEXT'}
_TOKEN_MIGRATABLE_COLUMNS = {
    c: 'TEXT' for c in TOKEN_COLUMNS
} | {'extra': 'TEXT'}


def _add_missing_columns(conn: sqlite3.Connection, table: str,
                         columns: Dict[str, str]) -> None:
    """ALTER TABLE ADD COLUMN for columns missing from an existing table."""
    existing = {row[1] for row in conn.execute(f'PRAGMA table_info("{table}")')}
    for name, col_type in columns.items():
        if name not in existing:
            conn.execute(f'ALTER TABLE "{table}" ADD COLUMN "{name}" {col_type}')


def _table_columns(conn: sqlite3.Connection, table: str) -> List[sqlite3.Row]:
    return conn.execute(f'PRAGMA table_info("{table}")').fetchall()


def _rebuild_legacy_doc_table(conn: sqlite3.Connection, table: str,
                              ddl: str, known_columns: frozenset,
                              bool_columns: frozenset,
                              json_columns: frozenset) -> None:
    """Rebuild a legacy doc-blob table (doc_id, doc TEXT NOT NULL) into the
    typed-column schema, preserving doc_ids and migrating row data.

    Development versions of this backend stored each record as a JSON
    blob in a ``doc`` column. An old DB carried over crashes every insert
    with ``NOT NULL constraint failed: <table>.doc`` — detect the shape,
    rebuild, and re-import the JSON payloads.
    """
    # Whole rebuild in one transaction — the connection is autocommit,
    # so a mid-migration crash must not leave a renamed-away table.
    conn.execute('BEGIN IMMEDIATE')
    migrated = 0
    try:
        rows = conn.execute(f'SELECT doc_id, doc FROM "{table}"').fetchall()
        conn.execute(f'ALTER TABLE "{table}" RENAME TO "{table}_legacy"')
        conn.execute(ddl)
        for doc_id, doc_json in rows:
            try:
                doc = json.loads(doc_json)
            except (TypeError, json.JSONDecodeError):
                doc = None
            if not isinstance(doc, dict):
                logging.warning(
                    'Skipping unparseable legacy row doc_id=%s in %s',
                    doc_id, table,
                )
                continue
            known, extra = _split_doc(doc, known_columns)
            names = [c for c in known_columns if c in known]
            values = [
                _serialize_value(c, known[c], bool_columns, json_columns)
                for c in names
            ]
            if extra:
                names.append('extra')
                values.append(json.dumps(extra))
            names.insert(0, 'doc_id')
            values.insert(0, doc_id)
            placeholders = ', '.join('?' for _ in values)
            conn.execute(
                f'INSERT INTO "{table}" ({", ".join(names)}) '
                f'VALUES ({placeholders})',
                tuple(values),
            )
            migrated += 1
        conn.execute(f'DROP TABLE "{table}_legacy"')
    except Exception:
        conn.execute('ROLLBACK')
        raise
    else:
        conn.execute('COMMIT')
    logging.info('Migrated %d row(s) from legacy doc-blob table %r',
                 migrated, table)


def _guard_incompatible_columns(conn: sqlite3.Connection, table: str,
                                known_columns: frozenset) -> None:
    """Fail fast on NOT NULL columns the current schema doesn't write.

    A leftover NOT NULL column we never populate makes every insert fail
    with a cryptic IntegrityError — surface it as an actionable error.
    """
    allowed = set(known_columns) | {'doc_id', 'extra'}
    offenders = [
        row[1] for row in _table_columns(conn, table)
        if row[1] not in allowed and row[3] and row[4] is None
    ]
    if offenders:
        raise sqlite3.DatabaseError(
            f'Table {table!r} has NOT NULL column(s) the current schema '
            f'does not write: {", ".join(offenders)}. The database was '
            'created by an incompatible version — back it up and remove '
            'it, or migrate the data manually.'
        )

# Server-gated key release (docs/true-one-time.md §6): one row per
# oracle-enabled share, keyed by the public file id. `v` NULL marks a
# pending share (/upload/begin done, /upload/finish not yet); a row is
# deleted outright to burn H on lockout. Kept off the files table because
# the share must exist before the file record does (two-phase upload) —
# and so existing databases need no ALTER TABLE, just CREATE TABLE.
_FILE_KEYS_DDL = """
CREATE TABLE IF NOT EXISTS file_keys (
    doc_id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id TEXT UNIQUE,
    h TEXT,
    v TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    released_at TEXT,
    created_at TEXT
)
"""


def _serialize_value(column: str, value: Any,
                     bool_columns: frozenset,
                     json_columns: frozenset) -> Any:
    if value is None:
        return None
    if column in bool_columns:
        return 1 if value else 0
    if column in json_columns:
        return json.dumps(value)
    return value


def _split_doc(doc: Mapping[str, Any], known_columns: frozenset
               ) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    """Split a field dict into known columns and an `extra` overflow dict."""
    known: Dict[str, Any] = {}
    extra: Dict[str, Any] = {}
    for key, value in doc.items():
        if key == 'doc_id' or key == 'extra':
            logging.warning(
                'Document key %r conflicts with a reserved column name and '
                'was dropped on write', key,
            )
            continue
        if key in known_columns:
            known[key] = value
        else:
            extra[key] = value
    return known, extra


class _SQLiteStoreBase:
    """Shared row<->dict plumbing for the SQLite stores."""

    table: str = ''
    columns: frozenset = frozenset()
    bool_columns: frozenset = frozenset()
    json_columns: frozenset = frozenset()

    def __init__(self, backend: 'SQLiteBackend'):
        self._backend = backend

    def _conn(self) -> sqlite3.Connection:
        return self._backend._connection()

    # -- row mapping -----------------------------------------------------
    def _row_to_doc(self, row: sqlite3.Row) -> Dict[str, Any]:
        doc: Dict[str, Any] = {'doc_id': row['doc_id']}
        for column in self.columns:
            value = row[column]
            if column in self.bool_columns:
                doc[column] = None if value is None else bool(value)
            elif column in self.json_columns:
                doc[column] = None if value is None else json.loads(value)
            else:
                doc[column] = value
        if row['extra']:
            # setdefault: typed columns win over stale extra copies, so a
            # field promoted to a real column later is never shadowed.
            for key, value in json.loads(row['extra']).items():
                doc.setdefault(key, value)
        return doc

    def _doc_to_insert(self, doc: Mapping[str, Any],
                       doc_id: Optional[int]) -> Tuple[List[str], List[Any]]:
        known, extra = _split_doc(doc, self.columns)
        names = [c for c in self.columns if c in known]
        values = [
            _serialize_value(c, known[c], self.bool_columns, self.json_columns)
            for c in names
        ]
        if extra:
            names.append('extra')
            values.append(json.dumps(extra))
        if doc_id is not None:
            names.insert(0, 'doc_id')
            values.insert(0, doc_id)
        return names, values

    # -- shared helpers ----------------------------------------------------
    def _select(self, where: str = '', params: Tuple[Any, ...] = ()
                ) -> List[Dict[str, Any]]:
        sql = f'SELECT * FROM "{self.table}"'
        if where:
            sql += f' WHERE {where}'
        sql += ' ORDER BY doc_id'
        cursor = self._conn().execute(sql, params)
        return [self._row_to_doc(row) for row in cursor.fetchall()]

    def _filter_clause(self, filters: Mapping[str, Any],
                       ) -> Tuple[str, Tuple[Any, ...], Dict[str, Any]]:
        """
        Split equality filters into a SQL WHERE clause for known columns
        plus a leftover dict evaluated in Python.
        """
        clauses: List[str] = []
        params: List[Any] = []
        leftover: Dict[str, Any] = {}
        for key, value in filters.items():
            if key == 'doc_id':
                clauses.append('doc_id = ?')
                params.append(value)
            elif key in self.columns and key not in self.json_columns:
                if value is None:
                    clauses.append(f'"{key}" IS NULL')
                elif key in self.bool_columns:
                    clauses.append(f'"{key}" = ?')
                    params.append(1 if value else 0)
                else:
                    clauses.append(f'"{key}" = ?')
                    params.append(value)
            else:
                # JSON columns and unknown fields compare in Python
                leftover[key] = value
        return ' AND '.join(clauses), tuple(params), leftover

    @staticmethod
    def _match_leftover(doc: Dict[str, Any], leftover: Dict[str, Any]) -> bool:
        return all(doc.get(key) == value for key, value in leftover.items())

    def all(self) -> List[Dict[str, Any]]:
        return self._select()

    def list_by(self, **filters: Any) -> List[Dict[str, Any]]:
        where, params, leftover = self._filter_clause(filters)
        rows = self._select(where, params)
        if leftover:
            rows = [doc for doc in rows if self._match_leftover(doc, leftover)]
        return rows

    def get_by(self, **filters: Any) -> Optional[Dict[str, Any]]:
        rows = self.list_by(**filters)
        return rows[0] if rows else None

    def _update_by_clause(self, fields: Mapping[str, Any],
                          where: str, params: Tuple[Any, ...]) -> bool:
        assignments: List[str] = []
        values: List[Any] = []
        extra_updates: Dict[str, Any] = {}
        for key, value in fields.items():
            if key == 'doc_id':
                raise ValueError('doc_id cannot be updated')
            if key in self.columns:
                assignments.append(f'"{key}" = ?')
                values.append(
                    _serialize_value(key, value, self.bool_columns, self.json_columns)
                )
            else:
                if not _SAFE_IDENTIFIER.match(key):
                    raise ValueError(f'Cannot update non-identifier field {key!r}')
                extra_updates[key] = value
        if extra_updates:
            assignments.append(
                "extra = json_set(COALESCE(extra, '{}'), "
                + ', '.join(
                    f"'$.{key}', json(?)" for key in extra_updates
                )
                + ')'
            )
            values.extend(json.dumps(v) for v in extra_updates.values())
        if not assignments:
            return False
        cursor = self._conn().execute(
            f'UPDATE "{self.table}" SET {", ".join(assignments)} WHERE {where}',
            tuple(values) + params,
        )
        return cursor.rowcount > 0

    def truncate(self) -> None:
        self._conn().execute(f'DELETE FROM "{self.table}"')


class SQLiteFileStore(_SQLiteStoreBase, FileStore):
    """FileStore backed by the `files` table."""

    table = 'files'
    columns = FILE_COLUMNS
    bool_columns = FILE_BOOL_COLUMNS
    json_columns = FILE_JSON_COLUMNS

    def insert(self, doc: Mapping[str, Any], doc_id: Optional[int] = None) -> int:
        names, values = self._doc_to_insert(doc, doc_id)
        placeholders = ', '.join('?' for _ in values)
        cursor = self._conn().execute(
            f'INSERT INTO "{self.table}" ({", ".join(names)}) '
            f'VALUES ({placeholders})',
            tuple(values),
        )
        return cursor.lastrowid

    def get_by_id(self, file_id: str) -> Optional[Dict[str, Any]]:
        return self.get_by(id=file_id)

    def update_fields(self, file_id: str, fields: Mapping[str, Any]) -> bool:
        return self._update_by_clause(fields, 'id = ?', (file_id,))

    def claim_download(self, file_id: str, ip_address: str) -> bool:
        # Expired shares are excluded too: a claim raced against
        # check_and_handle_expiry() must not resurrect an expired drop.
        # NULL status is tolerated for partial/legacy rows.
        now = datetime.now().isoformat()
        cursor = self._conn().execute(
            f'UPDATE "{self.table}" '
            'SET downloaded_at = ?, downloaded_by_ip = ? '
            'WHERE id = ? AND downloaded_at IS NULL '
            'AND (status IS NULL OR status != \'expired\') '
            'AND (expiry_at IS NULL OR expiry_at > ?)',
            (now, ip_address, file_id, now),
        )
        return cursor.rowcount > 0

    def claim_notification_send(self, file_id: str) -> bool:
        cursor = self._conn().execute(
            f'UPDATE "{self.table}" '
            'SET notification_claimed_at = ? '
            'WHERE id = ? '
            'AND notification_sent_at IS NULL '
            'AND notification_claimed_at IS NULL',
            (datetime.now().isoformat(), file_id),
        )
        return cursor.rowcount > 0

    def delete(self, file_id: str) -> bool:
        cursor = self._conn().execute(
            f'DELETE FROM "{self.table}" WHERE id = ?', (file_id,)
        )
        return cursor.rowcount > 0

    # -- file_keys: server-gated key release --------------------------------

    def create_key_share(self, file_id: str, h_hex: str) -> bool:
        try:
            self._conn().execute(
                'INSERT INTO file_keys '
                '(file_id, h, v, attempts, released_at, created_at) '
                'VALUES (?, ?, NULL, 0, NULL, ?)',
                (file_id, h_hex, datetime.now().isoformat()),
            )
            return True
        except sqlite3.IntegrityError:
            # file_id UNIQUE collision — a share already exists
            return False

    def bind_key_verifier(self, file_id: str, v_hex: str) -> bool:
        cursor = self._conn().execute(
            'UPDATE file_keys SET v = ? '
            'WHERE file_id = ? AND v IS NULL AND released_at IS NULL',
            (v_hex, file_id),
        )
        return cursor.rowcount > 0

    def get_key_share(self, file_id: str) -> Optional[Dict[str, Any]]:
        row = self._conn().execute(
            'SELECT file_id, h, v, attempts, released_at, created_at '
            'FROM file_keys WHERE file_id = ?',
            (file_id,),
        ).fetchone()
        return dict(row) if row else None

    def claim_key_release(self, file_id: str, v_hex: str) -> Optional[str]:
        conn = self._conn()
        row = conn.execute(
            'SELECT h, v FROM file_keys '
            'WHERE file_id = ? AND released_at IS NULL',
            (file_id,),
        ).fetchone()
        if row is None or row['v'] is None:
            return None
        # Constant-time verifier check — the match decision must not leak
        # timing. The release below is what serializes concurrent winners.
        if not secrets.compare_digest(row['v'], v_hex):
            return None
        cursor = conn.execute(
            'UPDATE file_keys SET released_at = ? '
            'WHERE file_id = ? AND released_at IS NULL',
            (datetime.now().isoformat(), file_id),
        )
        # A racing claimant that already committed makes rowcount 0 —
        # exactly one caller ever takes H home.
        return row['h'] if cursor.rowcount > 0 else None

    def record_key_attempt(self, file_id: str) -> Optional[int]:
        conn = self._conn()
        cursor = conn.execute(
            'UPDATE file_keys SET attempts = attempts + 1 '
            'WHERE file_id = ? AND released_at IS NULL',
            (file_id,),
        )
        if cursor.rowcount == 0:
            return None
        row = conn.execute(
            'SELECT attempts FROM file_keys WHERE file_id = ?',
            (file_id,),
        ).fetchone()
        return row['attempts'] if row else None

    def delete_key_share(self, file_id: str) -> bool:
        cursor = self._conn().execute(
            'DELETE FROM file_keys WHERE file_id = ?', (file_id,)
        )
        return cursor.rowcount > 0

    def truncate(self) -> None:
        super().truncate()
        self._conn().execute('DELETE FROM file_keys')


class SQLiteTokenStore(_SQLiteStoreBase, TokenStore):
    """TokenStore backed by the `api_tokens` table."""

    table = 'api_tokens'
    columns = TOKEN_COLUMNS
    bool_columns = TOKEN_BOOL_COLUMNS
    json_columns = TOKEN_JSON_COLUMNS

    def insert(self, doc: Mapping[str, Any], doc_id: Optional[int] = None) -> int:
        names, values = self._doc_to_insert(doc, doc_id)
        placeholders = ', '.join('?' for _ in values)
        cursor = self._conn().execute(
            f'INSERT INTO "{self.table}" ({", ".join(names)}) '
            f'VALUES ({placeholders})',
            tuple(values),
        )
        return cursor.lastrowid

    def get_by_id(self, doc_id: int) -> Optional[Dict[str, Any]]:
        rows = self._select('doc_id = ?', (doc_id,))
        return rows[0] if rows else None

    def get_by_token_hash(self, token_hash: str) -> Optional[Dict[str, Any]]:
        return self.get_by(token_hash=token_hash)

    def update_fields(self, doc_id: int, fields: Mapping[str, Any]) -> bool:
        return self._update_by_clause(fields, 'doc_id = ?', (doc_id,))

    def remove_by_id(self, doc_id: int) -> bool:
        cursor = self._conn().execute(
            f'DELETE FROM "{self.table}" WHERE doc_id = ?', (doc_id,)
        )
        return cursor.rowcount > 0

    def remove_by_ids(self, doc_ids: Iterable[int]) -> int:
        ids = list(doc_ids)
        if not ids:
            return 0
        removed = 0
        # Chunk to stay under SQLite's bound-variable limit.
        for offset in range(0, len(ids), _MAX_VARS_PER_STATEMENT):
            chunk = ids[offset:offset + _MAX_VARS_PER_STATEMENT]
            placeholders = ', '.join('?' for _ in chunk)
            cursor = self._conn().execute(
                f'DELETE FROM "{self.table}" WHERE doc_id IN ({placeholders})',
                tuple(chunk),
            )
            removed += cursor.rowcount
        return removed

    def remove_by_hash(self, token_hash: str) -> bool:
        cursor = self._conn().execute(
            f'DELETE FROM "{self.table}" WHERE token_hash = ?', (token_hash,)
        )
        return cursor.rowcount > 0

    def purge_expired(self, now_iso: str) -> int:
        # expires_at and now_iso are both naive ISO-8601 strings produced by
        # datetime.now().isoformat(), so a plain text comparison is correct.
        # Malformed expires_at values are deleted too — treating a garbage
        # expiry as expired is the desired fail-closed semantics for a
        # credential store (a token must never survive on corrupt data).
        cursor = self._conn().execute(
            f'DELETE FROM "{self.table}" '
            'WHERE expires_at IS NOT NULL '
            'AND (expires_at < ? OR NOT is_iso_timestamp(expires_at))',
            (now_iso,),
        )
        return cursor.rowcount


class SQLiteBackend(Backend):
    """SQLite Backend: one file, per-thread connections, WAL mode."""

    def __init__(self, path: str):
        if not path:
            raise ValueError(
                'SQLite path must not be empty — "sqlite:///" alone would '
                'silently open a private throwaway database. Set a real '
                'DATABASE_URL like sqlite:///buzzdrop.db'
            )
        if path == ':memory:':
            raise ValueError(
                'In-memory SQLite (":memory:") is not supported: each '
                'thread-local connection would open a separate private '
                'database. Point DATABASE_URL at a file instead.'
            )
        if os.path.exists(path) and os.path.getsize(path) > 0:
            with open(path, 'rb') as handle:
                magic = handle.read(len(_SQLITE_MAGIC))
            if magic != _SQLITE_MAGIC:
                raise sqlite3.DatabaseError(
                    f'{path} exists but is not a SQLite database. If this is '
                    'a legacy TinyDB file, migrate it first: '
                    f'python migrate_db.py --source {path} '
                    '--target buzzdrop.db — then set '
                    'DATABASE_URL=sqlite:///buzzdrop.db'
                )
        self.path = os.path.abspath(path)
        self.url = f'sqlite:///{self.path}'
        self._local = threading.local()
        self._connections: List[sqlite3.Connection] = []
        # RLock: _connection may be re-entered while held
        self._lock = threading.RLock()
        self.closed = False
        self.files: FileStore = SQLiteFileStore(self)
        self.tokens: TokenStore = SQLiteTokenStore(self)
        self._ensure_schema()

    def _connection(self) -> sqlite3.Connection:
        if self.closed:
            raise RuntimeError(
                'SQLiteBackend is closed — obtain a fresh backend via '
                'create_backend()/get_backend() instead'
            )
        conn = getattr(self._local, 'conn', None)
        if conn is None:
            # autocommit; the busy timeout is set once via PRAGMA below —
            # keeping a single knob avoids divergent wait behaviour.
            conn = sqlite3.connect(self.path, isolation_level=None)
            conn.row_factory = sqlite3.Row
            conn.execute('PRAGMA journal_mode=WAL')
            conn.execute('PRAGMA busy_timeout=10000')
            conn.create_function('is_iso_timestamp', 1, _is_iso_timestamp)
            self._local.conn = conn
            with self._lock:
                self._connections.append(conn)
        return conn

    def _ensure_schema(self) -> None:
        conn = self._connection()
        # Rebuild legacy doc-blob tables first — they can't be ALTERed
        # into shape because `doc NOT NULL` rejects every new insert.
        for table, ddl, cols, bools, jsons in (
            ('files', _FILES_DDL, FILE_COLUMNS,
             FILE_BOOL_COLUMNS, FILE_JSON_COLUMNS),
            ('api_tokens', _TOKENS_DDL, TOKEN_COLUMNS,
             TOKEN_BOOL_COLUMNS, TOKEN_JSON_COLUMNS),
        ):
            col_names = {row[1] for row in _table_columns(conn, table)}
            if 'doc' in col_names:
                _rebuild_legacy_doc_table(conn, table, ddl, cols,
                                          bools, jsons)
        conn.execute(_FILES_DDL)
        conn.execute(_TOKENS_DDL)
        conn.execute(_TOKENS_HASH_INDEX)
        conn.execute(_FILE_KEYS_DDL)
        # Additive migrations: CREATE TABLE IF NOT EXISTS won't touch an
        # existing table, so add any columns introduced since the user's
        # DB was created (nullable only — no constraints via ALTER).
        _add_missing_columns(conn, 'files', _FILE_MIGRATABLE_COLUMNS)
        _add_missing_columns(conn, 'api_tokens', _TOKEN_MIGRATABLE_COLUMNS)
        _guard_incompatible_columns(conn, 'files', FILE_COLUMNS)
        _guard_incompatible_columns(conn, 'api_tokens', TOKEN_COLUMNS)

    @contextmanager
    def transaction(self):
        """
        Run a block of store operations inside one transaction on the
        current thread's connection. Commits on success, rolls back on
        error. Used by migrate_db.py so an import is all-or-nothing.
        """
        conn = self._connection()
        conn.execute('BEGIN IMMEDIATE')
        try:
            yield
        except Exception:
            conn.execute('ROLLBACK')
            raise
        else:
            conn.execute('COMMIT')

    def close(self) -> None:
        with self._lock:
            connections, self._connections = self._connections, []
            self.closed = True
        for conn in connections:
            try:
                conn.close()
            except sqlite3.Error:
                pass
        self._local = threading.local()
