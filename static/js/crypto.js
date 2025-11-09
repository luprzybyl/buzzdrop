/**
 * CryptoService - Client-side encryption/decryption for Buzzdrop
 * 
 * Provides AES-GCM encryption with PBKDF2 key derivation.
 * All encryption happens in the browser before upload.
 */

export class CryptoService {
    constructor() {
        this.encoder = new TextEncoder();
        this.decoder = new TextDecoder();
        this.ITERATIONS = 100000;
        this.HEADER = this.encoder.encode('BKP-FILE');
    }

    /**
     * Generate random salt (16 bytes)
     * @returns {Uint8Array} Random salt
     */
    generateSalt() {
        return window.crypto.getRandomValues(new Uint8Array(16));
    }

    /**
     * Generate random IV (12 bytes)
     * @returns {Uint8Array} Random initialization vector
     */
    generateIV() {
        return window.crypto.getRandomValues(new Uint8Array(12));
    }

    /**
     * Derive encryption key from password using PBKDF2
     * @param {string} password - Password to derive key from
     * @param {Uint8Array} salt - Salt for key derivation
     * @returns {Promise<CryptoKey>} Derived encryption key
     */
    async deriveKey(password, salt) {
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
                iterations: this.ITERATIONS,
                hash: 'SHA-256'
            },
            keyMaterial,
            { name: 'AES-GCM', length: 256 },
            true,
            ['encrypt', 'decrypt']
        );
    }

    /**
     * Encrypt data with password
     * @param {Uint8Array} data - Raw data to encrypt
     * @param {string} password - Encryption password
     * @returns {Promise<Uint8Array>} salt + iv + encrypted data
     */
    async encrypt(data, password) {
        const salt = this.generateSalt();
        const iv = this.generateIV();
        const key = await this.deriveKey(password, salt);

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

        // Concatenate salt + iv + encrypted data
        const result = new Uint8Array(
            salt.length + iv.length + encrypted.byteLength
        );
        result.set(salt);
        result.set(iv, salt.length);
        result.set(new Uint8Array(encrypted), salt.length + iv.length);

        return result;
    }

    /**
     * Decrypt data with password
     * @param {Uint8Array} encryptedData - salt + iv + encrypted data
     * @param {string} password - Decryption password
     * @returns {Promise<Uint8Array>} Decrypted data (without header)
     * @throws {Error} If password is incorrect or data is corrupted
     */
    async decrypt(encryptedData, password) {
        // Extract components
        const salt = encryptedData.slice(0, 16);
        const iv = encryptedData.slice(16, 28);
        const encrypted = encryptedData.slice(28);

        const key = await this.deriveKey(password, salt);

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
