# True one-time: why "self-destructing" is a promise today, not a mechanism

This document collects the full analysis of the "true one-time download"
problem in buzzdrop: what actually protects the data today, what cannot
be protected at all, and the only design in which one-time semantics are
enforced by the server rather than by the recipient's honest JavaScript.

Source: security audit `audyt-bezpieczenstwa.md` (findings 1 and 10)
and the closed architecture decision in issue #138.

---

## 1. What the problem is

Buzzdrop advertises itself as "one-time, self-destructing". The actual
sequence of events at download time looks like this:

```
1. GET /view/<id>         → confirmation page
2. GET /download/<id>     → server hands out the full ciphertext and DELETES the file
3. user enters password   → view.js decrypts LOCALLY in the browser
```

The server never sees the password and never checks a single decryption
attempt. "One attempt" is enforced solely by the honest `view.js`
disabling the password field after the first failure:

```js
decryptBtn.disabled = true;
passInput.disabled = true;
```

That is UI politeness, not a security boundary. An attacker does not
use our browser or our JavaScript — they take the bytes and crack them
locally, as long and as fast as they like.

### Why the ciphertext is a "self-answering puzzle"

The key observation: the encrypted blob is **self-verifying**.
The format is `salt ‖ iv ‖ AES-GCM(key, data)`. The GCM tag is checked
on every decryption attempt — guess the password right and the tag
verifies; guess wrong and you get an error. This means the ciphertext
carries an **oracle** inside it: anyone holding it can test any password
forever, without asking anyone's permission.

This is the foundation of the entire problem. As long as all the
material needed for decryption fits in a single file that we hand out
to every link holder — no server-side policy enforces anything.

---

## 2. Threat model: who holds what

| Actor | Holds | Can do today |
|---|---|---|
| Recipient (link + password) | ciphertext, password | decrypts — as intended |
| Link thief (link, no password) | ciphertext | unlimited offline brute force |
| Theft of `buzzdrop.db` + `uploads/` | ciphertext of all files | unlimited offline brute force |
| Public/misconfigured S3 | ciphertext | unlimited offline brute force |
| Server administrator | everything | everything — out of model |
| Recipient after decryption | plaintext | irreversible — see §3 |

Today the **only** control protecting the ciphertext is password
entropy — a control the user must supply themselves.

---

## 3. The physics limit: analog hole and what is unsolvable

Three things **no** design can fix — worth stating explicitly so we
don't chase the impossible:

**Analog hole.** At decryption time the plaintext sits in the
recipient's browser RAM. They can copy it, screenshot it, write it
down. No cryptography takes back information someone has already read.
Even Signal with disappearing messages can't stop a screenshot — it
only protects against a persistent copy on the server. For us this is
arguably a feature: the password is *meant* to reach the recipient.
"One-time" protects against the rest of the world, not the recipient.

**Server administrator.** Has the blob, the database, the code and the
RAM. Always wins. Every zero-knowledge model is de facto
"zero-knowledge modulo trusted operator".

**Offline attack on a delivered ciphertext with a weak password.** The
only vector that no deletion and no rate limit closes — because the
attack never goes through the server. The only defense is password
entropy ("trivially crackable" vs "practically uncrackable") or taking
the crackable material away from the attacker — see §6.

---

## 4. Why entropy is the whole defense today

Since the blob is self-verifying, the cost of breaking it is purely
the cost of sweeping the password space through PBKDF2.

Current state (audit, finding 1):

- CLI generates a default passphrase from a **691-word list × 4 words** → ~37.7 bits
- PBKDF2-HMAC-SHA256, 100k iterations → ~40 guesses/s/CPU core;
  hashcat-class GPU: 5–20M guesses/s
- result: **the default password falls in hours on a single GPU**

Fix (issues #129, #130, #135):

- EFF list (7776 words) × 6 words → **~77.5 bits**
- PBKDF2 ≥ 600k iterations → ~6× higher cost per guess
- generator + strength gate in the UI — because the model rests on
  entropy, entropy must be **enforced**, not suggested by a placeholder

At ~77 bits and 600k iterations, offline brute force stops being a
practical attack for a single actor — it becomes a state-budget
problem. That is sufficient for most use cases.

But: this is still "we trust entropy", not "the server enforces
one-time".

---

## 5. Dead end: file deletion and crypto-shredding

The first natural answer — "let's delete the file properly". Problem:
`unlink()` doesn't erase bytes. It frees blocks; stale data survives
in snapshots, backups, versioned S3, on wear-leveled SSDs.
"Deletion" is best effort, not a guarantee.

There is an elegant pattern for this — **crypto-shredding**: encrypt
the blob a second time under a per-file key (DEK), keep the DEK in a
controlled place (env/KMS/RAM), and deleting the DEK = mathematical
death of every ciphertext copy, regardless of where the bytes
physically survive.

Why we rejected it (decision in #138): crypto-shredding defends
**undelivered** copies — backups and forensics. But those copies are
dead anyway once the passphrase has 77 bits. In exchange we get a new
failure mode: losing the key/master secret = death of all drops.
A large complexity cost for protection of a vector already closed
by entropy.

And more importantly — **it doesn't solve the actual problem**: the
delivered blob remains self-verifying. The link thief cracks it
offline exactly as before.

---

## 6. The design that solves the actual problem: server-gated key release

The only way to make "one-time" a fact rather than a hope:
**the blob must not contain everything needed for decryption**.
A piece of the key is held by the server and released once, under
conditions the server itself enforces.

### 6.1. Concepts (plainly, no jargon)

- **PBKDF2** — a function that turns a password into a key,
  deliberately slowly (hundreds of thousands of iterations) so that
  guessing costs something. Output: a byte string of "key material".
- **HKDF** — a function that derives purpose-specific keys from key
  material. `HKDF(m, "enc")` and `HKDF(m, "ver")` produce two
  different keys from the same `m`; knowing one **does not allow**
  computing the other or `m` (one-way function).
- **AES-GCM** — encryption with a built-in authenticity tag:
  wrong key = immediate rejection, not "maybe it worked".
- **PAKE** — a family of protocols (SRP, OPAQUE) in which a party
  proves knowledge of a password without sending it and without
  giving the server anything offline-crackable. The "proper" version
  of our V — see §7.

### 6.2. New elements

```
master    = PBKDF2(password, salt, 600k)   # computed ONLY in the browser
Kp        = HKDF(master, "enc")            # client half — never leaves
                                           # the browser
V         = HKDF(master, "ver")            # verifier — held by the server
H         = random 32 bytes                # server half — held by the
                                           # server, released ONCE

file_key  = HKDF(Kp ‖ H)                   # requires BOTH halves
blob      = AES-GCM(file_key, file)
```

**The most important sentence in this document: the server never
knows the file key.** It doesn't have it at any point — not at upload,
not at download, not in the database, not in logs. The key exists only
where `Kp` and `H` are assembled, and assembling them requires the
password, which the server doesn't know either.

Who knows what:

| Party | Holds | Does not hold |
|---|---|---|
| **browser** | `master`, `Kp`, `V`; `H` briefly (upload) or once (release) | — |
| **server** | `V`, `H`, `salt`, ciphertext | `master`, `Kp`, **file key**, password |
| **storage thief** | ciphertext | everything that makes it valuable |

Why `V` doesn't break zero-knowledge: `V` and `Kp` come from the same
`master` but through **different HKDF labels**. `Kp` or `master`
cannot be computed from `V` — the function is one-way. `V` is not
"part of the key", it's a password fingerprint: the exact same
mechanism every login system uses — a server can verify that the
entered password is correct without knowing the password itself.

### 6.3. Upload flow

```
1. POST /upload/begin      → server creates file_id + H, returns both
2. client: master = PBKDF2(password, salt)
           Kp = HKDF(master,"enc"); V = HKDF(master,"ver")
           key  = HKDF(Kp ‖ H)
           blob = AES-GCM(key, file)
3. POST /upload/finish     → ciphertext + salt + V
4. server stores: {file_id, H, V, salt, ciphertext, attempts: 0}
```

Notes:

- **H reaches the uploader's browser** — a necessity, not a bug:
  the uploader must assemble `Kp ‖ H` to encrypt the file. Their
  knowledge of H is not a leak — they hold the plaintext anyway.
- After upload the uploader's browser **forgets H**. `H` must not
  end up in the share link or any client-side storage — otherwise
  the gate ceases to exist, because the link would again be complete.

### 6.4. Download flow

```
1. GET /download/<id>      → ciphertext + salt   (H is NOT released)
2. client enters password → master → V'
3. POST /release/<id> {V'}   (harder variant: HMAC(V', nonce) challenge)
4. server, in a transaction:
     - compare_digest(V', V) — constant time
     - MATCH → releases H, atomically burns the record
               (UPDATE ... WHERE h_released IS NULL — exactly one winner)
     - MISS  → attempts++, exponential backoff, per-file_id limit;
               optionally burns the record after N failures
5. client: Kp ‖ H → file_key → decrypts locally
```

**H leaves the server exactly once, at one moment:** in response to
the winning `/release`, after a successful `V' == V` check. No match —
no H, and a stolen or legitimately downloaded ciphertext remains
mathematically dead. This is the essence: a piece of the key reaches
the client **only after proving knowledge of the password**, and the
release itself is a one-time atomic database operation.

Once H is released the recipient holds complete key material and can
save `ciphertext + Kp + H` and decrypt offline as many times as they
like. That cannot and need not be blocked — since they can save the
plaintext, policing ciphertext re-decryptions is moot (analog hole,
§3). One-time semantics apply to **access to the key**, not to using
already-decrypted content.

### 6.5. Why the server still can't decrypt

Two different questions often get conflated here — worth separating:

**"Can the server verify the password?" — YES.** And that's all it
needs. `V` works like a login-form hash: the client computes `V'` from
the entered password, the server compares it with the stored `V`
(constant-time, `compare_digest`). Match = "correct password entered"
= release H. The server never sees the password or the key — it only
sees a fingerprint.

**"Can the server decrypt the file?" — NO.** The file key is
`HKDF(Kp ‖ H)`. The server has `H`, `V` and the ciphertext, but `Kp`
is computed solely from the password — which the server doesn't know.
`V` cannot be walked back to `Kp` (different HKDF domain, one-way
function). To decrypt, the server would have to brute-force the
password — exactly as much work as an attacker does today.

So the guard verifies the password by fingerprint (V) and hands out
its key (H) — but the safe needs both keys at once, and the second
(Kp) only assembles in the hand of whoever knows the password. The
server controls **access** to the key without knowing the key itself.
That is the entire added value of this design over the "server
decrypts" variant (§8): a gate without giving up zero-knowledge.

Zero-knowledge preserved modulo the standard caveat:
"trusted operator" — an admin can log `V'`/`H` at `/release` or
swap the code. No design fixes that.

### 6.6. What this changes — the same threat model after implementation

| Actor | Today | With oracle |
|---|---|---|
| Link thief without password | blob → offline brute force | **dead blob** — no H; guessing only via `/release` under rate limit |
| Theft of `uploads/` / public S3 | ciphertext → offline | **dead bytes** — no H and no password |
| Theft of `db` + `uploads` | brute-force ciphertext | brute-force V (600k) → recovers password → **no worse than today** |
| Race: recipient vs thief | both get the blob; race is at cracking | atomic claim — exactly one gets H; loser sees "claimed" |
| "One attempt" | honesty of view.js | **server policy**: X attempts, backoff, burn — actually enforced |
| Recipient after decryption | plaintext | plaintext — analog hole, out of model |

Two additional properties worth stressing:

- **The blob stops being self-verifying.** A wrong password yields a
  wrong `Kp`, but without `H` the attacker can't even check whether
  they guessed — the oracle moved to the server, where every question
  costs and is counted.
- **"Typo = file lost" disappears.** Since the server counts attempts,
  we can allow 3–5 tries instead of instant death — closing the
  auditor's complaint about typo irreversibility. Today deletion after
  first download protected nothing (the attacker already had the
  blob); burning H on lockout actually takes a puzzle piece away
  from the attacker.

### 6.7. Honest costs and trade-offs

- **New protocol**: upload handshake (H must exist before encryption),
  `/release` endpoint, versioned payload format (`BKP-FILE` v2),
  CLI parity.
- **V is offline-crackable** after `db` theft — requires a strong KDF
  (already: 600k) and is no worse than today.
- **DoS vector**: a link thief can burn attempts. A "burn after N
  fails" policy protects the secret at the cost of availability;
  "lock without burn" does the reverse. Per-deployment choice —
  for a secrets tool, lost availability is usually cheaper than
  a leak.
- **Rate limit must be per file_id**, not only per IP — rotating
  addresses is trivial.
- **Residual gap**: `db` + `uploads` stolen together = back to today
  (brute-force V). Closing it would require holding H outside the
  database (KMS) — then DB theft doesn't yield H, and stealing the
  KMS itself is a different league of attack.
- **Admin always wins** — can log `V'`/`H` at `/release` or swap
  the code. No design fixes that.

---

## 7. The "graduate-level" variant: PAKE

The weak point of §6 is `V` — a verifier that, once the database is
stolen, can be cracked offline like a password hash. PAKE (SRP-6a,
OPAQUE, SPAKE2) solves exactly this: the server stores a registration
from which **nothing can be guessed offline**, and the client proves
knowledge of the password by exchanging messages that yield nothing
to an eavesdropper either (even one recording all traffic).

In our context PAKE would close the last row of the §6.6 table —
`db`+`uploads` theft would stop yielding material for an offline
attack. Cost: implementing the protocol in JS + server (OPAQUE has
libraries, but it's still a serious chunk of work and a surface for
crypto mistakes). Recommendation: the §6 design first — PAKE as an
evolution if the product grows.

---

## 8. Rejected alternative: server-side decryption

The simplest way to a real gate — let the server decrypt and serve
plaintext after verifying the password. Rejected: the server would
then see every secret in plaintext, zero-knowledge dies completely,
and a server compromise = instant catastrophe for all live drops.
The §6 design keeps the server away from plaintext — that is the
whole value of the added complexity.

---

## 9. Summary: what is what

| Control | Protects against | Does not protect against |
|---|---|---|
| Passphrase entropy (600k PBKDF2, 77+ bits) | offline brute force on any ciphertext | anything else — it is the only universal barrier |
| One-time deletion + atomic claim | races, re-download | offline cracking of the blob |
| Crypto-shredding (DEK) | disk forensics, backups, S3 versioning | a thief with the ciphertext — rejected as redundant after the entropy fix |
| **Oracle (server-held H + V)** | offline cracking of the blob at all; turns "one attempt" into server policy | db+uploads theft (V crackable), admin, analog hole |
| PAKE instead of V | even db+uploads theft | admin, analog hole — too expensive today |

**Sentence for the auditor:** in the oracle model a downloaded blob
without server cooperation is mathematically dead bytes — password
guessing requires asking `/release`, where a rate limit, lockout and
optional key-burn apply. One-time semantics stop being a JavaScript
declaration and become a database transaction.

**Honest sentence for the client:** nothing takes back information
once decrypted, and nothing stops a malicious admin. Everything above
concerns exclusively protecting the ciphertext **before** legitimate
decryption.

---

## 10. Status

- The §6 design is registered as option B in issue #138 (closed as
  `not planned` in the audit cycle — decision: fix entropy and
  atomicity first, which close 95% of the risk for 20% of the effort).
- Requires as foundation: #129, #130, #133, #135.
- If demand returns (e.g. a client requirement for "provable
  one-time"), this document is the implementation spec.

### Implementation note

The §6 design is implemented as the **only** share format —
**breaking change: no backward compatibility with pre-oracle shares
(acceptable per owner; pre-production wipe)**. `ORACLE_ENABLED`
(default: on) gates the upload handshake; when off, `/upload/begin`
returns 404 and uploads are refused.

- Rate-limit accounting: `/upload/begin` and `/upload` share the
  `UPLOAD_RATE_LIMIT` bucket — a complete upload costs 2 hits
  (effective 15 files/h at the default `30 per hour`).
- Wire format: `BKV3 ‖ salt(16) ‖ iv(12) ‖ AES-GCM`, inner `BKP-FILE`
  header kept. `Kp`/`V`/`file_key` use HKDF-SHA256 with the blob salt
  and `info` labels `enc`/`ver`/`file`. Only `BKV3` is read or written;
  the magic stays for future version bumps.
- Upload (always two-phase): `POST /upload/begin` → `{file_id, h}`;
  `POST /upload` requires `oracle_file_id` + `key_verifier` and
  atomically binds V to the pending share.
- Download: `POST /release/<file_id> {v}` — constant-time verifier
  check plus a single conditional write
  (`UPDATE ... WHERE released_at IS NULL`) → exactly one winner gets H.
- Key material lives in a `file_keys` table (H, V, attempts,
  released_at), not on `files`: the share must exist before the file
  record (two-phase upload), and existing databases need no column
  migrations — only `CREATE TABLE IF NOT EXISTS`.
- Failure policy is configurable: `ORACLE_RELEASE_RATE_LIMIT`
  (per file_id), `ORACLE_MAX_RELEASE_ATTEMPTS` (default 5), and
  `ORACLE_BURN_ON_LOCKOUT` (default off — lockout only; when on, the
  share row is deleted, destroying H).
- CLI parity: `cli/buzz` performs the same handshake and aborts when
  the server returns 404 on `/upload/begin`.
