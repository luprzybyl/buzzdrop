/**
 * CryptoService - Client-side encryption/decryption for Buzzdrop
 *
 * Provides AES-GCM encryption with PBKDF2 key derivation.
 * All encryption happens in the browser before upload.
 *
 * Wire format (outer envelope, unencrypted):
 *   v2: 'BKV2' (4 bytes) || salt (16 bytes) || iv (12 bytes) || AES-GCM ciphertext
 *       PBKDF2-SHA256, 600,000 iterations
 *   v1 (legacy): salt (16 bytes) || iv (12 bytes) || AES-GCM ciphertext
 *       PBKDF2-SHA256, 100,000 iterations
 *
 * The version marker lives outside the encrypted data so the iteration count
 * is known before key derivation. v1 blobs are identified by the ABSENCE of
 * the 'BKV2' magic; a v1 salt colliding with the magic has probability 2^-32
 * per blob — negligible, and the worst case is a failed GCM auth tag reported
 * as a wrong password.
 *
 * The plaintext itself starts with the magic header 'BKP-FILE' (inside the
 * ciphertext) for integrity validation.
 */

export class CryptoService {
    constructor() {
        this.encoder = new TextEncoder();
        this.decoder = new TextDecoder();
        // KDF iteration counts per payload version.
        this.ITERATIONS_V1 = 100000;
        this.ITERATIONS_V2 = 600000;
        // Outer envelope magic marking v2 payloads ('BKV2').
        this.ENVELOPE_MAGIC_V2 = this.encoder.encode('BKV2');
        // Inner plaintext magic, prepended before encryption.
        this.HEADER = this.encoder.encode('BKP-FILE');
        this.SALT_LENGTH = 16;
        this.IV_LENGTH = 12;
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
     * Detect the payload format version and locate the v1-style body
     * (salt || iv || ciphertext) within the blob.
     * @param {Uint8Array} encryptedData - Encrypted payload
     * @returns {{version: number, iterations: number, offset: number}}
     */
    detectVersion(encryptedData) {
        const magic = this.ENVELOPE_MAGIC_V2;
        if (encryptedData.length >= magic.length + this.SALT_LENGTH + this.IV_LENGTH) {
            let isV2 = true;
            for (let i = 0; i < magic.length; i++) {
                if (encryptedData[i] !== magic[i]) {
                    isV2 = false;
                    break;
                }
            }
            if (isV2) {
                return {
                    version: 2,
                    iterations: this.ITERATIONS_V2,
                    offset: magic.length,
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
        const { iterations, offset } = this.detectVersion(encryptedData);

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
