"""
SQLite storage backend for Buzzdrop.

Implements FileStore/TokenStore from db.base with stdlib sqlite3 — no ORM,
no extra dependencies. Records are typed columns; fields without a column
are preserved in an ``extra`` JSON column so the schema can grow.

Each thread gets its own connection (thread-local storage) with WAL mode
and a busy timeout, so concurrent writers serialize through SQLite locking
instead of racing a shared file.
"""
import json
import re
import sqlite3
import threading
from datetime import datetime
from typing import Any, Dict, Iterable, List, Mapping, Optional, Tuple

from db.base import Backend, FileStore, TokenStore

_SAFE_IDENTIFIER = re.compile(r'^[A-Za-z_][A-Za-z0-9_]*$')

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
            doc.update(json.loads(row['extra']))
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
        cursor = self._conn().execute(
            f'UPDATE "{self.table}" '
            'SET downloaded_at = ?, downloaded_by_ip = ? '
            'WHERE id = ? AND downloaded_at IS NULL',
            (datetime.now().isoformat(), ip_address, file_id),
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
        placeholders = ', '.join('?' for _ in ids)
        cursor = self._conn().execute(
            f'DELETE FROM "{self.table}" WHERE doc_id IN ({placeholders})',
            tuple(ids),
        )
        return cursor.rowcount

    def remove_by_hash(self, token_hash: str) -> bool:
        cursor = self._conn().execute(
            f'DELETE FROM "{self.table}" WHERE token_hash = ?', (token_hash,)
        )
        return cursor.rowcount > 0

    def purge_expired(self, now_iso: str) -> int:
        cursor = self._conn().execute(
            f'DELETE FROM "{self.table}" '
            'WHERE expires_at IS NOT NULL AND expires_at < ?',
            (now_iso,),
        )
        return cursor.rowcount


class SQLiteBackend(Backend):
    """SQLite Backend: one file, per-thread connections, WAL mode."""

    def __init__(self, path: str):
        self.path = path
        self.url = f'sqlite:///{path}'
        self._local = threading.local()
        self._connections: List[sqlite3.Connection] = []
        # RLock: _connection may be re-entered while held
        self._lock = threading.RLock()
        self.files: FileStore = SQLiteFileStore(self)
        self.tokens: TokenStore = SQLiteTokenStore(self)
        self._ensure_schema()

    def _connection(self) -> sqlite3.Connection:
        conn = getattr(self._local, 'conn', None)
        if conn is None:
            conn = sqlite3.connect(self.path, timeout=10, isolation_level=None)
            conn.row_factory = sqlite3.Row
            conn.execute('PRAGMA journal_mode=WAL')
            conn.execute('PRAGMA busy_timeout=10000')
            self._local.conn = conn
            with self._lock:
                self._connections.append(conn)
        return conn

    def _ensure_schema(self) -> None:
        conn = self._connection()
        conn.execute(_FILES_DDL)
        conn.execute(_TOKENS_DDL)
        conn.execute(_TOKENS_HASH_INDEX)

    def close(self) -> None:
        with self._lock:
            connections, self._connections = self._connections, []
        for conn in connections:
            try:
                conn.close()
            except sqlite3.Error:
                pass
        self._local = threading.local()
