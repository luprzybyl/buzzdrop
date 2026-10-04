# HOWTO: implementing a new database backend

| | |
|---|---|
| **Document version** | 1.0 |
| **Applies to** | the `db/` architecture introduced in PR #141 |
| **Goal** | add a backend (PostgreSQL / MySQL / Oracle) without changes to the rest of the application |

---

## 1. Architecture at a glance

```
app.py / routes
      │
      ▼
FileRepository (models.py)          tokens.py
      │                                  │
      └──────────► Backend ◄─────────────┘
                  .files  (FileStore)
                  .tokens (TokenStore)
                      │
            create_backend(DATABASE_URL)   ← db/__init__.py
                      │
        ┌─────────────┼─────────────┐
        ▼             ▼             ▼
   sqlite_backend  postgres?      mysql? / oracle?
```

The rule: the application **doesn't know** which engine is underneath.
It only sees a `Backend` with two domain stores. Your backend implements
two interfaces and registers in the factory — that's the whole contract.

**The abstraction boundary is domain-level, not document-level.** You
aren't porting a query DSL — you write idiomatic SQL for your engine.

---

## 2. The contract — what an implementation MUST guarantee

Full signatures: `db/base.py`. The semantics the contract suite enforces:

### FileStore

| Method | Contract |
|---|---|
| `insert(doc, doc_id=None) -> int` | returns `doc_id`; records are plain dicts, `doc_id` is attached to the dict on read |
| `get_by_id(file_id)` / `get_by(**filters)` / `list_by(**filters)` / `all()` | return dict or `None`/list; filters = column equality |
| `update_fields(file_id, fields) -> bool` | `False` when the record doesn't exist |
| `claim_download(file_id, ip) -> bool` | **ATOMIC** — a single conditional `UPDATE ... WHERE id=? AND downloaded_at IS NULL AND (status IS NULL OR status != 'expired') AND expiry_at > now` (or equivalent); `True` for the race winner only |
| `claim_notification_send(file_id) -> bool` | ditto, for the `notification_sent_at` field |
| `record_decryption_result(file_id, success) -> bool` | **ATOMIC** — conditional write `WHERE decryption_success IS NULL`; `True` only for the first valid report |
| `create_key_share(file_id, h, created_by=None, created_at=None) -> bool` | `False` when a share for `file_id` already exists; `created_by` records the uploading account for owner binding |
| `get_key_share(file_id)` | dict or `None` — includes `h`, `v`, `attempts`, `released_at`, `created_by`, `created_at` |
| `bind_key_verifier(file_id, v) -> bool` | single-shot: `True` only when `v` is currently NULL |
| `attempt_key_release(file_id, v, max_attempts, burn_on_lockout) -> dict` | **ATOMIC — one transaction covering read, expiry check, verifier compare, attempt counting, lockout/burn and release.** Statuses: `missing_file`/`missing_share`/`pending`/`released`/`locked`/`expired`/`ok`/`denied`. On `ok`: return `h`, set `released_at`, wipe `h`/`v`. On `denied`: increment `attempts`. On `expired`: delete the share row and mark the file expired. Expired-after-release still reports `released` |
| `delete_key_share(file_id) -> bool` / `burn_key_share(file_id) -> bool` | delete the row; `burn` additionally runs whatever WAL/vacuum hygiene the engine needs so deleted bytes don't linger in journals |
| `purge_stale_key_shares(older_than_seconds) -> int` | delete pending (unbound, `v` NULL) shares older than the TTL; malformed `created_at` counts as stale |
| `delete(file_id) -> bool` / `truncate()` | — |

### TokenStore

Analogous: `insert`, `get_by_id`, `get_by_token_hash`, `get_by`/`list_by`/`all`,
`update_fields`, `remove_by_id`/`remove_by_ids`/`remove_by_hash`,
`purge_expired(now_iso) -> int`, `truncate`.

### Hard requirements beyond signatures

- **`claim_download` must be engine-atomic** — not "SELECT then UPDATE".
  An 8-thread race must produce exactly 1 winner
  (test `test_claim_download_concurrent_single_winner`).
- **`attempt_key_release` must be one transaction** — the read, expiry
  check, verifier compare, attempt count and release are all inside a
  single write transaction (SQLite: `BEGIN IMMEDIATE`; Postgres: a
  `SERIALIZABLE` or row-locked `SELECT ... FOR UPDATE` block). Racing
  attempts must serialize: exactly one `ok`, misses counted once each,
  and a released share reports `released` — never a second `ok`
  (`test_attempt_key_release_concurrent_single_winner`,
  `test_attempt_key_release_mixed_race`,
  `test_attempt_key_release_race_never_exceeds_max`).
- **Key-material deletion should be physical, not just logical** —
  enable whatever secure-delete semantics the engine offers
  (SQLite: `PRAGMA secure_delete=ON` + `wal_checkpoint(TRUNCATE)` after
  burns) so wiped `h`/`v` bytes don't survive in journals.
- **Types round-trip**: `True`/`False`/`None` come back as such,
  `shared_with` comes back as a list (JSON), `doc_id` as int.
- **Unknown fields** go into the `extra` column (JSON) and merge back
  into the dict — insert must not crash on a field without a column.
  On read, typed columns win over `extra` copies (`setdefault` merge).
- **Thread-safety**: a connection per thread (thread-local pattern from
  `sqlite_backend.py`) or a pool — Flask and the race tests hit it
  concurrently.
- **`close()`** on `Backend` — releases connections; calling into a
  closed backend must raise rather than silently reopen.

---

## 3. Schema — the template to port

`db/sqlite_backend.py` (typed columns, `extra` as overflow):

```sql
files(doc_id PK AUTOINCREMENT, id TEXT UNIQUE, original_name, path,
      created_at, downloaded_at, downloaded_by_ip, expiry_at,
      uploaded_by, status, decryption_success, type, private_note,
      shared_with, notify_on_open, notification_email,
      notification_sent_at, notification_claimed_at, extra)

api_tokens(doc_id PK AUTOINCREMENT, token_hash, token_hash_version,
           username, created_at, last_used_at, expires_at, extra)
```

Type mapping per engine:

| Column | SQLite | PostgreSQL | MySQL | Oracle |
|---|---|---|---|---|
| `doc_id` | `INTEGER PK AUTOINCREMENT` | `GENERATED ALWAYS AS IDENTITY` | `INT AUTO_INCREMENT PK` | `NUMBER GENERATED AS IDENTITY` |
| bool (`decryption_success` etc.) | `INTEGER` | `BOOLEAN` | `TINYINT(1)` | `NUMBER(1)` (BOOLEAN only from 23c) |
| JSON (`shared_with`, `extra`) | `TEXT` + `json_*` | `JSONB` | `JSON` | `CLOB`/`JSON` (21c+) |
| timestamps | `TEXT` ISO-8601 | `TEXT` or `TIMESTAMPTZ` | `TEXT` or `DATETIME` | `VARCHAR2`/`TIMESTAMP` |

Project convention: timestamps as **ISO-8601 strings** — fewest
problems with comparisons and serialization; stick to it.

---

## 4. Step by step

### 4.1. File template

`db/postgres_backend.py`:

```python
import threading
import psycopg  # raw DB-API — no ORM, architectural decision

from db.base import Backend, FileStore, TokenStore

class PostgresFileStore(FileStore):
    def __init__(self, backend): self._b = backend
    # ... all contract methods, %s placeholders ...

class PostgresTokenStore(TokenStore): ...

class PostgresBackend(Backend):
    def __init__(self, dsn):
        self._dsn = dsn
        self._local = threading.local()
        self.files = PostgresFileStore(self)
        self.tokens = PostgresTokenStore(self)
        self._migrate()          # CREATE TABLE IF NOT EXISTS ...
    def _conn(self):
        if not hasattr(self._local, 'conn'):
            self._local.conn = psycopg.connect(self._dsn)
        return self._local.conn
    def close(self): ...
```

### 4.2. Registering in the factory

`db/__init__.py`, in `create_backend()`:

```python
if scheme in ('postgresql', 'postgres'):
    from db.postgres_backend import PostgresBackend
    return PostgresBackend(database_url)
```

Import inside the branch — no hard dependency on `psycopg` for
SQLite users.

### 4.3. Contract tests

You write nothing — the suite is already parametrized
(`tests/contract/test_backend_contract.py`). A DSN is enough:

```bash
BUZZDROP_TEST_PG_DSN=postgresql://user:pass@localhost/testdb pytest tests/contract -v
```

The fixture truncates tables between tests (that's why `truncate()`
is in the contract). If your engine isn't in `_EXTRA_DSNS`, add an
entry `('my_engine', 'BUZZDROP_TEST_X_DSN')`.

### 4.4. Per-engine pitfalls

- **Placeholders**: sqlite3 `?`, psycopg/mysql `%s`, oracledb `:1`.
  Don't build SQL from f-strings with values — identifiers may be
  static, values never.
- **`UPDATE ... RETURNING`**: Postgres/SQLite have it; MySQL doesn't —
  rely on `cursor.rowcount`; Oracle has `RETURNING INTO` with a bind
  variable.
- **Atomic claim**: a conditional UPDATE + rowcount suffices on all
  engines — read-committed is enough, because the predicate is
  evaluated on the row under lock.
- **Oracle**: no `AUTOINCREMENT` (IDENTITY columns from 12c), no
  `BOOLEAN` in SQL before 23c, uppercase table names in the catalog.
- **`extra`/JSON**: Postgres `JSONB` with `->>`/`->`, MySQL
  `JSON_EXTRACT`, Oracle `JSON_VALUE` — or simply read/write the whole
  CLOB and merge in Python, like SQLite does.
- **Commit**: DB-API doesn't autocommit by default (psycopg3:
  autocommit off) — every write must end with `conn.commit()` or
  enable autocommit on the connection.
- **`expires_at` semantics**: `purge_expired` is deliberately
  fail-closed — a malformed `expires_at` is treated as expired
  (deleting a credential is the safer failure than keeping it valid).

### 4.5. PR checklist

- [ ] `db/<engine>_backend.py`: `FileStore` + `TokenStore` + `Backend` + `_migrate()`
- [ ] scheme registration in `create_backend()` + lazy driver import
- [ ] entry in `_EXTRA_DSNS` in the contract suite
- [ ] `pytest tests/contract -v` green on your DSN (especially the race test)
- [ ] `pytest -v` green on sqlite (regression)
- [ ] `.env.example` + README: sample `DATABASE_URL`
- [ ] driver in `requirements.txt` as an optional extra / comment
- [ ] documented deviations from conventions (if any)

---

## 5. What NOT to do

- Don't extend `base.py` with methods "because they might be useful" —
  the interface grows only when a call site requires it. Every method
  is an implementation cost on EVERY backend.
- Don't implement `claim_download` as read-modify-write — you'd break
  the only real security control here.
- Don't read `.env`/config inside a backend — the DSN arrives via the
  factory.
- Don't return ORM objects or classes — the contract is plain dicts.

---

## 6. Backend status

| Scheme | Status | File |
|---|---|---|
| `sqlite:///` | ✅ implemented | `db/sqlite_backend.py` |
| `postgresql://` | stub in contract (`BUZZDROP_TEST_PG_DSN`) | — |
| `mysql://` | ditto (`BUZZDROP_TEST_MYSQL_DSN`) | — |
| `oracle://` | ditto (`BUZZDROP_TEST_ORACLE_DSN`) | — |
