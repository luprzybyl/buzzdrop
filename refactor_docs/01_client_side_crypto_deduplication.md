# Client-Side Encryption Code Deduplication

**Priority**: Low  
**Estimated Effort**: 3-4 hours  
**Status**: Proposal

## Current Issue

Encryption workflow is duplicated in `static/js/main.js` for both file uploads and text note uploads. Approximately 100 lines of code are repeated with identical logic:

- PBKDF2 key derivation (100k iterations)
- AES-GCM encryption
- Salt and IV generation
- Header prepending (`BKP-FILE`)
- Data concatenation (salt + iv + encrypted)

## Proposal

Create a shared encryption module that both file and text upload can use.

### Implementation

```javascript
// static/js/crypto.js
export class CryptoService {
    constructor() {
        this.encoder = new TextEncoder();
        this.ITERATIONS = 100000;
        this.HEADER = this.encoder.encode('BKP-FILE');
    }

    /**
     * Generate random salt (16 bytes)
     */
    generateSalt() {
        return window.crypto.getRandomValues(new Uint8Array(16));
    }

    /**
     * Generate random IV (12 bytes)
     */
    generateIV() {
        return window.crypto.getRandomValues(new Uint8Array(12));
    }

    /**
     * Derive encryption key from password using PBKDF2
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
     * @returns {Uint8Array} - salt + iv + encrypted data
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
     * @returns {Uint8Array} - Decrypted data (without header)
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
     * Validate magic header
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
```

### Usage in main.js

```javascript
// static/js/main.js
import { CryptoService } from './crypto.js';

const crypto = new CryptoService();

// File upload
document.querySelector('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const file = fileInput.files[0];
    const password = passInput.value;
    
    const fileData = new Uint8Array(await file.arrayBuffer());
    const encrypted = await crypto.encrypt(fileData, password);
    
    // Upload encrypted data
    const encBlob = new Blob([encrypted], { type: 'application/octet-stream' });
    // ... rest of upload logic
});

// Text note upload
async function uploadNote() {
    const noteText = document.getElementById('note-text').value;
    const password = document.getElementById('note-password').value;
    
    const textData = new TextEncoder().encode(noteText);
    const encrypted = await crypto.encrypt(textData, password);
    
    // Upload encrypted data
    const base64Encrypted = btoa(String.fromCharCode(...encrypted));
    // ... rest of upload logic
}
```

### Usage in view.js

```javascript
// static/js/view.js
import { CryptoService } from './crypto.js';

const crypto = new CryptoService();

// Download and decrypt
const res = await fetch(window.downloadUrl);
const encryptedData = new Uint8Array(await res.arrayBuffer());

decryptBtn.addEventListener('click', async () => {
    try {
        const decrypted = await crypto.decrypt(encryptedData, password);
        
        if (window.fileType === 'text') {
            const text = new TextDecoder().decode(decrypted);
            // Display text
        } else {
            // Trigger file download
            const blob = new Blob([decrypted]);
            // ... download logic
        }
    } catch (err) {
        // Show error message
    }
});
```

## Benefits

1. **DRY Principle**: Eliminates ~100 lines of duplicated code
2. **Consistency**: Same encryption logic for all file types
3. **Maintainability**: Single place to update crypto parameters
4. **Testability**: Can unit test encryption module in isolation
5. **Future-proofing**: Easy to upgrade to newer crypto algorithms

## Migration Steps

1. Create `static/js/crypto.js` with `CryptoService` class
2. Update `main.js` to import and use `CryptoService`
3. Update `view.js` to import and use `CryptoService`
4. Test file uploads and text notes
5. Remove old duplicated encryption code

## Testing Checklist

- [ ] File encryption/decryption works
- [ ] Text note encryption/decryption works
- [ ] Error handling for incorrect passwords
- [ ] Large file handling (100MB+)
- [ ] Browser compatibility (Chrome, Firefox, Safari)

## Browser Compatibility

- Requires ES6 modules support
- All modern browsers support Web Crypto API
- For older browsers, can use bundler (webpack/rollup)

## Notes

- Consider adding progress callbacks for large files
- Could extract constants (ITERATIONS, HEADER) to config
- May want to add version header for future crypto upgrades
