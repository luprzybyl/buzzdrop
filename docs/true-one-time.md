# Prawdziwa jednorazowość: dlaczego „self-destructing" to dziś obietnica, a nie mechanizm

Dokument zbiera pełną analizę problemu „true one-time download" w buzzdrop:
co dziś naprawdę chroni, czego nie da się ochronić w ogóle, i jak wygląda
jedyny design, w którym jednorazowość jest egzekwowana przez serwer,
a nie przez uczciwość JavaScriptu odbiorcy.

Źródło: audyt bezpieczeństwa `audyt-bezpieczenstwa.md` (ustalenia 1 i 10)
oraz zamknięta decyzja architektoniczna w issue #138.

---

## 1. Na czym polega problem

Buzzdrop reklamuje się jako „one-time, self-destructing". Kolejność zdarzeń
przy pobraniu wygląda jednak tak:

```
1. GET /view/<id>         → strona potwierdzenia
2. GET /download/<id>     → serwer wydaje pełny ciphertext i KASUJE plik
3. użytkownik wpisuje hasło → view.js deszyfruje LOKALNIE w przeglądarce
```

Serwer nigdy nie widzi hasła i nigdy nie sprawdza żadnej próby deszyfrowania.
„Jedna próba" jest egzekwowana wyłącznie przez to, że uczciwy `view.js`
deaktywuje pole hasła po pierwszym błędzie:

```js
decryptBtn.disabled = true;
passInput.disabled = true;
```

To jest uprzejmość UI, nie granica bezpieczeństwa. Atakujący nie używa
naszej przeglądarki ani naszego JavaScriptu — bierze bajty i łamie je
lokalnie, dowolnie długo, dowolnie szybko.

### Dlaczego ciphertext to „samopowiadająca się zagadka"

Kluczowa obserwacja: zaszyfrowany blob jest **samo-weryfikujący**.
Format to `salt ‖ iv ‖ AES-GCM(klucz, dane)`. Tag GCM sprawdza się przy
każdej próbie deszyfrowania — zgadłeś hasło, tag się zgadza; nie zgadłeś,
dostajesz błąd. Oznacza to, że ciphertext zawiera w sobie **wyrocznię**:
każdy, kto go ma, może sprawdzać dowolne hasło w nieskończoność,
bez pytania kogokolwiek o zgodę.

To jest fundament całego problemu. Dopóki cały materiał potrzebny
do deszyfrowania mieści się w jednym pliku, który wydajemy każdemu
posiadaczowi linku — żadna polityka po stronie serwera niczego
nie egzekwuje.

---

## 2. Model zagrożeń: kto ma co

| Aktor | Co posiada | Co może dziś |
|---|---|---|
| Odbiorca (link + hasło) | ciphertext, hasło | deszyfruje — zgodnie z założeniem |
| Złodziej linku (link, bez hasła) | ciphertext | brute-force offline, bez limitu |
| Kradzież `buzzdrop.db` + `uploads/` | ciphertext wszystkich plików | brute-force offline, bez limitu |
| Publiczne/misconfigured S3 | ciphertext | brute-force offline, bez limitu |
| Administrator serwera | wszystko | wszystko — poza modelem |
| Odbiorca po deszyfrowaniu | plaintext | nie do cofnięcia — patrz §3 |

Dziś **jedyną** kontrolą chroniącą ciphertext jest entropia hasła —
kontrola, którą użytkownik musi sobie zapewnić sam.

---

## 3. Granica fizyki: analog hole i co jest nierozwiązywalne

Trzy rzeczy, których **żaden** projekt nie naprawi — warto je wymienić
wprost, żeby nie gonić za niemożliwym:

**Analog hole.** W chwili deszyfrowania plaintext siedzi w RAM
przeglądarki odbiorcy. Może go skopiować, zrzutować ekran, przepisać
na kartkę. Żadna kryptografia nie cofnie informacji, którą ktoś już
przeczytał. Nawet Signal z disappearing messages nie broni przed
screenshotem — broni tylko przed trwałą kopią na serwerze. Dla nas to
zresztą feature: hasło *ma* trafić do odbiorcy. „One-time" chroni
przed resztą świata, nie przed odbiorcą.

**Administrator serwera.** Ma blob, bazę, kod i RAM. Zawsze wygrywa.
Każdy model zero-knowledge to de facto „zero-knowledge modulo
zaufany operator".

**Atak offline na doręczony ciphertext przy słabym haśle.** To jedyny
wektor, którego nie zamyka żadna kasacja, żaden rate limit — bo atak
nie przechodzi przez serwer. Jedyną bronią jest entropia hasła
(„trywialnie łamalne" vs „praktycznie niełamalne") albo odebranie
atakującemu materiału do łamania — patrz §6.

---

## 4. Dlaczego entropia to dziś cała obrona

Skoro blob jest samo-weryfikujący, koszt jego złamania to wyłącznie
koszt przetrzebienia przestrzeni haseł przez PBKDF2.

Stan obecny (audyt, ustalenie 1):

- CLI generuje domyślną frazę z listy **691 słów × 4 słowa** → ~37,7 bitów
- PBKDF2-HMAC-SHA256, 100k iteracji → ~40 prób/s/rdzeń CPU;
  GPU klasy hashcat: 5–20 mln prób/s
- wynik: **domyślne hasło pada w godziny na jednym GPU**

Naprawa (issues #129, #130, #135):

- lista EFF (7776 słów) × 6 słów → **~77,5 bitów**
- PBKDF2 ≥ 600k iteracji → ~6× wyższy koszt pojedynczej próby
- generator + bramka siły w UI — bo model stoi na entropii, więc
  entropia musi być **egzekwowana**, nie sugerowana placeholderem

Przy ~77 bitach i 600k iteracji offline brute-force przestaje być
praktycznym atakiem dla pojedynczego aktora — staje się problemem
budżetu państwowego. To wystarcza dla większości zastosowań.

Ale: to nadal jest „ufamy entropii", a nie „serwer egzekwuje
jednorazowość".

---

## 5. Ślepa uliczka: kasowanie pliku i crypto-shredding

Pierwsza naturalna odpowiedź — „usuńmy plik porządnie". Problem:
`unlink()` nie wymazuje bajtów. Zwalnia bloki; stare dane przeżywają
w snapshotach, backupach, wersjonowanym S3, na wear-levelowanym SSD.
„Usunięcie" to best effort, nie gwarancja.

Istnieje elegancki wzorzec na to — **crypto-shredding**: szyfruj
blob po raz drugi kluczem per plik (DEK), trzymaj DEK w kontrolowanym
miejscu (env/KMS/RAM), a kasowanie DEK = matematyczna śmierć
wszystkich kopii ciphertextu, niezależnie od tego, gdzie bajty
fizycznie przetrwały.

Dlaczego to odrzuciliśmy (decyzja w #138): crypto-shredding broni
przed **niedoręczonymi** kopiami — backupami i forensyką. Ale te kopie
i tak stają się martwe, gdy fraza ma 77 bitów. W zamian dostajemy nowy
tryb awarii: utrata klucza/master secret = śmierć wszystkich dropów.
Duży koszt złożoności za ochronę wektora już zamkniętego przez
entropię.

I co ważniejsze — **nie rozwiązuje właściwego problemu**: doręczony
blob wciąż jest samo-weryfikujący. Złodziej linku łamie go offline
tak samo jak wcześniej.

---

## 6. Design, który rozwiązuje właściwy problem: server-gated key release

Jedyny sposób, żeby „jednorazowość" była faktem a nie nadzieją:
**blob nie może zawierać wszystkiego, co potrzebne do deszyfrowania**.
Kawałek klucza trzyma serwer i wydaje go raz, pod warunkami,
które sam egzekwuje.

### 6.1. Pojęcia (czytelnie, bez żargonu)

- **PBKDF2** — funkcja, która zamienia hasło w klucz, celowo wolno
  (setki tysięcy iteracji), żeby zgadywanie kosztowało. Wyjście:
  ciąg bajtów będący „materiałem kluczowym".
- **HKDF** — funkcja, która z materiału kluczowego wyprowadza klucze
  do konkretnych zastosowań. `HKDF(m, "enc")` i `HKDF(m, "ver")`
  dają dwa różne klucze z tego samego `m`; znajomość jednego
  **nie pozwala** wyliczyć drugiego ani `m` (funkcja jednokierunkowa).
- **AES-GCM** — szyfrowanie z wbudowanym tagiem autentyczności:
  błędny klucz = natychmiastowa odmowa, nie „mogło się udać".
- **PAKE** — rodzina protokołów (SRP, OPAQUE), w których strona
  dowodzi znajomości hasła bez wysyłania go i bez dawania serwerowi
  czegokolwiek łamalnego offline. „Prawdziwa" wersja naszego V —
  patrz §7.

### 6.2. Nowe elementy

```
master = PBKDF2(hasło, salt, 600k)   # wyliczany TYLKO w przeglądarce
Kp     = HKDF(master, "enc")         # połowa klientowa — nigdy nie
                                     # opuszcza przeglądarki
V      = HKDF(master, "ver")         # weryfikator — trzymany na serwerze
H      = losowe 32 bajty             # połowa serwerowa — trzymana
                                     # na serwerze, wydawana RAZ

klucz_pliku = HKDF(Kp ‖ H)           # potrzebne OBIE połowy
blob = AES-GCM(klucz_pliku, plik)
```

**Najważniejsze zdanie tego dokumentu: serwer nigdy nie zna klucza
pliku.** Nie ma go w żadnym momencie — nie przy uploadzie, nie przy
pobraniu, nie w bazie, nie w logach. Klucz istnieje tylko tam, gdzie
składane są `Kp` i `H`, a do złożenia potrzeba hasła, którego serwer
również nie zna.

Co wie kto:

| Podmiot | Posiada | Nie posiada |
|---|---|---|
| **przeglądarka** | `master`, `Kp`, `V`; `H` na chwilę (upload) lub raz (release) | — |
| **serwer** | `V`, `H`, `salt`, ciphertext | `master`, `Kp`, **klucza pliku**, hasła |
| **złodziej storage'u** | ciphertext | wszystkiego, co czyni go wartościowym |

Dlaczego `V` nie psuje zero-knowledge: `V` i `Kp` pochodzą z tego
samego `master`, ale przez **różne etykiety HKDF**. Z `V` nie da się
wyliczyć `Kp` ani `master` — funkcja jest jednokierunkowa. `V` to
nie „część klucza", tylko odcisk hasła: dokładnie ten sam mechanizm,
na którym opiera się każdy system logowania — serwer umie sprawdzić,
czy wpisane hasło jest poprawne, nie znając samego hasła.

### 6.3. Przepływ uploadu

```
1. POST /upload/begin      → serwer tworzy file_id + H, odsyła oba
2. klient: master = PBKDF2(hasło, salt)
           Kp = HKDF(master,"enc"); V = HKDF(master,"ver")
           klucz = HKDF(Kp ‖ H)
           blob = AES-GCM(klucz, plik)
3. POST /upload/finish     → ciphertext + salt + V
4. serwer zapisuje: {file_id, H, V, salt, ciphertext, attempts: 0}
```

Uwagi:

- **H trafia do przeglądarki nadawcy** — to konieczność, nie błąd:
  nadawca musi złożyć `Kp ‖ H`, żeby zaszyfrować plik. Jego znajomość
  H nie jest przeciekiem — nadawca i tak posiada plaintext.
- Po uploadzie przeglądarka nadawcy **zapomina H**. `H` nie może
  trafić do share linku ani żadnego storage'u po stronie klienta —
  inaczej gate przestaje istnieć, bo link znów dawałby komplet.

### 6.4. Przepływ pobrania

```
1. GET /download/<id>      → ciphertext + salt   (H NIE jest wydawane)
2. klient wpisuje hasło → master → V'
3. POST /release/<id> {V'}   (wariant twardszy: HMAC(V', nonce) z challenge)
4. serwer, w transakcji:
     - compare_digest(V', V) — stałoczasowo
     - MATCH → wydaje H, atomowo pali rekord
               (UPDATE ... WHERE h_released IS NULL — tylko jeden zwycięzca)
     - MISS  → attempts++, exponential backoff, limit per file_id;
               opcjonalnie pali rekord po N pomyłkach
5. klient: Kp ‖ H → klucz_pliku → deszyfruje lokalnie
```

**H opuszcza serwer dokładnie raz, w jednym momencie:** w odpowiedzi
na zwycięskie `/release`, po udanym sprawdzeniu `V' == V`. Nie ma
matcha — nie ma H, a skradziony lub legalnie pobrany ciphertext
pozostaje matematycznie martwy. To jest sedno: część klucza trafia
do klienta **dopiero po udowodnieniu znajomości hasła**, a samo
wydanie jest jednorazową, atomową operacją bazodanową.

Po wydaniu H odbiorca posiada kompletny materiał kluczowy i może
zapisać `ciphertext + Kp + H` i deszyfrować offline ile razy chce.
Nie da się tego zablokować i nie trzeba — skoro może zapisać
plaintext, pilnowanie liczby deszyfrowań ciphertextu jest bez
przedmiotu (analog hole, §3). Jednorazowość dotyczy **dostępu do
klucza**, nie do używania już odszyfrowanej treści.

### 6.5. Dlaczego serwer nadal nie umie deszyfrować

Tu często mieszają się dwa różne pytania — warto je rozdzielić:

**„Czy serwer umie sprawdzić hasło?" — TAK.** I tylko tyle potrzebuje.
`V` działa jak hash w formularzu logowania: klient wylicza `V'` z
wpisanego hasła, serwer porównuje ze zapisanym `V` (stałoczasowo,
`compare_digest`). Match = „wpisano poprawne hasło" = wydaj H.
Serwer nigdy nie widzi hasła ani klucza — widzi tylko odcisk.

**„Czy serwer umie odszyfrować plik?" — NIE.** Klucz pliku to
`HKDF(Kp ‖ H)`. Serwer ma `H`, `V` i ciphertext, ale `Kp` wylicza
się wyłącznie z hasła — a hasła serwer nie zna. Z `V` nie da się
wycofać do `Kp` (inna domena HKDF, funkcja jednokierunkowa). Żeby
deszyfrować, serwer musiałby złamać hasło brute-forcem — dokładnie
tyle samo pracy, co atakujący dziś.

Czyli ochroniarz sprawdza hasło po odcisku (V) i wydaje swój klucz
(H) — ale sejf wymaga dwóch kluczy naraz, a drugi (Kp) składa się
tylko w ręku tego, kto zna hasło. Serwer kontroluje **dostęp** do
klucza, nie znając samego klucza. To jest cała wartość dodana
designu wobec wariantu „serwer deszyfruje" (§8): gate bez
rezygnacji z zero-knowledge.

Zero-knowledge zachowane modulo standardowe zastrzeżenie:
„zaufany operator" — admin może logować `V'`/`H` przy `/release`
albo podmienić kod. Nie istnieje design, który to naprawia.

### 6.6. Co to zmienia — ten sam model zagrożeń po wdrożeniu

| Aktor | Dziś | Z oracle |
|---|---|---|
| Złodziej linku bez hasła | blob → brute-force offline | **martwy blob** — brak H; zgadywanie tylko przez `/release` z rate limitem |
| Kradzież `uploads/` / publiczne S3 | ciphertext → offline | **martwe bajty** — brak H i hasła |
| Kradzież `db` + `uploads` | brute-force ciphertext | brute-force V (600k) → odzyskuje hasło → **nie gorzej niż dziś** |
| Wyścig odbiorca vs złodziej | obaj dostają blob; wyścig o łamanie | atomowy claim — dokładnie jeden dostaje H; przegrany widzi „claimed" |
| „Jedna próba" | uczciwość view.js | **polityka serwera**: X prób, backoff, burn — egzekwowana realnie |
| Odbiorca po deszyfrowaniu | plaintext | plaintext — analog hole, poza modelem |

Dwie dodatkowe własności warte podkreślenia:

- **Blob przestaje być samo-weryfikujący.** Błędne hasło daje błędne
  `Kp`, ale bez `H` atakujący nie potrafi nawet sprawdzić, czy zgadł —
  wyrocznia została przeniesiona na serwer, gdzie każde pytanie
  kosztuje i jest liczone.
- **„Pomyłka = utrata pliku" znika.** Skoro próby liczy serwer, można
  dać 3–5 prób zamiast natychmiastowej śmierci — zamyka to skargę
  audytora na nieodwracalność literówki. Dziś kasowanie po pierwszym
  pobraniu nie chroniło niczego (blob już u atakującego); palenie H
  przy lockoucie naprawdę odbiera atakującemu kawałek układanki.

### 6.7. Uczciwe koszty i kompromisy

- **Nowy protokół**: handshake przy uploadzie (H musi istnieć przed
  szyfrowaniem), endpoint `/release`, wersjonowany format payloadu
  (`BKP-FILE` v2), parzystość w CLI.
- **V jest łamalny offline** po kradzieży `db` — wymaga mocnego KDF
  (już jest: 600k) i nie pogarsza stanu względem dziś.
- **Wektor DoS**: złodziej linku może marnować próby. Polityka
  „burn po N fails" chroni sekret kosztem dostępności; „lock bez
  burn" odwrotnie. Do wyboru per deployment — dla narzędzia do
  sekretów utrata dostępności jest zwykle tańsza niż wyciek.
- **Rate limit musi być per file_id**, nie tylko per IP — rotacja
  adresów jest trywialna.
- **Resztkowa luka**: `db` + `uploads` skradzione razem = powrót
  do dziś (brute-force V). Domknięcie wymagałoby trzymania H poza
  bazą (KMS) — wtedy kradzież bazy nie daje H, a kradzież samego
  KMS to już inna liga ataku.
- **Admin wygrywa zawsze** — może logować V'/H przy `/release` albo
  podmienić kod. Nie naprawi tego żaden design.

---

## 7. Wariant „po studiach": PAKE

Słabym punktem §6 jest `V` — weryfikator, który po kradzieży bazy
można łamać offline jak hash hasła. PAKE (SRP-6a, OPAQUE, SPAKE2)
rozwiązuje dokładnie to: serwer przechowuje rejestrację, z której
**nie da się** zgadywać offline, a klient dowodzi znajomości hasła
wymieniając komunikaty, których podsłuch też niczego nie daje
(nawet atakujący rejestrujący cały ruch).

W naszym kontekście PAKE domknąłby ostatni wiersz tabeli z §6.6 —
kradzież `db`+`uploads` przestawałaby dawać materiał do offline-ataku.
Koszt: implementacja protokołu w JS + serwerze (OPAQUE ma biblioteki,
ale to nadal poważny kawał pracy i powierzchnia do pomyłki
kryptograficznej). Rekomendacja: design z §6 najpierw — PAKE jako
ewolucja, jeśli produkt urośnie.

---

## 8. Alternatywa odrzucona: deszyfrowanie po stronie serwera

Najprostszy sposób na realny gate — niech serwer deszyfruje i serwuje
plaintext po sprawdzeniu hasła. Odrzucone: serwer widzi wtedy wszystkie
sekrety w plaintextcie, zero-knowledge umiera całkowicie, a kompromitacja
serwera = katastrofa natychmiastowa dla wszystkich żywych dropów.
Design z §6 trzyma serwer poza plaintextem — to jest cała wartość
dodanej złożoności.

---

## 9. Podsumowanie: co jest czym

| Kontrola | Chroni przed | Nie chroni przed |
|---|---|---|
| Entropia frazy (600k PBKDF2, 77+ bitów) | offline brute-force na każdym ciphertextcie | niczym innym — to jest jedyna uniwersalna bariera |
| Jednorazowe kasowanie + atomowy claim | wyścigiem, powtórnym pobraniem | offline-łamaniem bloba |
| Crypto-shredding (DEK) | forensyką dysku, backupami, S3 versioning | złodziejem z ciphertextem — odrzucone jako zbędne po fix entropii |
| **Oracle (server-held H + V)** | offline-łamaniem bloba w ogóle; zamienia „one attempt" w politykę serwera | kradzieżą db+uploads (V łamalne), adminem, analog hole |
| PAKE zamiast V | nawet kradzieżą db+uploads | adminem, analog hole — za drogo na dziś |

**Zdanie dla audytora:** w modelu z oracle pobrany blob bez
współpracy serwera jest matematycznie martwymi bajtami — zgadywanie
hasła wymaga pytań do `/release`, gdzie obowiązuje rate limit,
lockout i opcjonalne spalenie klucza. Jednorazowość przestaje być
deklaracją JavaScriptu, a staje się transakcją bazodanową.

**Zdanie uczciwe dla klienta:** nic nie cofnie informacji raz
odszyfrowanej i nic nie zatrzyma admina, który jest złośliwy.
Wszystko powyżej dotyczy wyłącznie ochrony ciphertextu **przed**
legalnym deszyfrowaniem.

---

## 10. Status

- Design z §6 zarejestrowany jako opcja B w issue #138 (zamknięte
  jako `not planned` w cyklu audytowym — decyzja: najpierw naprawić
  entropię i atomowość, które zamykają 95% ryzyka za 20% nakładu).
- Wymaga jako fundamentu: #129, #130, #133, #135.
- Jeśli wróci popyt (np. wymóg klienta „provable one-time"),
  ten dokument jest specyfikacją implementacyjną.
