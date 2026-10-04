# HOWTO: implementacja nowego backendu bazy danych

| | |
|---|---|
| **Wersja dokumentu** | 1.0 |
| **Dotyczy** | architektury `db/` wprowadzonej w PR #141 |
| **Cel** | dodanie backendu (PostgreSQL / MySQL / Oracle) bez zmian w reszcie aplikacji |

---

## 1. Architektura w pigułce

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

Zasada: aplikacja **nie wie**, jaki silnik jest pod spodem. Widzi tylko
`Backend` z dwoma store'ami domenowymi. Twój backend implementuje dwa
interfejsy i rejestruje się w factory — to cała umowa.

**Granica abstrakcji jest domenowa, nie dokumentowa.** Nie portujesz
żadnego query-DSL — piszesz idiomatyczny SQL pod swój silnik.

---

## 2. Kontrakt — co MUSI gwarantować implementacja

Pełne sygnatury: `db/base.py`. Semantyka, której testy kontraktowe pilnują:

### FileStore

| Metoda | Kontrakt |
|---|---|
| `insert(doc, doc_id=None) -> int` | zwraca `doc_id`; rekordy to plain dicty, `doc_id` dołączany do dicta przy odczycie |
| `get_by_id(file_id)` / `get_by(**filters)` / `list_by(**filters)` / `all()` | zwracają dict lub `None`/listę; filtry = równość po kolumnach |
| `update_fields(file_id, fields) -> bool` | `False` gdy rekord nie istnieje |
| `claim_download(file_id, ip) -> bool` | **ATOMOWO** — pojedynczy warunkowy `UPDATE ... WHERE id=? AND downloaded_at IS NULL` (lub równoważnik); `True` tylko u zwycięzcy wyścigu |
| `claim_notification_send(file_id) -> bool` | jw., pole `notification_sent_at` |
| `delete(file_id) -> bool` / `truncate()` | — |

### TokenStore

Analogicznie: `insert`, `get_by_id`, `get_by_token_hash`, `get_by`/`list_by`/`all`,
`update_fields`, `remove_by_id`/`remove_by_ids`/`remove_by_hash`,
`purge_expired(now_iso) -> int`, `truncate`.

### Twarde wymagania pozasygnaturowe

- **`claim_download` musi być atomowy na poziomie silnika** — nie „SELECT
  potem UPDATE". Wyścig 8 wątków musi dać dokładnie 1 zwycięzcę
  (test `test_claim_download_concurrent_single_winner`).
- **Typy round-tripują**: `True`/`False`/`None` wracają jako takie,
  `shared_with` wraca jako lista (JSON), `doc_id` jako int.
- **Nieznane pola** lądują w kolumnie `extra` (JSON) i wracają
  zmergowane do dicta — insert nie może się wywalić na polu bez kolumny.
- **Thread-safety**: połączenie per wątek (wzorzec thread-local z
  `sqlite_backend.py`) albo pool — Flask + testy wyścigowe uderzają
  równolegle.
- **`close()`** na `Backend` — sprząta połączenia.

---

## 3. Schema — wzór do przeniesienia

`db/sqlite_backend.py` (typowane kolumny, `extra` jako overflow):

```sql
files(doc_id PK AUTOINCREMENT, id TEXT UNIQUE, original_name, path,
      created_at, downloaded_at, downloaded_by_ip, expiry_at,
      uploaded_by, status, decryption_success, type, private_note,
      shared_with, notify_on_open, notification_email,
      notification_sent_at, notification_claimed_at, extra)

api_tokens(doc_id PK AUTOINCREMENT, token_hash, token_hash_version,
           username, created_at, last_used_at, expires_at, extra)
```

Mapowanie typów per silnik:

| Kolumna | SQLite | PostgreSQL | MySQL | Oracle |
|---|---|---|---|---|
| `doc_id` | `INTEGER PK AUTOINCREMENT` | `GENERATED ALWAYS AS IDENTITY` | `INT AUTO_INCREMENT PK` | `NUMBER GENERATED AS IDENTITY` |
| bool (`decryption_success` itd.) | `INTEGER` | `BOOLEAN` | `TINYINT(1)` | `NUMBER(1)` (BOOLEAN dopiero od 23c) |
| JSON (`shared_with`, `extra`) | `TEXT` + `json_*` | `JSONB` | `JSON` | `CLOB`/`JSON` (21c+) |
| timestampy | `TEXT` ISO-8601 | `TEXT` lub `TIMESTAMPTZ` | `TEXT` lub `DATETIME` | `VARCHAR2`/`TIMESTAMP` |

Konwencja projektu: timestampy jako **ISO-8601 stringi** — najmniej
problemów przy porównaniach i serializacji; trzymaj się tego.

---

## 4. Krok po kroku

### 4.1. Szablon pliku

`db/postgres_backend.py`:

```python
import threading
import psycopg  # raw DB-API — bez ORM, decyzja architektoniczna

from db.base import Backend, FileStore, TokenStore

class PostgresFileStore(FileStore):
    def __init__(self, backend): self._b = backend
    # ... wszystkie metody kontraktu, %s placeholders ...

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

### 4.2. Rejestracja w factory

`db/__init__.py`, w `create_backend()`:

```python
if scheme in ('postgresql', 'postgres'):
    from db.postgres_backend import PostgresBackend
    return PostgresBackend(database_url)
```

Import wewnątrz gałęzi — bez twardej zależności na `psycopg` dla
użytkowników SQLite.

### 4.3. Testy kontraktowe

Nic nie piszesz — suite już jest sparametryzowana
(`tests/contract/test_backend_contract.py`). Wystarczy DSN:

```bash
BUZZDROP_TEST_PG_DSN=postgresql://user:pass@localhost/testdb pytest tests/contract -v
```

Fixtura sama truncate'uje tabele między testami (dlatego `truncate()`
jest w kontrakcie). Jeśli Twój silnik nie jest w `_EXTRA_DSNS`,
dodaj wpis `('moj_silnik', 'BUZZDROP_TEST_X_DSN')`.

### 4.4. Pułapki per silnik

- **Placeholdery**: sqlite3 `?`, psycopg/mysql `%s`, oracledb `:1`.
  Nie składaj SQL f-stringami z wartościami — kolumny mogą, wartości nie.
- **`UPDATE ... RETURNING`**: Postgres/SQLite mają; MySQL nie — licz
  na `cursor.rowcount`; Oracle ma `RETURNING INTO` z bind zmienną.
- **Atomic claim**: na wszystkich silnikach wystarczy warunkowy UPDATE
  + rowcount — transakcja read-committed wystarczy, bo warunek
  ewaluuje się na wierszu pod lockiem.
- **Oracle**: brak `AUTOINCREMENT` (IDENTITY columns od 12c), brak
  `BOOLEAN` w SQL przed 23c, nazwy tabel uppercase w katalogu.
- **`extra`/JSON**: Postgres `JSONB` z `->>`/`->`, MySQL `JSON_EXTRACT`,
  Oracle `JSON_VALUE` — albo po prostu czytaj/zapisuj cały CLOB i
  mierz w Pythonie, jak w SQLite.
- **Commit**: DB-API nie autocommituje domyślnie (psycopg3: autocommit
  off) — każdy write musi kończyć `conn.commit()` albo włącz
  autocommit na połączeniu.

### 4.5. Checklist PR-a

- [ ] `db/<engine>_backend.py`: `FileStore` + `TokenStore` + `Backend` + `_migrate()`
- [ ] rejestracja scheme w `create_backend()` + lazy import drivera
- [ ] wpis w `_EXTRA_DSNS` w suite kontraktowej
- [ ] `pytest tests/contract -v` zielone na Twoim DSN (zwłaszcza race test)
- [ ] `pytest -v` całość zielona na sqlite (regresja)
- [ ] `.env.example` + README: przykładowy `DATABASE_URL`
- [ ] sterownik w `requirements.txt` jako opcjonalny extras / komentarz
- [ ] dokumentacja odstępstw od konwencji (jeśli jakieś są)

---

## 5. Czego NIE robić

- Nie rozszerzaj `base.py` o metody „bo się przydadzą" — interfejs
  rośnie tylko, gdy call-site tego wymaga. Każda metoda to koszt
  implementacji na KAŻDYM backendzie.
- Nie implementuj `claim_download` jako read-modify-write — złamiesz
  jedyną kontrolę bezpieczeństwa, która tu jest prawdziwa.
- Nie czytaj `.env`/configu w backendzie — DSN przychodzi z factory.
- Nie zwracaj obiektów ORM-owych ani klas — kontrakt to plain dicty.

---

## 6. Status backendów

| Scheme | Status | Plik |
|---|---|---|
| `sqlite:///` | ✅ zaimplementowany | `db/sqlite_backend.py` |
| `postgresql://` | szkielet w kontrakcie (`BUZZDROP_TEST_PG_DSN`) | — |
| `mysql://` | jw. (`BUZZDROP_TEST_MYSQL_DSN`) | — |
| `oracle://` | jw. (`BUZZDROP_TEST_ORACLE_DSN`) | — |
