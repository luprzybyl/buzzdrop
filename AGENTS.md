# AGENTS.md

Instrukcje dla agentów AI/LLM pracujących z repozytorium Buzzdrop.

## Opis projektu

Buzzdrop to jednorazowa, samodestrukcyjna aplikacja do udostępniania plików i tajnych notatek tekstowych, zbudowana na Flasku. Pliki są szyfrowane po stronie klienta (AES-GCM + PBKDF2) w przeglądarce przed uploadem — serwer nigdy nie widzi danych w postaci jawnej. Po jednorazowym pobraniu plik jest automatycznie usuwany z storage'u.

## Stos technologiczny

- **Backend**: Python 3, Flask 3.1, Werkzeug 3.1
- **Baza danych**: TinyDB 4.8 (JSON, plik `db.json`, tabela `files`)
- **Storage**: lokalny filesystem (`uploads/`) lub Amazon S3 (boto3) — konfigurowane przez `STORAGE_BACKEND`
- **Szyfrowanie**: Web Crypto API (AES-GCM 256-bit, PBKDF2 100k iteracji, SHA-256) — wyłącznie client-side
- **Frontend**: Jinja2 templates, Tailwind CSS, vanilla JS (ES modules)
- **Testy**: pytest + pytest-flask
- **Deployment**: Docker / Passenger WSGI
- **Zarządzanie zależnościami**: `requirements.txt`, virtualenv (`.venv`)

## Struktura projektu

```
buzzdrop/
├── app.py                  # Główna aplikacja Flask — routing, inicjalizacja, logika biznesowa
├── config.py               # Klasy konfiguracji (Config, DevelopmentConfig, TestingConfig, ProductionConfig)
├── auth.py                 # Autentykacja — dekoratory, zarządzanie użytkownikami z env vars
├── models.py               # FileRepository — wzorzec repozytorium nad TinyDB
├── storage.py              # Abstrakcja storage — StorageBackend (ABC), LocalStorage, S3Storage
├── utils.py                # Funkcje pomocnicze — timestampy, walidacja plików, cleanup
├── passenger_wsgi.py       # WSGI entry point dla produkcji (Passenger)
├── requirements.txt        # Zależności Python
├── Dockerfile              # Obraz Docker (python:3.15-rc-alpine)
├── docker-compose.yml      # Compose — jeden serwis, wolumeny dla uploads/ i db.json
├── .env.example            # Przykładowa konfiguracja środowiskowa
├── static/
│   ├── js/
│   │   ├── crypto.js       # CryptoService — szyfrowanie/deszyfrowanie (ES module)
│   │   ├── main.js         # Logika uploadu — szyfrowanie w przeglądarce przed wysłaniem
│   │   ├── view.js         # Logika pobierania — deszyfrowanie po stronie klienta
│   │   └── success.js      # Logika strony sukcesu po uploadzie
│   ├── favicon.ico
│   └── logo.png
├── templates/              # Szablony Jinja2
│   ├── base.html           # Bazowy layout
│   ├── index.html          # Strona główna — upload plików i notatek
│   ├── login.html          # Formularz logowania
│   ├── confirm_download.html  # Potwierdzenie pobrania
│   ├── view.html           # Interfejs deszyfrowania
│   ├── success.html        # Strona sukcesu z linkiem do udostępnienia
│   └── users.html          # Panel zarządzania użytkownikami (admin)
└── tests/
    ├── conftest.py         # Fixtures pytest — tymczasowe DB, upload dir, użytkownicy testowi
    ├── unit/
    │   ├── test_utils.py   # Testy utility functions
    │   ├── test_db.py      # Testy operacji bazodanowych
    │   └── test_sri.py     # Testy generowania hashy SRI
    └── integration/
        ├── test_app.py     # Testy routingu i ogólnej logiki
        ├── test_auth.py    # Testy autentykacji
        ├── test_files.py   # Testy uploadu/downloadu plików
        ├── test_text_notes.py      # Testy notatek tekstowych
        └── test_sri_in_templates.py # Testy atrybutów SRI w HTML
```

## Komendy deweloperskie

```bash
# Setup
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# Uruchomienie
python app.py                    # dev server na localhost:5000

# Docker
docker-compose build && docker-compose up

# Testy
pytest -v                        # wszystkie testy
pytest tests/unit/ -v            # tylko unit testy
pytest tests/integration/ -v     # tylko integracyjne
pytest tests/unit/test_db.py::test_function_name -v  # konkretny test
```

## Architektura — kluczowe wzorce

### Moduły backendowe

| Moduł | Odpowiedzialność |
|---|---|
| `app.py` | Routing Flask, inicjalizacja komponentów, obsługa uploadu/downloadu/usuwania, expiry, SRI hash processor |
| `config.py` | Centralna konfiguracja z env vars, walidacja, klasy per-environment |
| `auth.py` | Użytkownicy z `FLASK_USER_N` env vars, PBKDF2 hashing, dekoratory `@login_required` / `@admin_required`, sesje Flask |
| `models.py` | `FileRepository` — CRUD nad tabelą `files` w TinyDB, wzorzec repozytorium |
| `storage.py` | `StorageBackend` (ABC) → `LocalStorage` / `S3Storage`, factory `get_storage_backend()`, `StorageError` |
| `utils.py` | Formatowanie timestampów (Europe/Warsaw), `allowed_file()`, `get_client_ip()`, `cleanup_orphaned_files()` |

### Szyfrowanie (client-side)

Cała kryptografia dzieje się w przeglądarce — serwer przechowuje wyłącznie zaszyfrowane bloby.

- **Klasa**: `CryptoService` w `static/js/crypto.js` (ES module)
- **Algorytm**: AES-GCM 256-bit, klucz z PBKDF2 (100k iteracji, SHA-256)
- **Format danych**: `salt (16B) + iv (12B) + encrypted_data`
- **Magic header**: `BKP-FILE` — prepended do plaintext przed szyfrowaniem, walidowany przy deszyfrowaniu
- **Upload** (`main.js`): szyfruje → base64 → POST do `/upload`
- **Download** (`view.js`): fetch → deszyfruj → trigger browser download

### Cykl życia pliku

1. Użytkownik uploaduje → plik szyfrowany w przeglądarce
2. Serwer otrzymuje zaszyfrowany blob, przypisuje UUID, zapisuje (local/S3)
3. Wpis w DB ze `status: active`
4. Generowany link: `/view/{uuid}`
5. Odbiorca potwierdza pobranie → JS pobiera zaszyfrowany plik
6. JS deszyfruje client-side, triggeruje download w przeglądarce
7. Po pobraniu: `downloaded_at` ustawione, plik usunięty ze storage
8. Opcjonalnie: pliki z `expiry_at` auto-usuwane przez `check_and_handle_expiry()`

### Schemat danych (tabela `files` w TinyDB)

| Pole | Typ | Opis |
|---|---|---|
| `id` | str (UUID) | Unikalny identyfikator |
| `original_name` | str | Oryginalna nazwa pliku lub `"Secret Note"` |
| `path` | str | Ścieżka lokalna lub klucz S3 |
| `created_at` | str (ISO 8601) | Data utworzenia |
| `downloaded_at` | str/null | Data pobrania |
| `uploaded_by` | str | Username uploadera |
| `expiry_at` | str/null | Data wygaśnięcia |
| `status` | str | `"active"` lub `"expired"` |
| `decryption_success` | bool/null | Czy deszyfrowanie się powiodło |
| `type` | str | `"file"` lub `"text"` |
| `shared_with` | list | Lista usernames z dostępem |
| `downloaded_by_ip` | str | IP klienta pobierającego |

### Routing

| Route | Metoda | Auth | Opis |
|---|---|---|---|
| `/` | GET | - | Strona główna, dashboard plików dla zalogowanych |
| `/login` | GET/POST | - | Logowanie |
| `/logout` | GET | - | Wylogowanie |
| `/users` | GET | admin | Panel użytkowników |
| `/upload` | POST | login | Upload pliku lub notatki tekstowej |
| `/view/<file_id>` | GET | - | Potwierdzenie pobrania |
| `/view/<file_id>/confirm` | POST | - | Interfejs deszyfrowania |
| `/download/<file_id>` | GET | - | Jednorazowe pobranie pliku (stream + delete) |
| `/delete/<file_id>` | POST | login | Ręczne usunięcie przez uploadera |
| `/report_decryption/<file_id>` | POST | - | Raport sukcesu/porażki deszyfrowania |

## Konfiguracja środowiskowa

Plik `.env` (wzór w `.env.example`):

| Zmienna | Domyślna | Opis |
|---|---|---|
| `FLASK_SECRET_KEY` | - | **Wymagane w produkcji** — klucz sesji |
| `FLASK_ENV` | `development` | `development` / `testing` / `production` |
| `FLASK_USER_N` | - | Użytkownicy: `username:password:is_admin` |
| `STORAGE_BACKEND` | `local` | `local` lub `s3` |
| `UPLOAD_FOLDER` | `uploads` | Katalog uploadu (local storage) |
| `DATABASE_PATH` | `db.json` | Ścieżka do bazy TinyDB |
| `MAX_CONTENT_LENGTH` | `16777216` | Max rozmiar pliku w bajtach |
| `ALLOWED_EXTENSIONS` | `txt,pdf,png,...` | Dozwolone rozszerzenia (CSV) |
| `S3_BUCKET` | - | Nazwa bucketa S3 |
| `S3_ACCESS_KEY` | - | AWS access key |
| `S3_SECRET_KEY` | - | AWS secret key |
| `S3_REGION` | `us-east-1` | Region AWS |

## Testy

- Framework: **pytest** z **pytest-flask**
- Fixtures w `tests/conftest.py`: tymczasowy katalog uploadu i plik DB per sesja testowa
- Użytkownicy testowi: `testuser:password:false`, `adminuser:adminpass:true`
- Tabele DB czyszczone per funkcję testową (`db_instance` fixture)
- Uruchomienie: `pytest -v` z katalogu głównego projektu

## Wskazówki dla agentów

- **Nie modyfikuj plików w `uploads/`** — to dane użytkowników (zaszyfrowane bloby).
- **Nie commituj `.env`** — jest w `.gitignore`. Używaj `.env.example` jako referencji.
- **Nie commituj `db.json`** — jest w `.gitignore`.
- **Szyfrowanie jest client-side** — backend nie ma dostępu do kluczy ani plaintext. Nie próbuj deszyfrować plików po stronie serwera.
- **TinyDB nie jest thread-safe** — `get_db()` obsługuje reopening zamkniętych uchwytów. Przy zmianach w logice DB korzystaj z `FileRepository`.
- **SRI (Subresource Integrity)** — hashe SHA-384 generowane runtime przez `sri_hash_processor()`. Każda zmiana w plikach JS wymaga przeładowania (hashe się zmienią automatycznie).
- **Testy uruchamiaj zawsze po zmianach**: `pytest -v`. Oczekiwany wynik: 72 testy passing.
- **Virtualenv**: zawsze w `.venv` w katalogu projektu.
- **Styl kodu**: istniejący kod nie używa type checkerów (mypy) ani formatterów (black/ruff) — zachowaj spójność z obecnym stylem.
- **Pliki JS**: ES modules (`export`/`import`). `crypto.js` eksportuje `CryptoService`, importowany w `main.js` i `view.js`.
