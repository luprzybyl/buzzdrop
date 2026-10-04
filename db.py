"""
SQLite-backed document storage for Buzzdrop.

Replaces TinyDB (JSON file, no locking) with stdlib sqlite3. Documents are
stored as JSON text so the ``files`` and ``api_tokens`` tables remain
schemaless, but each row still lives in a real SQLite database with proper
locking, WAL mode, and single-statement conditional updates.

The public surface intentionally mirrors the small subset of the TinyDB API
the codebase relies on (``Database.table()``, ``Table.insert/get/search/
update/remove/all/truncate``, ``Query`` field comparisons, ``doc_id``), so
callers only need their import changed.
"""
import json
import re
import sqlite3
import threading
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple

# Only simple identifiers may be compiled into json_extract()/json_set()
# paths; anything else falls back to Python-side evaluation.
_SAFE_IDENTIFIER = re.compile(r'^[A-Za-z_][A-Za-z0-9_]*$')

def _is_sequence(value: Any) -> bool:
    return isinstance(value, (list, tuple))


class Document(dict):
    """A stored document. Behaves like a dict and carries its row id."""

    def __init__(self, doc_id: int, value: Dict[str, Any]):
        super().__init__(value)
        self.doc_id = doc_id


class Condition:
    """
    A query predicate.

    Wraps a Python predicate ``func(document) -> bool`` plus, when the
    condition is expressible in SQLite JSON1 terms, a ``sql`` fragment and
    bound ``params`` so updates/deletes can run as a single atomic statement.
    """

    __slots__ = ('func', 'sql', 'params')

    def __init__(self, func: Callable[[Dict[str, Any]], bool],
                 sql: Optional[str] = None,
                 params: Tuple[Any, ...] = ()):
        self.func = func
        self.sql = sql
        self.params = params

    def __call__(self, doc: Dict[str, Any]) -> bool:
        return bool(self.func(doc))

    def __and__(self, other: 'Condition') -> 'Condition':
        sql = None
        params: Tuple[Any, ...] = ()
        if self.sql is not None and other.sql is not None:
            sql = f'({self.sql}) AND ({other.sql})'
            params = self.params + other.params
        return Condition(lambda doc: self(doc) and other(doc), sql, params)

    def __or__(self, other: 'Condition') -> 'Condition':
        sql = None
        params: Tuple[Any, ...] = ()
        if self.sql is not None and other.sql is not None:
            sql = f'({self.sql}) OR ({other.sql})'
            params = self.params + other.params
        return Condition(lambda doc: self(doc) or other(doc), sql, params)

    def __invert__(self) -> 'Condition':
        sql = f'NOT ({self.sql})' if self.sql is not None else None
        return Condition(lambda doc: not self(doc), sql, self.params)


def _as_condition(cond: Any) -> Condition:
    """Normalize a Condition or plain callable into a Condition."""
    if isinstance(cond, Condition):
        return cond
    if callable(cond):
        return Condition(cond)
    raise TypeError(f'Unsupported query condition: {cond!r}')


class Query:
    """
    Field-level query builder, TinyDB-style.

    ``Query().id == 'x'`` produces a :class:`Condition`. Missing fields
    resolve to ``None`` (matching ``json_extract`` semantics for absent keys).
    """

    __slots__ = ('_path',)

    def __init__(self, path: Tuple[str, ...] = ()):
        object.__setattr__(self, '_path', path)

    def __getattr__(self, name: str) -> 'Query':
        return Query(self._path + (name,))

    def __getitem__(self, name: str) -> 'Query':
        return Query(self._path + (name,))

    # -- helpers ---------------------------------------------------------
    def _resolve(self, doc: Dict[str, Any]) -> Any:
        value: Any = doc
        for part in self._path:
            if not isinstance(value, dict):
                return None
            value = value.get(part)
        return value

    def _json_path(self) -> Optional[str]:
        if self._path and all(_SAFE_IDENTIFIER.match(part) for part in self._path):
            return '$.' + '.'.join(self._path)
        return None

    def _expr(self) -> Optional[str]:
        json_path = self._json_path()
        if json_path is None:
            return None
        return f"json_extract(doc, '{json_path}')"

    # -- comparisons -----------------------------------------------------
    def __eq__(self, other: Any) -> Condition:  # type: ignore[override]
        expr = self._expr()
        if other is None:
            sql = f'{expr} IS NULL' if expr else None
            return Condition(lambda doc: self._resolve(doc) is None, sql)
        sql = f'{expr} = ?' if expr else None
        params = (other,) if expr else ()
        return Condition(lambda doc: self._resolve(doc) == other, sql, params)

    def __ne__(self, other: Any) -> Condition:  # type: ignore[override]
        expr = self._expr()
        if other is None:
            sql = f'{expr} IS NOT NULL' if expr else None
            return Condition(lambda doc: self._resolve(doc) is not None, sql)
        # NULL != value is NULL in SQL, which conveniently excludes missing keys
        sql = f'{expr} != ?' if expr else None
        params = (other,) if expr else ()
        return Condition(lambda doc: self._resolve(doc) != other, sql, params)

    def _compare(self, op: str, other: Any) -> Condition:
        expr = self._expr()
        sql = f'{expr} {op} ?' if expr else None
        params = (other,) if expr else ()
        ops = {
            '<': lambda a, b: a is not None and a < b,
            '<=': lambda a, b: a is not None and a <= b,
            '>': lambda a, b: a is not None and a > b,
            '>=': lambda a, b: a is not None and a >= b,
        }
        return Condition(lambda doc: ops[op](self._resolve(doc), other), sql, params)

    def __lt__(self, other: Any) -> Condition:
        return self._compare('<', other)

    def __le__(self, other: Any) -> Condition:
        return self._compare('<=', other)

    def __gt__(self, other: Any) -> Condition:
        return self._compare('>', other)

    def __ge__(self, other: Any) -> Condition:
        return self._compare('>=', other)

    # -- collection / custom predicates ----------------------------------
    def one_of(self, items: Iterable[Any]) -> Condition:
        values = list(items)
        expr = self._expr()
        sql = None
        params: Tuple[Any, ...] = ()
        if expr:
            if values:
                placeholders = ', '.join('?' for _ in values)
                sql = f'{expr} IN ({placeholders})'
                params = tuple(values)
            else:
                sql = '1 = 0'
        return Condition(lambda doc: self._resolve(doc) in values, sql, params)

    def any(self, cond: Any) -> Condition:
        """Match when any element of the (list) field matches ``cond``."""
        if callable(cond):
            return Condition(
                lambda doc: _is_sequence(self._resolve(doc))
                and any(cond(item) for item in self._resolve(doc))
            )
        return Condition(
            lambda doc: _is_sequence(self._resolve(doc))
            and any(item in cond for item in self._resolve(doc))
        )

    def test(self, func: Callable[[Any], bool]) -> Condition:
        return Condition(lambda doc: func(self._resolve(doc)))

    def exists(self) -> Condition:
        expr = self._expr()
        sql = f'{expr} IS NOT NULL' if expr else None
        return Condition(lambda doc: self._resolve(doc) is not None, sql)


class Table:
    """A document table: one row per document, stored as JSON text."""

    def __init__(self, database: 'Database', name: str):
        if not _SAFE_IDENTIFIER.match(name):
            raise ValueError(f'Invalid table name: {name!r}')
        self._database = database
        self.name = name
        self._database._ensure_table(name)

    # -- internals -------------------------------------------------------
    def _conn(self) -> sqlite3.Connection:
        return self._database._connection()

    def _select(self, where: Optional[str] = None,
                params: Tuple[Any, ...] = ()) -> List[Document]:
        sql = f'SELECT doc_id, doc FROM "{self.name}"'
        if where:
            sql += f' WHERE {where}'
        sql += ' ORDER BY doc_id'
        cursor = self._conn().execute(sql, params)
        return [Document(row[0], json.loads(row[1])) for row in cursor.fetchall()]

    @staticmethod
    def _split_cond(cond: Any) -> Tuple[Optional[Condition], Optional[str], Tuple[Any, ...]]:
        if cond is None:
            return None, None, ()
        condition = _as_condition(cond)
        return condition, condition.sql, condition.params

    def _matching_doc_ids(self, cond: Optional[Condition],
                          doc_ids: Optional[Iterable[int]]) -> List[int]:
        """Python-side evaluation fallback for non-SQL conditions."""
        candidates = self.all()
        if doc_ids is not None:
            wanted = set(doc_ids)
            candidates = [doc for doc in candidates if doc.doc_id in wanted]
        if cond is not None:
            candidates = [doc for doc in candidates if cond(doc)]
        return [doc.doc_id for doc in candidates]

    def _build_where(self, cond_sql: Optional[str],
                     doc_ids: Optional[Iterable[int]]) -> Tuple[str, Tuple[Any, ...]]:
        clauses: List[str] = []
        params: List[Any] = []
        if cond_sql:
            clauses.append(cond_sql[0])
            params.extend(cond_sql[1])
        if doc_ids is not None:
            ids = list(doc_ids)
            if not ids:
                return '1 = 0', ()
            clauses.append('doc_id IN (' + ', '.join('?' for _ in ids) + ')')
            params.extend(ids)
        return ' AND '.join(f'({clause})' for clause in clauses), tuple(params)

    # -- TinyDB-compatible API -------------------------------------------
    def insert(self, doc: Dict[str, Any], doc_id: Optional[int] = None) -> int:
        """Insert a document; returns its integer doc_id."""
        payload = json.dumps(dict(doc))
        if doc_id is None:
            cursor = self._conn().execute(
                f'INSERT INTO "{self.name}" (doc) VALUES (?)', (payload,)
            )
        else:
            # Explicit ids are used only by the db.json migration path so
            # existing api_tokens keep their numeric ids.
            cursor = self._conn().execute(
                f'INSERT INTO "{self.name}" (doc_id, doc) VALUES (?, ?)',
                (doc_id, payload),
            )
        return cursor.lastrowid

    def all(self) -> List[Document]:
        return self._select()

    def get(self, cond: Any = None, doc_id: Optional[int] = None) -> Optional[Document]:
        if doc_id is not None:
            rows = self._select('doc_id = ?', (doc_id,))
            return rows[0] if rows else None
        condition, cond_sql, params = self._split_cond(cond)
        if cond_sql is not None:
            cursor = self._conn().execute(
                f'SELECT doc_id, doc FROM "{self.name}" WHERE {cond_sql} LIMIT 1',
                params,
            )
            row = cursor.fetchone()
            return Document(row[0], json.loads(row[1])) if row else None
        if condition is None:
            rows = self._select()
            return rows[0] if rows else None
        for doc in self._select():
            if condition(doc):
                return doc
        return None

    def search(self, cond: Any) -> List[Document]:
        condition, cond_sql, params = self._split_cond(cond)
        if cond_sql is not None:
            return self._select(cond_sql, params)
        return [doc for doc in self._select() if condition(doc)]

    def update(self, fields: Dict[str, Any], cond: Any = None,
               doc_ids: Optional[Iterable[int]] = None) -> List[int]:
        """
        Apply ``fields`` to every matching document.

        When ``cond`` compiles to SQL this is a single
        ``UPDATE ... WHERE ... RETURNING`` statement — the building block for
        atomic conditional claims. Otherwise falls back to Python-side
        evaluation plus an id-targeted update.
        """
        if not isinstance(fields, dict):
            raise TypeError('update() expects a dict of fields')
        if not fields:
            return []
        for key in fields:
            if not _SAFE_IDENTIFIER.match(key):
                raise ValueError(f'Cannot update non-identifier field {key!r}')

        condition, cond_sql, params = self._split_cond(cond)

        if cond_sql is None and condition is not None:
            # Evaluate in Python, then target the resolved row ids.
            doc_ids = self._matching_doc_ids(condition, doc_ids)
            condition, cond_sql, params = None, None, ()

        where, where_params = self._build_where(
            (cond_sql, params) if cond_sql else None, doc_ids
        )
        if not where:
            where = '1 = 1'

        set_parts = []
        set_params: List[Any] = []
        for key, value in fields.items():
            set_parts.append(f"'$.{key}'")
            set_parts.append('json(?)')
            set_params.append(json.dumps(value))
        set_clause = ', '.join(set_parts)

        cursor = self._conn().execute(
            f'UPDATE "{self.name}" SET doc = json_set(doc, {set_clause}) '
            f'WHERE {where} RETURNING doc_id',
            tuple(set_params) + where_params,
        )
        return [row[0] for row in cursor.fetchall()]

    def remove(self, cond: Any = None,
               doc_ids: Optional[Iterable[int]] = None) -> List[int]:
        condition, cond_sql, params = self._split_cond(cond)

        if cond_sql is None and condition is not None:
            doc_ids = self._matching_doc_ids(condition, doc_ids)
            condition, cond_sql, params = None, None, ()

        where, where_params = self._build_where(
            (cond_sql, params) if cond_sql else None, doc_ids
        )
        if not where:
            where = '1 = 1'

        cursor = self._conn().execute(
            f'DELETE FROM "{self.name}" WHERE {where} RETURNING doc_id',
            where_params,
        )
        return [row[0] for row in cursor.fetchall()]

    def truncate(self) -> None:
        self._conn().execute(f'DELETE FROM "{self.name}"')


class Database:
    """
    SQLite database holding schemaless document tables.

    Each thread gets its own connection (thread-local storage), so
    concurrent writers serialize through SQLite locking instead of
    corrupting a shared JSON file.
    """

    def __init__(self, path: str):
        self.path = path
        self._local = threading.local()
        self._connections: List[sqlite3.Connection] = []
        # RLock: table() calls _ensure_table()/_connection() while held
        self._lock = threading.RLock()
        self._tables: Dict[str, Table] = {}

    def _connection(self) -> sqlite3.Connection:
        conn = getattr(self._local, 'conn', None)
        if conn is None:
            conn = sqlite3.connect(self.path, timeout=10, isolation_level=None)
            conn.execute('PRAGMA journal_mode=WAL')
            conn.execute('PRAGMA busy_timeout=10000')
            self._local.conn = conn
            with self._lock:
                self._connections.append(conn)
        return conn

    def _ensure_table(self, name: str) -> None:
        self._connection().execute(
            f'CREATE TABLE IF NOT EXISTS "{name}" ('
            'doc_id INTEGER PRIMARY KEY AUTOINCREMENT, '
            'doc TEXT NOT NULL)'
        )

    def table(self, name: str) -> Table:
        with self._lock:
            existing = self._tables.get(name)
            if existing is not None:
                return existing
            table = Table(self, name)
            self._tables[name] = table
            return table

    def tables(self) -> List[str]:
        cursor = self._connection().execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' "
            "AND name NOT LIKE 'sqlite_%' ORDER BY name"
        )
        return [row[0] for row in cursor.fetchall()]

    def close(self) -> None:
        with self._lock:
            connections, self._connections = self._connections, []
        for conn in connections:
            try:
                conn.close()
            except sqlite3.Error:
                pass
        self._local = threading.local()
        self._tables = {}
