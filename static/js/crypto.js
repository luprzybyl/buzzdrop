/**
 * CryptoService - Client-side encryption/decryption for Buzzdrop
 *
 * Implements the server-gated key release design (docs/true-one-time.md §6):
 * the file key is split in two — Kp derives from the password client-side,
 * H is a random 32-byte share the server holds and releases exactly once
 * after a verifier proof. A blob alone is mathematically dead.
 *
 * Wire format (outer envelope, unencrypted):
 *   'BKV3' (4 bytes) || salt (16) || iv (12) || AES-GCM ciphertext
 *   master   = PBKDF2-SHA256(password, salt, 600k)   [32 bytes]
 *   Kp       = HKDF(master, salt, 'enc')
 *   V        = HKDF(master, salt, 'ver')
 *   file_key = HKDF(Kp || H, salt, 'file')
 *
 * The version magic lives outside the encrypted data so future bumps stay
 * possible; only 'BKV3' is supported. The plaintext itself starts with
 * 'BKP-FILE' ‖ receipt(32B random) ‖ payload — the receipt is the
 * decryption proof the client returns to /report_decryption; the server
 * only ever stores its SHA-256 hash.
 */

/**
 * Convert bytes to a lowercase hex string (H/V travel the wire as hex).
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function bytesToHex(bytes) {
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Parse a hex string into bytes. Throws on malformed input.
 * @param {string} hex
 * @returns {Uint8Array}
 */
export function hexToBytes(hex) {
    if (typeof hex !== 'string' || hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) {
        throw new Error('Invalid hex string');
    }
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
}

export class CryptoService {
    constructor() {
        this.encoder = new TextEncoder();
        this.decoder = new TextDecoder();
        // PBKDF2 iteration count for the master key.
        this.ITERATIONS = 600000;
        // Outer envelope magic ('BKV3') — the only supported version.
        this.ENVELOPE_MAGIC = this.encoder.encode('BKV3');
        this.VERSION = 3;
        // HKDF domain separation labels (docs/true-one-time.md §6.2).
        this.HKDF_INFO_ENC = this.encoder.encode('enc');
        this.HKDF_INFO_VER = this.encoder.encode('ver');
        this.HKDF_INFO_FILE = this.encoder.encode('file');
        // Inner plaintext magic, prepended before encryption.
        this.HEADER = this.encoder.encode('BKP-FILE');
        this.SALT_LENGTH = 16;
        this.IV_LENGTH = 12;
        this.SHARE_LENGTH = 32;
        // Random 32-byte receipt encrypted inside the payload — proves
        // decryption to /report_decryption via its stored SHA-256 hash.
        this.RECEIPT_LENGTH = 32;
        // Smallest legal blob: magic + salt + iv + GCM tag (16) + the
        // inner header (8) + receipt (32) — anything shorter cannot be
        // a BKV3 blob.
        this.MIN_BLOB_LENGTH = 4 + 16 + 12 + 16 + 8 + 32;
    }

    /**
     * Assert the server share is exactly 32 bytes — a short/missing H
     * must fail loudly before any crypto runs.
     * @param {Uint8Array} h
     */
    _checkServerShare(h) {
        if (!(h instanceof Uint8Array) || h.length !== this.SHARE_LENGTH) {
            throw new Error(`server share H must be ${this.SHARE_LENGTH} bytes`);
        }
    }

    /**
     * Generate random salt (16 bytes)
     * @returns {Uint8Array} Random salt
     */
    generateSalt() {
        return window.crypto.getRandomValues(new Uint8Array(this.SALT_LENGTH));
    }

    /**
     * Generate random IV (12 bytes)
     * @returns {Uint8Array} Random initialization vector
     */
    generateIV() {
        return window.crypto.getRandomValues(new Uint8Array(this.IV_LENGTH));
    }

    /**
     * Derive the raw 32-byte master key from a password.
     * @param {string} password
     * @param {Uint8Array} salt
     * @returns {Promise<Uint8Array>}
     */
    async deriveMaster(password, salt) {
        const keyMaterial = await window.crypto.subtle.importKey(
            'raw',
            this.encoder.encode(password),
            'PBKDF2',
            false,
            ['deriveBits']
        );
        const bits = await window.crypto.subtle.deriveBits(
            {
                name: 'PBKDF2',
                salt: salt,
                iterations: this.ITERATIONS,
                hash: 'SHA-256'
            },
            keyMaterial,
            256
        );
        return new Uint8Array(bits);
    }

    /**
     * HKDF-SHA256 → 32 bytes. The blob's salt doubles as the HKDF salt:
     * it is random, non-secret, and known to both parties.
     * @param {Uint8Array} ikm - Input key material
     * @param {Uint8Array} salt - HKDF salt
     * @param {Uint8Array} info - Domain separation label
     * @returns {Promise<Uint8Array>}
     */
    async hkdf(ikm, salt, info) {
        const key = await window.crypto.subtle.importKey(
            'raw',
            ikm,
            'HKDF',
            false,
            ['deriveBits']
        );
        const bits = await window.crypto.subtle.deriveBits(
            { name: 'HKDF', hash: 'SHA-256', salt: salt, info: info },
            key,
            256
        );
        return new Uint8Array(bits);
    }

    /**
     * Derive the client half Kp and the verifier V for a share.
     * @param {string} password
     * @param {Uint8Array} salt - The blob's PBKDF2 salt
     * @returns {Promise<{kp: Uint8Array, v: Uint8Array}>}
     */
    async deriveKeyReleaseKeys(password, salt) {
        const master = await this.deriveMaster(password, salt);
        const kp = await this.hkdf(master, salt, this.HKDF_INFO_ENC);
        const v = await this.hkdf(master, salt, this.HKDF_INFO_VER);
        return { kp, v };
    }

    /**
     * Derive just the verifier V — what /release checks.
     * @param {string} password
     * @param {Uint8Array} salt - The blob's PBKDF2 salt
     * @returns {Promise<Uint8Array>} V (32 bytes)
     */
    async deriveVerifier(password, salt) {
        const master = await this.deriveMaster(password, salt);
        return this.hkdf(master, salt, this.HKDF_INFO_VER);
    }

    /**
     * Assemble the file key from both halves: HKDF(Kp ‖ H).
     * @param {Uint8Array} kp - Client half (from the password)
     * @param {Uint8Array} h - Server half (released once by /release)
     * @param {Uint8Array} salt - The blob's salt, reused as HKDF salt
     * @returns {Promise<Uint8Array>} file_key (32 bytes)
     */
    async deriveFileKey(kp, h, salt) {
        const ikm = new Uint8Array(kp.length + h.length);
        ikm.set(kp);
        ikm.set(h, kp.length);
        return this.hkdf(ikm, salt, this.HKDF_INFO_FILE);
    }

    /**
     * Parse a BKV3 envelope into its components.
     * @param {Uint8Array} blob - 'BKV3' + salt + iv + ciphertext
     * @returns {{version: number, salt: Uint8Array, iv: Uint8Array, ciphertext: Uint8Array}}
     * @throws {Error} If the magic is not 'BKV3'
     */
    parseBlob(blob) {
        const magic = this.ENVELOPE_MAGIC;
        if (blob.length < this.MIN_BLOB_LENGTH) {
            throw new Error('Unsupported share format');
        }
        for (let i = 0; i < magic.length; i++) {
            if (blob[i] !== magic[i]) {
                throw new Error('Unsupported share format');
            }
        }
        return {
            version: this.VERSION,
            salt: blob.slice(magic.length, magic.length + this.SALT_LENGTH),
            iv: blob.slice(
                magic.length + this.SALT_LENGTH,
                magic.length + this.SALT_LENGTH + this.IV_LENGTH),
            ciphertext: blob.slice(magic.length + this.SALT_LENGTH + this.IV_LENGTH),
        };
    }

    /**
     * Encrypt data for a share.
     * @param {Uint8Array} data - Raw data to encrypt
     * @param {string} password - Encryption password
     * @param {Uint8Array} h - Server share from /upload/begin (32 bytes)
     * @returns {Promise<{blob: Uint8Array, verifier: Uint8Array, receipt: Uint8Array}>}
     *   blob = 'BKV3' + salt + iv + ciphertext; verifier = V to bind on
     *   finish; receipt = the in-plaintext decryption proof (report back
     *   to /report_decryption; the server stores only its SHA-256)
     */
    async encrypt(data, password, h) {
        this._checkServerShare(h);
        const salt = this.generateSalt();
        const iv = this.generateIV();
        const receipt = window.crypto.getRandomValues(
            new Uint8Array(this.RECEIPT_LENGTH));
        const { kp, v } = await this.deriveKeyReleaseKeys(password, salt);
        const fileKey = await this.deriveFileKey(kp, h, salt);

        const key = await window.crypto.subtle.importKey(
            'raw', fileKey, 'AES-GCM', false, ['encrypt']
        );

        const headLen = this.HEADER.length + this.RECEIPT_LENGTH;
        const plain = new Uint8Array(headLen + data.length);
        plain.set(this.HEADER);
        plain.set(receipt, this.HEADER.length);
        plain.set(data, headLen);

        const encrypted = await window.crypto.subtle.encrypt(
            { name: 'AES-GCM', iv },
            key,
            plain
        );

        const magic = this.ENVELOPE_MAGIC;
        const blob = new Uint8Array(
            magic.length + salt.length + iv.length + encrypted.byteLength
        );
        blob.set(magic);
        blob.set(salt, magic.length);
        blob.set(iv, magic.length + salt.length);
        blob.set(new Uint8Array(encrypted), magic.length + salt.length + iv.length);

        return { blob, verifier: v, receipt };
    }

    /**
     * Compute the upload-time receipt hash: hex SHA-256(receipt).
     * @param {Uint8Array} receipt
     * @returns {Promise<string>}
     */
    async receiptHash(receipt) {
        const digest = await window.crypto.subtle.digest('SHA-256', receipt);
        return bytesToHex(new Uint8Array(digest));
    }

    /**
     * Decrypt a blob once the server has released H.
     * @param {Uint8Array} encryptedData - 'BKV3' + salt + iv + ciphertext
     * @param {string} password - Decryption password
     * @param {Uint8Array} h - Server share released by /release (32 bytes)
     * @returns {Promise<{data: Uint8Array, receipt: Uint8Array}>}
     *   data = payload without header/receipt; receipt = decryption proof
     * @throws {Error} If password/H is wrong or data is corrupted
     */
    async decrypt(encryptedData, password, h) {
        this._checkServerShare(h);
        const { salt, iv, ciphertext } = this.parseBlob(encryptedData);

        const { kp } = await this.deriveKeyReleaseKeys(password, salt);
        const fileKey = await this.deriveFileKey(kp, h, salt);

        const key = await window.crypto.subtle.importKey(
            'raw', fileKey, 'AES-GCM', false, ['decrypt']
        );

        const decrypted = await window.crypto.subtle.decrypt(
            { name: 'AES-GCM', iv },
            key,
            ciphertext
        );

        const decryptedBytes = new Uint8Array(decrypted);
        if (!this.validateHeader(decryptedBytes)) {
            throw new Error('Invalid password or corrupted data');
        }
        const headLen = this.HEADER.length + this.RECEIPT_LENGTH;
        if (decryptedBytes.length < headLen) {
            throw new Error('Invalid password or corrupted data');
        }
        return {
            data: decryptedBytes.slice(headLen),
            receipt: decryptedBytes.slice(this.HEADER.length, headLen),
        };
    }

    /**
     * Validate magic header in decrypted data
     * @param {Uint8Array} data - Decrypted data to validate
     * @returns {boolean} True if header is valid
     */
    validateHeader(data) {
        if (data.length < this.HEADER.length) {
            return false;
        }
        for (let i = 0; i < this.HEADER.length; i++) {
            if (data[i] !== this.HEADER[i]) {
                return false;
            }
        }
        return true;
    }
}
