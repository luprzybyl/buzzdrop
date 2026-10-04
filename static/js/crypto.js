/**
 * CryptoService - Client-side encryption/decryption for Buzzdrop
 *
 * Provides AES-GCM encryption with PBKDF2 key derivation.
 * All encryption happens in the browser before upload.
 *
 * Wire format (outer envelope, unencrypted):
 *   v3 (oracle): 'BKV3' (4 bytes) || salt (16) || iv (12) || AES-GCM ciphertext
 *       master = PBKDF2-SHA256(password, salt, 600k)  [32 bytes]
 *       Kp = HKDF(master, salt, 'enc'); V = HKDF(master, salt, 'ver')
 *       file_key = HKDF(Kp || H, salt, 'file')  — needs the server share H
 *   v2: 'BKV2' (4 bytes) || salt (16 bytes) || iv (12 bytes) || AES-GCM ciphertext
 *       PBKDF2-SHA256, 600,000 iterations
 *   v1 (legacy): salt (16 bytes) || iv (12 bytes) || AES-GCM ciphertext
 *       PBKDF2-SHA256, 100,000 iterations
 *
 * The version marker lives outside the encrypted data so the iteration count
 * is known before key derivation. v1 blobs are identified by the ABSENCE of
 * the 'BKV2'/'BKV3' magic; a v1 salt colliding with the magic has probability
 * 2^-32 per blob — negligible, and the worst case is a failed GCM auth tag
 * reported as a wrong password.
 *
 * v3 implements the server-gated key release design (docs/true-one-time.md
 * §6): the blob alone cannot be decrypted — the recipient must also prove
 * the password to /release, which hands out the server share H exactly once.
 *
 * The plaintext itself starts with the magic header 'BKP-FILE' (inside the
 * ciphertext) for integrity validation.
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
        // KDF iteration counts per payload version.
        this.ITERATIONS_V1 = 100000;
        this.ITERATIONS_V2 = 600000;
        this.ITERATIONS_V3 = 600000;
        // Outer envelope magics marking versioned payloads.
        this.ENVELOPE_MAGIC_V2 = this.encoder.encode('BKV2');
        this.ENVELOPE_MAGIC_V3 = this.encoder.encode('BKV3');
        // HKDF domain separation labels (docs/true-one-time.md §6.2).
        this.HKDF_INFO_ENC = this.encoder.encode('enc');
        this.HKDF_INFO_VER = this.encoder.encode('ver');
        this.HKDF_INFO_FILE = this.encoder.encode('file');
        // Inner plaintext magic, prepended before encryption.
        this.HEADER = this.encoder.encode('BKP-FILE');
        this.SALT_LENGTH = 16;
        this.IV_LENGTH = 12;
        this.SHARE_LENGTH = 32;
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
     * Derive encryption key from password using PBKDF2
     * @param {string} password - Password to derive key from
     * @param {Uint8Array} salt - Salt for key derivation
     * @param {number} iterations - PBKDF2 iteration count
     * @returns {Promise<CryptoKey>} Derived encryption key
     */
    async deriveKey(password, salt, iterations) {
        const keyMaterial = await window.crypto.subtle.importKey(
            'raw',
            this.encoder.encode(password),
            'PBKDF2',
            false,
            ['deriveKey']
        );

        return await window.crypto.subtle.deriveKey(
            {
                name: 'PBKDF2',
                salt: salt,
                iterations: iterations,
                hash: 'SHA-256'
            },
            keyMaterial,
            { name: 'AES-GCM', length: 256 },
            true,
            ['encrypt', 'decrypt']
        );
    }

    /**
     * Derive the raw 32-byte master key from a password (v3 only).
     * @param {string} password
     * @param {Uint8Array} salt
     * @param {number} iterations
     * @returns {Promise<Uint8Array>}
     */
    async deriveMaster(password, salt, iterations) {
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
                iterations: iterations,
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
     * Derive the client half Kp and the verifier V for a v3 share.
     * @param {string} password
     * @param {Uint8Array} salt - The blob's PBKDF2 salt
     * @returns {Promise<{kp: Uint8Array, v: Uint8Array}>}
     */
    async deriveOracleKeys(password, salt) {
        const master = await this.deriveMaster(password, salt, this.ITERATIONS_V3);
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
        const master = await this.deriveMaster(password, salt, this.ITERATIONS_V3);
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
     * Encrypt data for an oracle (v3) share.
     * @param {Uint8Array} data - Raw data to encrypt
     * @param {string} password - Encryption password
     * @param {Uint8Array} h - Server share from /upload/begin (32 bytes)
     * @returns {Promise<{blob: Uint8Array, verifier: Uint8Array}>}
     *   blob = 'BKV3' + salt + iv + ciphertext; verifier = V to bind on finish
     */
    async encryptV3(data, password, h) {
        const salt = this.generateSalt();
        const iv = this.generateIV();
        const { kp, v } = await this.deriveOracleKeys(password, salt);
        const fileKey = await this.deriveFileKey(kp, h, salt);

        const key = await window.crypto.subtle.importKey(
            'raw', fileKey, 'AES-GCM', false, ['encrypt']
        );

        const plain = new Uint8Array(this.HEADER.length + data.length);
        plain.set(this.HEADER);
        plain.set(data, this.HEADER.length);

        const encrypted = await window.crypto.subtle.encrypt(
            { name: 'AES-GCM', iv },
            key,
            plain
        );

        const magic = this.ENVELOPE_MAGIC_V3;
        const blob = new Uint8Array(
            magic.length + salt.length + iv.length + encrypted.byteLength
        );
        blob.set(magic);
        blob.set(salt, magic.length);
        blob.set(iv, magic.length + salt.length);
        blob.set(new Uint8Array(encrypted), magic.length + salt.length + iv.length);

        return { blob, verifier: v };
    }

    /**
     * Decrypt a v3 blob once the server has released H.
     * @param {Uint8Array} encryptedData - 'BKV3' + salt + iv + ciphertext
     * @param {string} password - Decryption password
     * @param {Uint8Array} h - Server share released by /release (32 bytes)
     * @returns {Promise<Uint8Array>} Decrypted data (without header)
     * @throws {Error} If password/H is wrong or data is corrupted
     */
    async decryptV3(encryptedData, password, h) {
        const { offset } = this.detectVersion(encryptedData);

        const salt = encryptedData.slice(offset, offset + this.SALT_LENGTH);
        const iv = encryptedData.slice(
            offset + this.SALT_LENGTH, offset + this.SALT_LENGTH + this.IV_LENGTH);
        const encrypted = encryptedData.slice(offset + this.SALT_LENGTH + this.IV_LENGTH);

        const { kp } = await this.deriveOracleKeys(password, salt);
        const fileKey = await this.deriveFileKey(kp, h, salt);

        const key = await window.crypto.subtle.importKey(
            'raw', fileKey, 'AES-GCM', false, ['decrypt']
        );

        const decrypted = await window.crypto.subtle.decrypt(
            { name: 'AES-GCM', iv },
            key,
            encrypted
        );

        const decryptedBytes = new Uint8Array(decrypted);
        if (!this.validateHeader(decryptedBytes)) {
            throw new Error('Invalid password or corrupted data');
        }
        return decryptedBytes.slice(this.HEADER.length);
    }

    /**
     * Detect the payload format version and locate the v1-style body
     * (salt || iv || ciphertext) within the blob.
     * @param {Uint8Array} encryptedData - Encrypted payload
     * @returns {{version: number, iterations: number, offset: number}}
     */
    detectVersion(encryptedData) {
        const minLength = this.ENVELOPE_MAGIC_V2.length + this.SALT_LENGTH + this.IV_LENGTH;
        if (encryptedData.length >= minLength) {
            const prefix = bytesToHex(encryptedData.slice(0, 4));
            if (prefix === '424b5633') { // 'BKV3'
                return {
                    version: 3,
                    iterations: this.ITERATIONS_V3,
                    offset: this.ENVELOPE_MAGIC_V3.length,
                };
            }
            if (prefix === '424b5632') { // 'BKV2'
                return {
                    version: 2,
                    iterations: this.ITERATIONS_V2,
                    offset: this.ENVELOPE_MAGIC_V2.length,
                };
            }
        }
        // No envelope magic: legacy v1 payload.
        return { version: 1, iterations: this.ITERATIONS_V1, offset: 0 };
    }

    /**
     * Encrypt data with password (always produces a v2 payload)
     * @param {Uint8Array} data - Raw data to encrypt
     * @param {string} password - Encryption password
     * @returns {Promise<Uint8Array>} 'BKV2' + salt + iv + encrypted data
     */
    async encrypt(data, password) {
        const salt = this.generateSalt();
        const iv = this.generateIV();
        const key = await this.deriveKey(password, salt, this.ITERATIONS_V2);

        // Prepend header for integrity validation
        const plain = new Uint8Array(this.HEADER.length + data.length);
        plain.set(this.HEADER);
        plain.set(data, this.HEADER.length);

        // Encrypt with AES-GCM
        const encrypted = await window.crypto.subtle.encrypt(
            { name: 'AES-GCM', iv },
            key,
            plain
        );

        // Concatenate magic + salt + iv + encrypted data
        const magic = this.ENVELOPE_MAGIC_V2;
        const result = new Uint8Array(
            magic.length + salt.length + iv.length + encrypted.byteLength
        );
        result.set(magic);
        result.set(salt, magic.length);
        result.set(iv, magic.length + salt.length);
        result.set(new Uint8Array(encrypted), magic.length + salt.length + iv.length);

        return result;
    }

    /**
     * Decrypt data with password (auto-detects v1 and v2 payloads)
     * @param {Uint8Array} encryptedData - v1: salt + iv + data; v2: 'BKV2' + salt + iv + data
     * @param {string} password - Decryption password
     * @returns {Promise<Uint8Array>} Decrypted data (without header)
     * @throws {Error} If password is incorrect or data is corrupted
     */
    async decrypt(encryptedData, password) {
        const { version, iterations, offset } = this.detectVersion(encryptedData);
        if (version === 3) {
            // v3 blobs are not self-decrypting — H must come from /release.
            throw new Error('This share requires server key release (use decryptV3)');
        }

        // Extract components
        const salt = encryptedData.slice(offset, offset + 16);
        const iv = encryptedData.slice(offset + 16, offset + 28);
        const encrypted = encryptedData.slice(offset + 28);

        const key = await this.deriveKey(password, salt, iterations);

        // Decrypt
        const decrypted = await window.crypto.subtle.decrypt(
            { name: 'AES-GCM', iv },
            key,
            encrypted
        );

        const decryptedBytes = new Uint8Array(decrypted);

        // Validate header
        const isValid = this.validateHeader(decryptedBytes);
        if (!isValid) {
            throw new Error('Invalid password or corrupted data');
        }

        // Return data without header
        return decryptedBytes.slice(this.HEADER.length);
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
