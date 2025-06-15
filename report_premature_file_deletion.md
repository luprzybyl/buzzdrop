# Report Section: Premature File Deletion Issue

This section discusses a critical design flaw in the file download and deletion mechanism, termed "Premature File Deletion."

## 1. Explanation of the Current Mechanism

The current file download and self-destruction process is implemented as follows:

*   **File Fetch Trigger:** When a recipient navigates to `view.html` (typically after passing through `confirm_download.html`), JavaScript on the `view.html` page automatically initiates a request to fetch the encrypted file.
*   **Server-Side Download Route (`/download/<file_id>`):**
    *   The client's request hits the `/download/<file_id>` endpoint in the Flask application (`app.py`).
    *   Crucially, this route performs the following actions in sequence:
        1.  It retrieves the file's metadata from the database.
        2.  It **immediately updates the file's record** in the database, setting the `downloaded_at` timestamp. This effectively marks the file as "used" or "claimed."
        3.  It then **deletes the physical file** from the storage system (either the local filesystem or S3, depending on the configuration).
        4.  *After* the file has been deleted from storage and its record marked as downloaded, the route then proceeds to stream the file's content (which it presumably read into memory before deletion) back to the client (`view.html`).
*   **Client-Side Decryption Attempt:** The client (`view.html`) receives the full encrypted blob. Only *after* receiving the content does it prompt the user for a password to attempt decryption.

The critical point is that the server deletes the file *before* the client has even attempted to decrypt it, and certainly before the success of such decryption is known.

## 2. Negative Consequences

This "delete-then-decrypt" approach has several significant negative consequences for the user:

*   **Data Loss on User Error:** If the recipient makes a typographical error when entering the password on `view.html`, the client-side decryption will fail (AES-GCM integrity check will fail, or the "BKP-FILE" header won't match). Because the file has already been irrevocably deleted from the server, the recipient has **no opportunity to correct the password and retry**. The file is permanently lost.
*   **Harsh User Experience:** The "one-shot-at-password-entry-for-an-already-deleted-file" mechanism is extremely unforgiving. Users accustomed to systems allowing password retries will find this behavior frustrating and potentially data-destructive.
*   **Potential for Perceived Denial of Service:** A legitimate recipient who makes a simple mistake can be permanently locked out from accessing the shared file. From their perspective, the service has failed to deliver the file due to a minor, correctable error.
*   **No Recovery Path:** The application, in its current design, offers no mechanism for the user to recover from this situation for that specific upload. The uploader would need to re-upload the file and share a new link.

## 3. Why it's a "Bad Smell" / Vulnerability

While this issue is not a traditional security vulnerability that leads to data compromise (e.g., unauthorized access), it represents a significant **design flaw and a reliability vulnerability** in the core "self-destructing share" feature.

*   **Brittleness:** It makes the "single download" feature overly brittle and susceptible to common user errors. A feature designed for privacy/ephemerality should not be so easily thwarted by a typo.
*   **User Trust Erosion:** Such a harsh failure mode can erode user trust in the reliability of the application. Users may be hesitant to use it for important files if the risk of accidental permanent loss is high.
*   **Violation of Principle of Least Astonishment:** The system behaving in a way that leads to permanent data loss on a simple input error is likely to surprise and frustrate users.

It turns the "self-destruct" feature from a controlled, intentional action (by the sender) into a potential accidental data loss event (by the recipient).

## 4. Proposed Revised Flow for Remediation

To address this premature deletion issue, a revised workflow is proposed that defers the actual file deletion until after successful client-side decryption is highly probable:

1.  **Initial Fetch (Client - `view.html`):**
    *   The client (`view.html`) fetches the *entire* encrypted file from a modified `/download/<file_id>` endpoint.
    *   **Crucially, this server endpoint should NOT immediately delete the file or mark it as downloaded in the database.** It simply serves the content. (Alternatively, it could serve only metadata like salt and IV first, requiring a second request for the content, but fetching all at once might be simpler if deletion is handled by a separate call).

2.  **Password Entry and Local Decryption Attempt (Client):**
    *   The user enters the password in `view.html`.
    *   The client derives the decryption key using PBKDF2 with the provided password and the extracted salt (from the fetched file).
    *   The client attempts to decrypt a small, known portion of the file, specifically the "BKP-FILE" header. This partial decryption is computationally fast.

3.  **Client-Side Verification:**
    *   **If "BKP-FILE" header decryption is successful:** The client now has high confidence that the password is correct.
        *   It can proceed to decrypt the rest of the file locally.
        *   After successful full decryption and making the file available to the user (e.g., initiating a browser download), the client sends a **separate, explicit request** to a new server endpoint (e.g., `/confirm_successful_download_and_delete/<file_id>`).
        *   This new server endpoint is then responsible for updating the `downloaded_at` timestamp in the database and deleting the physical file from storage.
    *   **If "BKP-FILE" header decryption fails:**
        *   The file remains on the server, untouched and not marked as downloaded.
        *   The client (`view.html`) can inform the user that the password was incorrect and prompt them to **retry entering the password**.
        *   A reasonable limit on password retries (e.g., 3-5 attempts) could be implemented on the client-side or tracked server-side (though client-side is simpler for this model) before telling the user to contact the sender.

4.  **Server-Side Cleanup (Optional but Recommended):**
    *   Even with the above, files that are downloaded but for which the `/confirm_successful_download_and_delete` call is never received (e.g., user closes browser after successful decryption but before the call is made) should eventually be cleaned up. A periodic server-side task could delete files that were created (or even accessed via `/download/`) but not confirmed as successfully downloaded after a certain period (e.g., 24 hours after the link was first accessed). This is secondary to the main fix.

**Benefits of the Revised Flow:**

*   **Prevents Data Loss:** Users can retry password entry, significantly reducing the risk of permanent file loss due to typos.
*   **Improved User Experience:** The flow is more forgiving and aligns better with user expectations.
*   **Increased Reliability:** The "self-destruct" feature becomes more robust.
*   **Maintained Security:** The file is still deleted after a successful download, preserving the intended ephemerality.

This revised approach shifts the responsibility of confirming a *successful* download to the client, ensuring the file is only truly "consumed" and deleted after a high degree of confidence in the recipient's ability to access its contents.
