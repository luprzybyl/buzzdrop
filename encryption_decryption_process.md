# Client-Side Encryption and Decryption Process

This document outlines the client-side encryption and decryption processes implemented in this file-sharing application.

## Encryption Process (Client-Side: `templates/index.html`)

The encryption process occurs in the uploader's browser before the file is sent to the server.

1.  **Trigger:**
    *   The process starts when the user selects a file using the file input field and enters a password in the designated password field within the upload form.
    *   JavaScript code intercepts the default form submission to perform client-side encryption.

2.  **Password Handling:**
    *   The password is read directly from the HTML password input field (`<input type="password">`).

3.  **Key Derivation (PBKDF2):**
    *   **Algorithm:** PBKDF2 (Password-Based Key Derivation Function 2) is used to derive a strong encryption key from the user's password. This makes brute-forcing the password much harder.
    *   **Salt:** A cryptographically secure random salt (16 bytes) is generated for each encryption operation using `window.crypto.getRandomValues(new Uint8Array(16))`. This ensures that even if the same password is used for different files, the derived keys will be different.
    *   **Iterations:** 100,000 iterations are used for PBKDF2. A high number of iterations increases the computational cost of deriving the key, further strengthening security.
    *   **Hash Function:** SHA-256 is used as the underlying hash function for PBKDF2.
    *   **Derived Key:** The result of PBKDF2 is a 256-bit AES key, suitable for use with AES-GCM.

4.  **Encryption Algorithm (AES-GCM):**
    *   **Algorithm:** AES-GCM (Advanced Encryption Standard - Galois/Counter Mode) is used for the actual encryption of the file content. AES-GCM provides both confidentiality (encryption) and authenticity (integrity check).
    *   **IV (Initialization Vector):** A cryptographically secure random IV (12 bytes) is generated for each encryption operation using `window.crypto.getRandomValues(new Uint8Array(12))`. The IV must be unique for each message encrypted with the same key.

5.  **Payload Construction:**
    *   **Header:** A predefined header string, "BKP-FILE" (UTF-8 encoded), is prepended to the actual file content *before* encryption. This header acts as a simple integrity check after decryption to verify if the correct password was used.
    *   **Structure:** The final binary data to be uploaded is constructed by concatenating the following parts in order:
        1.  `salt` (16 bytes)
        2.  `iv` (12 bytes)
        3.  `encrypted_data` (which consists of the encrypted "BKP-FILE" header + encrypted actual file content)

6.  **Upload:**
    *   The combined binary data (salt + IV + encrypted payload) is packaged as a single Blob.
    *   This Blob is then uploaded to the server via a `POST` request to the `/upload` endpoint.

7.  **Password Storage by Uploader (Temporary):**
    *   After successful encryption and initiation of the upload, the original password entered by the uploader is temporarily stored in the browser's `sessionStorage`.
    *   This is done solely to display it on the `success.html` page for the uploader's convenience (e.g., to copy it).
    *   The password is cleared from `sessionStorage` when the user navigates away from or closes the success page.
    *   Crucially, the password is *not* automatically appended to the generated shareable link.

## Decryption Process (Client-Side: `templates/view.html`)

The decryption process occurs in the recipient's browser after they fetch the encrypted file from the server.

1.  **Trigger:**
    *   The recipient navigates to a share link provided by the uploader.
    *   They are typically first shown a confirmation page (`confirm_download.html`).
    *   Upon confirmation, they are redirected to `view.html`, which initiates the decryption process.

2.  **File Fetch:**
    *   As soon as `view.html` loads, JavaScript code makes an AJAX request to the `/download/<file_id>` server endpoint.
    *   The server responds with the entire encrypted file blob (containing salt + IV + encrypted data).
    *   **Important:** The server marks the file as downloaded and deletes it immediately after this request. This means the file can only be downloaded once.

3.  **Password Input:**
    *   The `view.html` page prompts the recipient to enter the password for the file.
    *   This password should have been communicated to the recipient securely and out-of-band by the uploader.

4.  **Data Parsing:**
    *   Once the encrypted blob is received from the server and the user provides a password:
        *   The first 16 bytes of the blob are extracted as the `salt`.
        *   The next 12 bytes are extracted as the `iv`.
        *   The remaining bytes constitute the `encrypted_data`.

5.  **Key Derivation (PBKDF2):**
    *   Using the password provided by the recipient and the `salt` extracted from the downloaded file.
    *   **Algorithm:** PBKDF2 is used with the exact same parameters as during encryption:
        *   100,000 iterations
        *   SHA-256 as the hash function.
    *   **Derived Key:** This process derives a 256-bit AES key. If the correct password was entered, this key will be identical to the one used for encryption.

6.  **Decryption Algorithm (AES-GCM):**
    *   **Algorithm:** AES-GCM is used for decryption, utilizing the derived key and the extracted `iv`.
    *   AES-GCM will automatically verify the integrity of the data during decryption. If the data was tampered with or if the key is incorrect, the decryption will fail.

7.  **Verification and File Extraction:**
    *   After successful AES-GCM decryption, the first few bytes of the decrypted plaintext are checked.
    *   They are compared against the expected "BKP-FILE" header.
    *   **Success:** If the header matches, it signifies that the correct password was used and the decryption was successful. The "BKP-FILE" header is then stripped from the decrypted data. The remaining data is the original file content.
    *   The original file is then made available to the user as a browser download, typically by creating a Blob from the decrypted content and generating a temporary download link.
    *   **Failure (Header Mismatch):** If the header does not match, it strongly implies that the wrong password was entered.

8.  **Error Handling:**
    *   If the AES-GCM decryption process itself fails (due to an integrity check error, often a consequence of an incorrect key), an error message is displayed.
    *   If the decryption succeeds but the "BKP-FILE" header does not match, an error message indicating a wrong password or corrupted file is displayed.
    *   In either case, the error message also informs the user that the file has already been deleted from the server as per the one-time download policy.

## Password Communication Method

*   The security of this system relies on the **uploader securely communicating the encryption password to the intended recipient out-of-band**.
*   Examples of out-of-band communication include: a different secure messaging app, verbally, a password manager's sharing feature, etc.
*   The application itself does **not** store the password on the server (beyond the uploader's temporary `sessionStorage` for display on the success page).
*   The password is **not** part of the shareable link by default. Appending it manually to the link by the uploader would bypass the password prompt on `view.html` but is generally not recommended unless the communication channel for the link itself is also secure.
