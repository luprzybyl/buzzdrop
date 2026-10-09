# How Buzzdrop works

The user-facing account of what happens when you share a file or a note with Buzzdrop: what runs where, what crosses the wire, what the server can and can't see, and why. It is the written source of truth for the public page at `/how-it-works`, which mirrors it step for step under the same step ids. The page's words live in `templates/_how_it_works_content.html`, which both of its layouts render (`how_it_works.html` at `/how-it-works`, and `how_it_works_v2.html` at `/how-it-works/v2` while the two are compared). Every claim the page makes lives here first.

The design behind it, and the reasoning for each choice, is in [`true-one-time.md`](true-one-time.md) (§3 for what no design can fix, §6.3–6.7 for the key-release protocol). This doc doesn't argue the design; it describes it.

<!-- how-it-works-fingerprint: sha256:e4964f75668faaca79d52c59368c4d570ef51cd21afe2804a833917e45d47c12 -->

> **Keeping this true.** The fingerprint above is a hash of the code that defines the flow: the recorded protocol contract, the browser crypto, the `buzz` CLI's crypto, upload and passphrase code, the web app's passphrase length, the database schema and the key-release defaults. `tests/unit/test_how_it_works_fingerprint.py` recomputes it and fails when that code changes. When it fails, re-read this doc and the page against the change, fix whichever is now wrong, and only then paste the new fingerprint from the test's message. The `CLAUDE.md` note "Explainer page — keep in step" says the same for reviewers.

## The three things to take away

- **We can't read your files or notes.** Encryption happens in the sender's browser (or terminal). The server only ever holds ciphertext, and it never sees the password.
- **One time really means one time.** The server holds half of the key and gives it out once, only to someone who proves they know the password. Then it destroys it.
- **We do keep some metadata.** Who uploaded what and when, the filename of a file, when it was opened and from which IP address. See [What we keep, and for how long](#what-we-keep).

## Two switches, one protocol

Whether you send from the web app or the `buzz` CLI, and whether you send a file or a text note, it is the same protocol and the same crypto. The page shows one flow with two switches; each step below lists what each switch changes.

| | Web app | `buzz` CLI |
|---|---|---|
| Steps 1–3 run in | your browser | your terminal |
| Signs in with | a login session, plus a CSRF token on every upload request | an API token (`Authorization: Bearer`) |
| Passphrase | can generate a 6-word passphrase on request | generates a 6-word passphrase unless you pass `-p` |
| Folders | — | zips a folder (or, with `-z`, a file) before encrypting |
| Where the encryption code comes from | served by our server with every page. Subresource Integrity protects it in transit and in caches, not against a compromised server | installed once from GitHub Releases, so a compromised server can't swap it during an upload |

| | File | Text note |
|---|---|---|
| Step 3 upload | the ciphertext as a multipart `file` | the ciphertext, base64-encoded, in a `note_text` field |
| End of step 7 | saved as a download | shown on the page, with Copy |
| What the server sees | ciphertext, its approximate size, and the **original filename in plain text** | ciphertext, its approximate size, and the label "Secret Note" |

The recipient's side (steps 5–7) always runs in a browser, whichever sender was used.

**CLI + text note doesn't exist yet.** `buzz` only sends files (no note mode, no stdin), so the page disables Text while the CLI is selected, with the hint "the CLI sends files only". It turns on when [#247](https://github.com/buzzdrop/buzzdrop/issues/247) (CLI note mode) lands.

**The filename is visible.** Until [#246](https://github.com/buzzdrop/buzzdrop/issues/246) (encrypt filenames) lands, a file's name travels and is stored in plain text: the server keeps it in its database, sends it in the download's `Content-Disposition` header and shows it on the recipient's confirm page. Neither this doc nor the page may claim the server knows nothing.

## The flow

<a id="step-upload-begin"></a>

### 1. Upload, phase 1

- **Who acts:** the sender's browser (web app) or terminal (CLI), then the server.
- **What crosses the wire:** a request to `POST /upload/begin`, authenticated by the login session and its CSRF token (web app) or by the API token in `Authorization: Bearer` (CLI). The server answers with a fresh `file_id` and a random 32-byte key share `H`.
- **What the server sees:** that this account is starting an upload. Nothing about the file or note yet.
- **Why:** the file key needs `H`, so `H` has to exist before anything is encrypted. The server keeps `H`; this is the half of the key it will later hand out exactly once. A share begun and never finished is swept once it is over an hour old (`KEY_SHARE_PENDING_TTL_SECONDS`), at the next `/upload/begin` or restart.

<a id="step-encrypt"></a>

### 2. Encrypt where you are

- **Who acts:** the sender's browser or terminal, alone. Nothing crosses the wire.
- **What happens:** the password goes through PBKDF2-SHA256 with 600,000 iterations and a random salt. Two keys are derived from the result with HKDF: `Kp` (for encryption) and the verifier `V` (for proving the password later). The file key is `HKDF(Kp ‖ H)`, so it needs both the password and the server's share. A random 32-byte receipt is put in front of the content, and the whole thing is encrypted with AES-GCM.
- **What the server sees:** nothing. The password and `Kp` never leave the device.
- **Why:** whoever has the ciphertext and `H` but not the password still can't decrypt, and whoever has the ciphertext and the password but not `H` can't either. The receipt is how the recipient will later prove they decrypted it.
- **Sender switch:** the web app runs this in the page's JavaScript; it can also generate a 6-word passphrase on request. The CLI runs it locally in Python and generates a 6-word passphrase unless you pass one with `-p`; it zips a folder (or, with `-z`, a file) first.

<a id="step-upload-finish"></a>

### 3. Upload, phase 2

- **Who acts:** the sender's browser or terminal, then the server.
- **What crosses the wire:** `POST /upload` with the ciphertext, the `file_id`, `V` and `SHA-256(receipt)`, authenticated the same way as step 1. Only the account that ran step 1 may finish it.
- **What the server sees:** the ciphertext and its approximate size, `V`, the receipt's hash, the expiry you chose, an optional private note to yourself, and for a file its original filename. It stores the ciphertext (on disk or in S3) and binds `V` to `H`.
- **Why:** `V` lets the server check the password later without ever learning it. `V` can't be turned back into `Kp`.
- **Content switch:** a file goes up as a multipart `file`, with its filename. A text note goes up as base64 in a `note_text` field, labelled "Secret Note".

<a id="step-share"></a>

### 4. Share

- **Who acts:** you.
- **What crosses the wire:** nothing to us. You send the link one way, and ideally the password another (a different app, a call).
- **What the server sees:** nothing. The link alone opens nothing: it names the drop, and the drop needs the password.
- **One-click link:** both the web app and the CLI also offer a link with the password after the `#`. Browsers never send that part to the server, so we still don't see the password. But anyone who has that link can decrypt the drop, and chat history, link previews and exports keep a copy. It is convenient; sending link and password separately is stronger.

<a id="step-release"></a>

### 5. The recipient proves the password

- **Who acts:** the recipient's browser, then the server.
- **What crosses the wire:** the browser derives `V` from the typed password and posts it to `POST /release/<id>`. Never the password.
- **What the server sees:** `V`, and the recipient's IP address, which it logs with a successful or wrong attempt. It compares `V` with the stored one in constant time, in one database transaction.
- **On a match:** the server hands over `H`, once, and wipes `H` and `V` from its database. In the same step it stores the digest of a one-time download ticket, which the browser derives from `H`; the ticket itself is never sent by the server.
- **On a wrong password:** the attempt is counted. By default one wrong password locks the drop and destroys `H` (`KEY_RELEASE_MAX_ATTEMPTS=1`, `KEY_RELEASE_BURN_ON_LOCKOUT` on), so nobody can open it after that, the recipient included.
- **Why:** this is what makes one time real. Without `H` the ciphertext is dead bytes, and `H` comes out exactly once, after the password has been proven, in a transaction only one requester can win.

<a id="step-download"></a>

### 6. Download once

- **Who acts:** the recipient's browser, then the server.
- **What crosses the wire:** `GET /download/<id>` with the ticket in `X-Download-Ticket`. The server streams the ciphertext back.
- **What the server sees:** the ticket, and the recipient's IP address, which it stores with the time of the download.
- **Then:** the ticket is used up before the first byte goes out, and the ciphertext is deleted from storage once the stream ends, even if it broke off. A released drop nobody downloads within 10 minutes (`KEY_RELEASE_DOWNLOAD_TTL_SECONDS`) expires the same way.
- **Why:** only the browser that won the release can claim the ciphertext, and there is no second copy to come back for.

<a id="step-decrypt"></a>

### 7. Decrypt in the browser

- **Who acts:** the recipient's browser, then the server.
- **What happens:** the browser derives the file key from `Kp` (from the password) and `H`, decrypts, and takes out the receipt. It posts the receipt to `POST /report_decryption/<id>`, so the sender's list shows the drop as opened (and, if the sender asked, emails them).
- **What the server sees:** the receipt, which only matches its stored hash if the drop was really decrypted. It learns that decryption worked, never the content.
- **Content switch:** a file is saved as a download. A text note is shown on the page with a Copy button.

<a id="step-expiry"></a>

### 8. Expiry and manual delete

- **Who acts:** the server, or the sender.
- **What happens:** when a drop's expiry passes (checked when it is opened, at startup and every five minutes by default), or the sender deletes it from their list, `H` is destroyed and the ciphertext is deleted from storage. SQLite overwrites deleted pages, which reduces (but doesn't rule out) traces of `H` left in the database file.
- **Why:** `H` never outlives the drop. Deleting the ciphertext from storage is best effort (a failed delete is not retried), but without `H` a leftover ciphertext can't be decrypted.

<a id="server-sees"></a>

## What the server sees

| | The server sees | The server never sees |
|---|---|---|
| Content | ciphertext and its approximate size | the plaintext |
| Password | `V`, a one-way fingerprint of it | the password, `Kp`, the file key |
| Name | a file's original filename; for a note, the label "Secret Note" | — |
| People | the sender's account; the recipient's IP address | who the recipient is |

<a id="what-we-keep"></a>

## What we keep, and for how long

- **The ciphertext:** until it is downloaded, it expires, or the sender deletes it. Then it is deleted from storage.
- **`H` and `V`:** until the release succeeds, the drop locks, it expires, or it is deleted. Whichever comes first destroys them.
- **The drop's record:** the filename (or "Secret Note"), the sender's account, when it was created, its expiry, when it was opened and from which IP address, whether decryption worked, and the sender's optional private note and notification address. It stays in the sender's list until the sender deletes it; there is no automatic purge.
- **Server logs:** every successful or wrong release attempt is logged with the requester's IP address. How long logs are kept is up to whoever runs the server.

<a id="limits"></a>

## Limits

What Buzzdrop does not protect against. None of these is fixable by any design; see `true-one-time.md` §3 and §6.7.

- **The recipient can keep a copy.** Once a file or note is decrypted, it can be saved, copied or photographed. One time means the key is handed out once, not that the content can't be kept.
- **The server operator controls the code.** The web app's encryption code comes from the server. Someone in control of the server could serve code that leaks the password, or log `V` and `H`. The CLI's code comes from GitHub Releases instead, but the recipient's side always runs in a browser.
- **Weak passwords.** If someone steals the database and the stored files together, they can try passwords against `V` offline. 600,000 PBKDF2 iterations make every guess slow; a long passphrase makes the search hopeless, a short password doesn't.
- **A one-click link is the key.** Whoever has it can open the drop.
- **A wrong guess can destroy a drop.** Anyone with the link can spend the attempt and lock it, so the real recipient can't open it.
