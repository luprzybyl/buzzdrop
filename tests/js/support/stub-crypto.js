// A stand-in for lib/crypto.js in the DOM layer (docs/frontend-test-strategy.md
// §7a). The real one runs 600k-iteration PBKDF2 on every attempt, and
// what the page shows for each outcome doesn't depend on it. This one is cheap
// but still honest enough for the protocol fake to check: the verifier is a
// hash of the password, so a wrong password is wrong to the server too, and
// the receipt in a share hashes to the receipt_hash it was uploaded with.
import { bytesToHex } from '../../../static/js/lib/hex.js';

/** @typedef {import('../../../static/js/lib/crypto.js').Bytes} Bytes */

const MAGIC = new TextEncoder().encode('STUB');
const RECEIPT = new Uint8Array(32).fill(7);

/**
 * @param {string | Bytes} input
 * @returns {Promise<Bytes>}
 */
async function sha256(input) {
    const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
    return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

/**
 * @typedef {object} StubCryptoOptions
 * @property {boolean} [unsupportedFormat] - every share fails to parse, as one in a format the page doesn't know
 * @property {boolean} [corrupted] - decryption fails without a message, as for a damaged share
 */

/**
 * @param {StubCryptoOptions} [options]
 * @returns {import('../../../static/js/lib/crypto.js').ShareCrypto}
 */
export function makeStubCrypto({ unsupportedFormat = false, corrupted = false } = {}) {
    return {
        async seal(data, password) {
            const blob = new Uint8Array(MAGIC.length + data.length);
            blob.set(MAGIC);
            blob.set(data, MAGIC.length);
            return { blob, verifier: await sha256(password), receipt: RECEIPT };
        },
        async receiptHash(receipt) {
            return bytesToHex(await sha256(receipt));
        },
        open(blob) {
            const magic = new TextDecoder().decode(blob.slice(0, MAGIC.length));
            if (unsupportedFormat || magic !== 'STUB') throw new Error('Unsupported share format');
            return {
                async unlock(password) {
                    return {
                        verifier: await sha256(password),
                        async finish() {
                            if (corrupted) throw new Error('');
                            return { data: blob.slice(MAGIC.length), receipt: RECEIPT };
                        },
                    };
                },
            };
        },
    };
}
