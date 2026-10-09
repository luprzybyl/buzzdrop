// Hex encoding for bytes that travel the wire as text: the server share H,
// the verifier V and the receipt hash.

/**
 * Bytes backed by a plain ArrayBuffer, which is what Web Crypto accepts.
 * Every array these modules create (`new Uint8Array(n)`, `slice()`,
 * `TextEncoder`) is one.
 * @typedef {Uint8Array<ArrayBuffer>} Bytes
 */

/**
 * Convert bytes to a lowercase hex string.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function bytesToHex(bytes) {
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Parse a hex string into bytes. Throws on malformed input.
 * @param {string} hex
 * @returns {Bytes}
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
