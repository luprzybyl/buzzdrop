# Audyt bezpieczeństwa: Buzzdrop w roli narzędzia do współdzielenia haseł

| | |
|---|---|
| **Data audytu** | 2026-10-03 |
| **Rewizja** | `b378123` (branch `main`) |
| **Zakres** | `app.py`, `auth.py`, `config.py`, `models.py`, `storage.py`, `tokens.py`, `utils.py`, `cli/buzz`, `static/js/{crypto,main,view,success}.js`, `templates/*` |
| **Metoda** | analiza statyczna + weryfikacja empiryczna zachowania (patrz Załącznik A) |
| **Audytor** | analiza bezpieczeństwa, na zlecenie |

---

## Werdykt

**Nie wdrażać w obecnej formie do przekazywania haseł i poświadczeń.**

Konstrukcja kryptograficzna jest poprawna — to nie jest aplikacja ze złymi prymitywami. Problem leży w zarządzaniu kluczem i w projektowaniu przepływu, nie w szyfrowaniu. Do przekazywania jednorazowych dokumentów narzędzie jest rozsądne. Do haseł nie, z trzech powodów:

1. **Brak wsparcia dla użytkownika** — narzędzie nie generuje hasła ani nie ocenia jego siły w interfejsie WWW, więc jedyną ochroną jest dyscyplina użytkownika.
2. **Domyślna ścieżka jest słaba** — 37,7 bitów entropii i generator inny niż kryptograficzny.
3. **Fałszywe poczucie bezpieczeństwa** — komunikat „self-destructing" sugeruje ochronę, której wobec realnego zagrożenia (offline'owe złamanie kopii) nie ma.

Punkty 1 i 2 są problemami jakościowymi do naprawienia. Punkt 3 jest problemem komunikacyjnym, który w połączeniu z dwoma poprzednimi aktywnie szkodzi.

---

## Podsumowanie ustaleń

| # | Ustalenie | Ocena | Blokujące? |
|---|---|---|---|
| 1 | Domyślna fraza: 37,7 bitów entropii | Wysoka | Tak |
| 2 | Fraza generowana generatorem niekryptograficznym (`random`) | Wysoka | Tak |
| 3 | Brak generatora i miernika siły hasła w UI | Wysoka | Tak |
| 4 | „One-click link" łamie model dwóch kanałów | Wysoka | Tak |
| 5 | Brak wszystkich nagłówków bezpieczeństwa | Wysoka | Tak |
| 6 | Jednorazowość nieatomowa; równoległe zapisy korumpują `db.json` | Średnio-wysoka | Tak |
| 7 | Jawne metadane o sekrecie ujawniane przed uwierzytelnieniem | Średnia | Nie |
| 8 | PBKDF2 100k iteracji (poniżej zaleceń) | Średnia | Nie |
| 9 | Sesja, CSRF, limity, wycieki metadanych | Średnia | Nie |
| 10 | „Jedna próba" nie jest kontrolą bezpieczeństwa | Pouczenie | Nie |

---

## Wysoka — blokujące

### 1. Domyślna fraza ma 37,7 bitów entropii

`cli/buzz:168` generuje hasło domyślne:

```python
def generate_passphrase(n: int = 4) -> str:
    return '-'.join(random.choices(_WORDS, k=n))   # n=4
```

Lista słów (`cli/buzz:30`) zawiera **691 pozycji, 690 unikalnych** — nie „~400", jak twierdzi komentarz w `cli/buzz:26-28`.

| Liczba słów | Przestrzeń kluczy | Entropia |
|---|---|---|
| 3 | 3,3 × 10⁸ | 28,3 bita |
| **4 (domyślnie)** | **2,28 × 10¹¹** | **37,7 bitów** |
| 5 | 1,58 × 10¹⁴ | 47,2 bitów |
| 6 | 1,09 × 10¹⁷ | 56,6 bitów |

KDF: PBKDF2-HMAC-SHA256, **100 000 iteracji** (`cli/buzz:343`, `crypto.js:12`).

Zmierzono lokalnie 40 prób/sek. na rdzeń CPU. Przy sprzęcie klasy hashcat:

| Sprzęt | Czas złamania |
|---|---|
| 1 GPU @ 5 mln prób/s | ~12,7 godz. |
| 1 GPU @ 20 mln prób/s | ~3,2 godz. |
| 8 GPU @ 5 mln prób/s | ~95 min |

**Kontekst:** to jest *fallback*, nie wymuszone zachowanie — użytkownik może podać własne hasło przez `-p`, i wtedy powyższa tabela nie obowiązuje. Ustalenie zostaje zatem obniżone z krytycznego do wysokiego, a jego treść to: **ścieżka domyślna jest słaba i nie jest świadoma ryzyka.**

Fallback jest jednak trybem domyślnym, nie przypadkiem brzegowym — `cli/buzz:470-474`:

```python
password = args.password
password_generated = password is None
if password_generated:
    password = generate_passphrase()
```

Dla porównania: EFF diceware, 6 słów z listy 7776 → **77,5 bitów**. Sama ta lista słów byłaby wystarczająca — obecna lista jest zbyt mała o rząd wielkości.

**Naprawa:** `secrets.choice` + lista EFF + minimum 6 słów.

---

### 2. Fraza generowana generatorem niekryptograficznym

`cli/buzz:20` importuje `random`. `secrets` nie jest importowany **nigdzie** w CLI.

```python
import random
...
'-'.join(random.choices(_WORDS, k=n))
```

Mersenne Twister jest deterministyczny i odtwarzalny — to nie jest kryptograficzny generator dla wartości, na której opiera się całe bezpieczeństwo pliku.

**Zależność:** to ustalanie jest *podzbiorem* problemu 1. Jeśli użytkownik poda własne hasło przez `-p`, `random` nie jest w ogóle wywoływany i wada nie wchodzi w grę. Oba ustalenia tracą łącznie wagę, jeśli domyślna generacja zostanie wymieniona.

---

### 3. Interfejs WWW nie ma generatora ani miernika siły hasła

Przeszukiwanie `templates/index.html` i `static/js/main.js`: **zero wystąpień** `strength`, `zxcvbn`, `diceware`, `generate.*passphrase`.

Jedyna wskazówka to placeholder:

```html
<!-- index.html:75 -->
<input id="shared-password" type="password" placeholder="Enter a strong password" required>
```

Brak minimalnej długości. Brak odrzucania słabych haseł po stronie serwera. Brak jakiejkolwiek informacji zwrotnej.

To najpoważniejsze z ustaleń wysokich, bo dotyczy **dominującej ścieżki użycia**: użytkownicy CLI dostają wygenerowaną frazę, natomiast każdy użytkownik przeglądarki musi wymyślić hasło sam. Realistyczne hasła wybrane przez człowieka wobec PBKDF2-100k padają w sekundy na jednym GPU.

Cała propozycja wartości aplikacji — „dzielę się zaszyfrowanym plikiem" — sprowadza się do dyscypliny użytkownika, bez żadnego wsparcia ze strony narzędzia.

---

### 4. „One-click link" niszczy model dwóch kanałów

```js
// success.js:78-81
const shareLink = document.getElementById('share-link').value;
const linkWithPassword = shareLink + '#' + encodeURIComponent(pwd);
document.getElementById('share-link-with-password').value = linkWithPassword;
```

Identycznie w CLI (`cli/buzz:518`):

```python
print(f"One-click link: {share_link}#{password}")
```

Szyfrowanie sekretu ma sens **wyłącznie wtedy**, gdy link i sekret podróżują osobnymi kanałami. Funkcja umieszcza oba w jednej wiadomości. Wklejone do Slacka, maila lub systemu zgłoszeń — każdy, kto to przeczyta, ma już poświadczenie na stałe. Plus: historia wyszukiwania kanału, podgląd powiadomień, eksport, kopie zapasowe kanału.

Dodatkowy problem — hasło zostaje w przeglądarce w dwóch miejscach:

```js
// confirm_download.html:45-51
if (window.location.hash) {
    const password = decodeURIComponent(window.location.hash.substring(1));
    if (password) {
        sessionStorage.setItem('downloadPassword', password);
    }
}
```

- **Fragment nigdy nie jest usuwany z URL** — brak `history.replaceState`. Jasne hasło zostaje w pasku adresu i w historii przeglądarki przez całą sesję, w tym w „ostatnio zamkniętych".
- **`sessionStorage` jest czytelny dla dowolnego JS w tym origin** — a przy braku CSP (ustalenie 5) pojedyncza injekcja kradnie wszystkie hasła w locie.

---

### 5. Brak wszystkich nagłówków bezpieczeństwa

Przeszukiwanie `app.py`, wszystkich szablonów i całego JavaScriptu: **zero wystąpień** `Content-Security-Policy`, `Referrer-Policy`, `X-Frame-Options`, `frame-ancestors`, `Strict-Transport-Security`, `X-Content-Type-Options`, `Permissions-Policy`. **Nie ma w ogóle hooka `after_request`.**

SRI (`app.py:243-274`) jest realną zaletą i obejmuje każdy `<script src>`. Nie obejmuje jednak:

- **inline** `<script>` w `confirm_download.html:43-51` — SRI z definicji nie obejmuje inline, więc warunek przechodzenia hasła do `sessionStorage` jest całkowicie niechroniony;
- wstrzyknięć w kontekstach `<style>` i atrybutów;
- zasobów nie-skryptowych serwowanych przez skompromitowany origin.

Dodatkowo, bez `frame-ancestors` ramkowalne są zarówno strona logowania, jak i potwierdzenia pobrania:

- **`/login` w ramce** — atakujący nakłada własny formularz i kradnie poświadczenia konta.
- **`/view/<uuid>` w ramce** — atakujący nakłada przycisk „Proceed", ofiara klikając automatycznie potwierdza jednorazowe pobranie, nie wiedząc o tym.

---

## Średnio-wysoka

### 6. Jednorazowość nie jest atomowa; równoległe zapisy korumpują bazę

`download_file` (`app.py:733-748`) to check-then-act bez synchronizacji:

```python
file_info = file_repo.get_by_id(file_id)
if not file_info: ...
if 'downloaded_at' in file_info and file_info['downloaded_at'] is not None:   # sprawdzenie
    ...
if check_and_handle_expiry(file_info): ...

client_ip = get_client_ip()
file_repo.mark_downloaded(file_id, client_ip)                                  # zapis
```

`mark_downloaded` (`models.py:135-138`) aktualizuje **bezwarunkowo** — brak predykatu `downloaded_at == None`. Równoległe żądania przechodzą sprawdzenie i wszystkie otrzymują pełną zaszyfrowaną treść.

**Poważniejszy skutek: TinyDB nie ma blokad.** Uruchomiono 8 równoległych writerów na `db.json`:

```
write errors: ['JSONDecodeError: Extra data: line 1 column 39 (char 38)', ...]
db.json CORRUPT -> JSONDecodeError: Extra data: line 1 column 14 (char 13)
raw size: 26 bytes
```

Plik został zredukowany do **26 bajtów i przestał być parsowalny**. Wszystkie wpisy w tabeli `files` i `api_tokens` zostały zniszczone — bezpowrotnie i po cichu.

Wyzwalacze są trywialne: dwóch użytkowników klikających `/download` w tej samej chwili, dowolny równoległy upload, albo równoległe logowanie (każde logowanie unieważnia i zapisuje token CSRF). Skutek uboczny: uszkodzona baza unieważnia wszystkie tokeny API, co może posłużyć do wymuszenia ich ponownego wydania.

---

## Średnie

### 7. Jawne metadane o sekrecie, ujawniane przed uwierzytelnieniem

**Nazwa pliku.** `original_name` jest zapisywana jawnie w bazie i renderowana **niez uwierzytelnionemu** odbiorcy *przed jakimkolwiek wpisaniem hasła*:

```html
<!-- confirm_download.html:21 -->
<p class="mx-auto mt-3 max-w-sm truncate text-sm text-slate-400">{{ original_name }}</p>
```

Nazwij plik `Bitwarden_export_2026-10-03.json` albo `aws-prod-root-creds.txt`, a oddajesz kontekst sekretu, zanim atakujący w ogóle ma klucz. Nazwa trafia też do tematu maila z powiadomieniem (`app.py:212`):

```python
subject = f'Buzzdrop {share_type.lower()} opened: {original_name}'
```

**Adres IP odbiorcy.** `downloaded_by_ip` (`models.py:137`) jest przechowywany na stałe i wyświetlany w panelu (`app.py:458`). IP + znacznik czasu + wynik deszyfrowania to trwały zapis, że konkretna osoba otrzymała konkretne poświadczenie o konkretnej porze.

**Kanał ukryty.** `report_decryption` (`app.py:845`) jest **bez uwierzytelnienia i bez limitu**:

```
anon POST /report_decryption/abc: 200 {'status': 'recorded'}
```

Ktokolwiek dysponując samym UUID może wysłać `{"success": true}`, skaży status deszyfrowania albo wygeneruje e-mail do użytkownika. Nic nie wiąże zgłoszenia z klientem, który faktycznie pobrał plik.

---

### 8. PBKDF2 poniżej zaleceń; kod nie jest zgodny sam ze sobą

100 000 iteracji (`crypto.js:12`) wobec aktualnych zaleceń OWASP: **600 000** dla PBKDF2-HMAC-SHA256.

Kod nie jest spójny — `tokens.py:16` używa **310 000** iteracji do haszowania tokenów API:

```python
TOKEN_HASH_ITERATIONS = 310_000
```

Do haszowania tokenów zastosowano wyższy standard niż do właściwych sekretów. Przy silnym haśle użytkownika 100k jest do przyjęcia — to wtedy defense-in-depth, nie węzeł problemu.

---

### 9. Sesja, CSRF, limity, wycieki

- **`TOKEN_HASH_SECRET` po cichu użyje `FLASK_SECRET_KEY`** (`tokens.py:62-71`). Zmiana klucza sesji unieważnia wszystkie tokeny API. Jeśli `FLASK_SECRET_KEY` nie jest ustawiony, `app.py:59` generuje losowy klucz przy starcie — tokeny psują się po każdym restarcie. Jeden sekret chroni teraz i ciasteczka sesji, i odciski tokenów.
- **Flagi ciasteczka sesji nigdy nie są ustawiane** — brak `SESSION_COOKIE_SECURE`, `SESSION_COOKIE_SAMESITE`, `PERMANENT_SESSION_LIFETIME`. Po zwykłym HTTP (udokumentowana ścieżka `python app.py`) ciasteczko sesji i token CSRF przechodzą otwartym tekstem.
- **`/logout` to GET** (`app.py:483`) — wylogowanie podatne na CSRF.
- **Brak minimalnej długości hasła po stronie serwera** — akceptowane jest hasło jedn-znakowe.
- **`MAX_CONTENT_LENGTH` = 100 MB** w dostarczonym `.env` wobec domyślnych 16 MB (`config.py:26`). Większe pliki obniżają koszt jednej próby offline i umożliwiają wyczerpanie zasobów.
- **Placeholdery S3 w `.env`** — aplikacja startuje bez problemu z `S3_SECRET_KEY=your-...`.

---

### 10. Pou-czenie: „jedna próba" nie jest kontrolą bezpieczeństwa

To ustalanie jest osobne, bo dotyczy mechanizmu opisanego w dokumentacji jako element bezpieczeństwa.

**W kodzie nie ma żadnej weryfikacji hasła po stronie serwera.** Jedyne sprawdzenie hasła w `app.py` to formularz logowania (`:473-475`) — dotyczy kont użytkowników, nie udostępnianych plików.

Kolejność zdarzeń jest odwrócona względem narracji „jedna próba":

1. `view.js:15-16` pobiera zaszyfrowany blob **od razu** przy załadowaniu strony, zanim istnieje pole hasła.
2. `/download/<id>` (`app.py:748`) oznacza plik jako pobrany i usuwa go — **bez żadnego hasła**.
3. Dopiero potem użytkownik wpisuje hasło, a `view.js:38-39` je deseryzuje lokalnie.

Weryfikacja empiryczna (Załącznik A, test 3):

```
anon GET /download/abc (bez sesji, bez CSRF, bez hasła): 200, 136B, pełny ciphertext=True
po tym JEDNYM pobraniu: downloaded=True, plik już skasowany z dysku=False
anon POST /report_decryption/abc: 200 {'status': 'recorded'}
drugi GET /download/abc: 302 (zablokowany)
```

Ochrona „zła hasło = utrata pliku" jest egzekwowana przez **uczciwość JavaScriptu odbiorcy**:

```js
// view.js:38-39
decryptBtn.disabled = true;
passInput.disabled = true;
```

To uprzejmość UI, nie granica bezpieczeństwa. Atakujący zgaduje lokalnym skryptem przeciw bajtom, które **już ma w pamięci**. Żadna próba nie przechodzi przez serwer, więc limit 60/godz. (`config.py:59`) nie ma czego ograniczać.

| Atakujący | Ma ciphertext | Polityka „jednej próby" |
|---|---|---|
| Operator serwera | tak, w spoczynku | nieistotna — nie musi nikomu dawać pliku |
| Odbiorca | tak, w pamięci | nieistotna — zgaduje lokalnie |
| Złodziej linku wyprzedzający odbiorcę | tak, po pierwszym pobraniu | nieistotna |

W żadnym scenariuszu atakujący nie korzysta z przeglądarki ofiary, więc mechanizm nigdy się nie uruchamia.

**Koszt dla haseł jest wyższy niż dla dokumentów.** Pomyłka w haśle oznacza nieodwracalną utratę poświadczenia — irytująca literówka w nazwie pliku nie jest porównywalna. W połączeniu z brakiem generatora i miernika siły (ustalenie 3) ryzyko literówki jest istotne, a możliwość ponowienia nie istnieje.

**Wniosek dla dokumentacji:** opis mechanizmu jest uczciwy, ale jeśli README używa go jako **argumentu bezpieczeństwa** („plik zostanie usunięty, więc hasło jest bezpieczne"), twierdzenie jest fałszywe i powinno zostać poprawione — prowadzi użytkownika do fałszywego poczucia ochrony.

**Kosmetyczny komunikat po błędzie** (`view.js:86`) również jest nieprecyzyjny — sugeruje, że plik zostaje usunięty *z powodu złego hasła*, podczas gdy w rzeczywistości został usunięty już przy pierwszym pobraniu, niezależnie od wyniku:

> „Incorrect password or corrupted file. The file was deleted from the server to avoid attempted password breaking."

---

## Co jest zrobione dobrze

Zasługuje na uznanie — zawęża zakres naprawy do zarządzania kluczami, a nie do przepisania aplikacji:

- **Prymitywy kryptograficzne są poprawne.** AES-GCM-256, świeży losowy IV 96-bitowy i sól 128-bitowa na każdy plik (`crypto.js:20-29`). Klucz nigdy nie opuszcza przeglądarki, jawny tekst nigdy nie trafia na serwer.
- **Format ma walidację.** Nagłówek `BKP-FILE` (`crypto.js:13`) pozwala odróżnić błędne hasło od uszkodzonego pliku. Słabe jako walidacja integralności — faktycznym checkiem jest tag GCM — ale poprawne jako sygnał dla użytkownika.
- **Tokeny API nigdy nie są przechowywane w postaci surowej.** Odcisk PBKDF2-HMAC-SHA256 przy 310 000 iteracji (`tokens.py:74-83`).
- **CSRF porównywany w czasie stałym** przez `secrets.compare_digest` (`app.py:104`).
- **SRI na każdym zewnętrznym skrypcie**, generowane w runtime (`app.py:243-274`).
- **Limity na logowanie, upload i dostęp publiczny** (`config.py:56-59`).
- **`secure_filename` + UUID4 jako klucze** w pamięci masowej (`app.py:682-686`).
- **Mail z powiadomieniem świadomie pomija dane odbiorcy** (`app.py:221`) — dobra decyzja, utrzymana konsekwentnie.
- **`.env`, `db.json` i `uploads/` są wyłączone z gita** — sprawdzone, brak sekretów w repozytorium.

---

## Plan naprawczy

### Blokujące przed dopuszczeniem do haseł

1. **`secrets.choice`** zamiast `random.choices`; lista EFF (7776 słów) i minimum **6 słów** → 77,5 bitów. Dodać test asertujący długość listy — komentarz „~400" mylił się o 73%, a brak asercji pozwolił na regresję.
2. **Generator + bramka siły zxcvbn w interfejsie WWW**, nie tylko w CLI. Minimalna długość hasła egzekwowana po stronie serwera.
3. **PBKDF2 ≥ 600 000 iteracji** w `crypto.js:12` i `cli/buzz:343` — wyrównać z `tokens.py:16`.
4. **Usunąć „one-click link"** albo przynajmniej: wywołać `history.replaceState` po odczytaniu fragmentu i **nie zapisywać hasła w `sessionStorage`**.

### Wysoki priorytet

5. **Hook `after_request`** ustawiający CSP (z nonce dla inline w `confirm_download.html`), `Referrer-Policy: no-referrer`, `frame-ancestors 'none'`, HSTS, `X-Content-Type-Options: nosniff`, `SESSION_COOKIE_SECURE`.
6. **Atomowe roszczenie o jednorazowość** — dodać predykat `downloaded_at == None` do `mark_downloaded`. Równolegle **zejść z TinyDB** (SQLite/Postgres) na `config.py`/`app.py:281`, co eliminuje całą klasę korupcji z ustaleń 6.
7. **Nie renderować `original_name`** niez uwierzytelnionym odbiorcom; usunąć z tematu maila (`app.py:212`).

### Średni priorytet

8. `TOKEN_HASH_SECRET` obowiązkowy w produkcji, bez fallbacku na `FLASK_SECRET_KEY` (`tokens.py:66`).
9. `/logout` na POST z CSRF (`app.py:483`).
10. Ujednolicić `MAX_CONTENT_LENGTH` (16 MB) między `.env` a `config.py:26`.
11. `report_decryption`: związać z tokenem jednorazowym wydawanym przy pobraniu, dodać limit (`app.py:845`).

### Korekta komunikacji

12. Zmienić komunikat po błędzie (`view.js:86`) na: *„Ten plik został usunięty po pierwszym pobraniu, niezależnie od tego, czy hasło było poprawne."*
13. Usunąć z dokumentacji twierdzenie, że samodestruct jest ochroną hasła. Jeśli mechanizm ma zostać opisany, opisać go jako ochronę przed *powtórnym odczytem przez odbiorcę*, nie przed złamaniem hasza.

---

## Załącznik A — weryfikacja empiryczna

Wszystkie testy uruchamiano na izolowanej instancji z tymczasowym `DATABASE_PATH` i `UPLOAD_FOLDER`, `RATE_LIMIT_ENABLED=False`.

**Test 1 — skorumpowanie `db.json` (ustalenie 6).** 8 wątków, każdy 40 operacji `update` na tej samej tabeli:

```
write errors: ['JSONDecodeError: Extra data: line 1 column 39 (char 38)', ...]
db.json CORRUPT -> JSONDecodeError: Extra data: line 1 column 14 (char 13)
raw size: 26 bytes
```

**Test 2 — brak CSRF przy kasowaniu (ustalenie 6).** `/delete/<id>` poprawnie wymaga CSRF (`app.py:778`), ale `download_file` nie ma takiego wymogu — patrz test 3.

**Test 3 — przepływ pobierania bez hasła (ustalenie 10).**

```
[1] anon GET /download/abc (bez sesji, bez CSRF, bez hasła): 200, 136B, full ciphertext=True
[2] after that ONE fetch: downloaded=True, file still on disk=False
[3] anon POST /report_decryption/abc: 200 {'status': 'recorded'}
[4] second GET /download/abc: 302 (zablokowany)
```

**Test 4 — entropia listy słów (ustalenie 1).** Parsing `_WORDS` z `cli/buzz:30`:

```
word count: 691
unique: 690
4 words -> 227,988,105,361 = 37.7 bits
```

**Test 5 — benchmark KDF.** `hashlib.pbkdf2_hmac('sha256', b'test-password', b'0123456789abcdef', 100_000)`:

```
CPU single-core: 40 guesses/sec
4-word space: 227,988,105,361
time on 1 core: 1,585,723.7 hours
```

Czasy GPU oszacowane z klasycznych benchmarków PBKDF2-HMAC-SHA256 dla hashcat na kartach klasy RTX 4090 / A100. Nie stanowią pomiaru na konkretnym sprzęcie atakującego — służą do określenia rzędu wielkości.

---

## Ograniczenia audytu

- **Analiza statyczna i zachowanie aplikacji.** Brak audytu bezpieczeństwa kryptograficznego w sensie formalnej weryfikacji; prymitywy sprawdzono odczytem kodu, nie dowodem.
- **Brak testu penetracyjnego** aplikacji uruchomionej w środowisku produkcyjnym — brak oceny konfiguracji reverse proxy, TLS, nagłówków dodawanych na brzegu.
- **Dane syntetyczne.** Testy używały atrapy ciphertextu, nie rzeczywistych zaszyfrowanych plików.
- **Model zagrożeń przyjęty:** operator serwera, osoba z dostępem do kopii zapasowej lub pamięci masowej, odbiorca linku, oraz złodziej linku wyprzedzający odbiorcę. Pominięto: atakującego z aktywnym dostępem do warstwy aplikacji (RCE), oraz scenariusze natychmiastowej utraty klucza sesji.
- **Komendy weryfikacyjne uruchamiano na repozytorium w stanie czystym**; pliki tymczasowe usunięto. Nie wprowadzono żadnych zmian w kodzie.