// Password/passphrase generation and strength assessment for the composer.
//
// There is deliberately no server-side check: encryption happens in this
// browser, so the server never sees the password and cannot enforce a
// policy. The gate below is therefore the ONLY control protecting the
// drop from a weak key — it runs before upload and blocks weak input.
//
// zxcvbn is not in the dependency tree, so strength is estimated with a
// transparent heuristic instead:
//   * blocklist of the most common passwords (leet-normalized) → 0 credit
//   * passphrases made of EFF-list words get exact dice math:
//         words * log2(7776)
//   * everything else gets length * log2(character pool), capped hard for
//     repetitive or sequential input ("abcabcabc", "qwerty", "aaaa...").
// It underestimates, never overestimates — the order matters for a gate.

import { EFF_WORDLIST } from './eff-wordlist.js';

const WORD_SET = new Set(EFF_WORDLIST);
const BITS_PER_WORD = Math.log2(EFF_WORDLIST.length); // ~12.92

export const PASSPHRASE_WORDS = 6;

// Below this the upload is refused. 45 bits is roughly "8 mixed random
// characters" — anything worse is brute-forceable against PBKDF2-600k.
export const MIN_ENTROPY_BITS = 45;
// At/above this the meter reports "strong" (a 6-word EFF phrase is ~77.5).
export const STRONG_ENTROPY_BITS = 75;

// The usual suspects, plus a few topical ones. Compared against the
// lowercase, leet-normalized password and its digit/punct-stripped core.
const COMMON_PASSWORDS = new Set([
    'password', 'passw0rd', 'p4ssword', 'p4ssw0rd', 'passwd', 'pw',
    '123456', '1234567', '12345678', '123456789', '1234567890', '12345',
    '111111', '000000', '123123', '654321', '987654321', '112233',
    'qwerty', 'qwertyuiop', 'qwerty123', 'asdfgh', 'zxcvbn', '1q2w3e',
    '1qaz2wsx', 'qazwsx', 'q1w2e3r4', 'letmein', 'iloveyou', 'welcome',
    'admin', 'administrator', 'login', 'master', 'monkey', 'dragon',
    'football', 'baseball', 'soccer', 'hockey', 'basketball', 'superman',
    'batman', 'starwars', 'shadow', 'sunshine', 'princess', 'michael',
    'ninja', 'mustang', 'charlie', 'jordan', 'hunter', 'buster',
    'trustno1', 'whatever', 'freedom', 'secret', 'pass', 'test',
    'abc123', 'abcd1234', 'aaaaaa', 'lovely', 'donald', 'solo',
    'buzzdrop', 'buzz', 'onedrive', 'dropbox',
]);

/**
 * Map the classic substitutions back to letters so "P4ssw0rd!" still
 * hits the blocklist instead of slipping through on a technicality.
 * @type {Record<string, string>}
 */
const LEET_MAP = {
    '0': 'o', '1': 'l', '3': 'e', '4': 'a', '5': 's', '7': 't',
    '8': 'b', '@': 'a', '$': 's', '!': 'i', '€': 'e', '£': 'l',
};

const KEYBOARD_ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm', '0123456789'];

/**
 * @param {string} password
 * @returns {string}
 */
function normalizeLeet(password) {
    return password
        .toLowerCase()
        .split('')
        .map((ch) => LEET_MAP[ch] || ch)
        .join('');
}

/**
 * @param {string} password
 * @returns {number}
 */
function characterPoolSize(password) {
    let pool = 0;
    if (/[a-z]/.test(password)) pool += 26;
    if (/[A-Z]/.test(password)) pool += 26;
    if (/[0-9]/.test(password)) pool += 10;
    if (/[^a-zA-Z0-9\s]/.test(password)) pool += 33;
    if (/[^\x00-\x7F]/.test(password)) pool += 100;
    return pool || 1;
}

/**
 * True if the password is one short token repeated to fill space —
 * "abcabcabc", "xyxyxyxy", "!!!!". Work factor is the seed, not the length.
 * @param {string} password
 * @returns {boolean}
 */
function isRepetition(password) {
    for (let period = 1; period <= Math.floor(password.length / 2); period++) {
        if (password.length % period !== 0) continue;
        const unit = password.slice(0, period);
        if (unit.repeat(password.length / period) === password) {
            return true;
        }
    }
    return false;
}

/**
 * Fraction of adjacent character pairs that walk a keyboard row or the
 * alphabet/digits by ±1. "qwerty", "abcd", "13579" score high.
 * @param {string} password
 * @returns {number}
 */
function sequentialFraction(password) {
    if (password.length < 2) return 0;
    const lower = password.toLowerCase();
    let sequential = 0;
    for (let i = 1; i < lower.length; i++) {
        const a = lower[i - 1];
        const b = lower[i];
        if (Math.abs(a.charCodeAt(0) - b.charCodeAt(0)) === 1) {
            sequential++;
            continue;
        }
        for (const row of KEYBOARD_ROWS) {
            const ai = row.indexOf(a);
            const bi = row.indexOf(b);
            if (ai !== -1 && Math.abs(ai - bi) === 1) {
                sequential++;
                break;
            }
        }
    }
    return sequential / (lower.length - 1);
}

/**
 * @param {string} password
 * @returns {number}
 */
function isEffPassphrase(password) {
    const raw = password
        .toLowerCase()
        .split(/[\s\-_.+~|,;:]+/)
        .filter(Boolean);
    // Four EFF words contain a hyphen themselves ('yo-yo', 't-shirt',
    // 'drop-down', 'felt-tip'), so re-merge adjacent fragments when the
    // joined form is a real word before scoring.
    const tokens = [];
    for (let i = 0; i < raw.length; i++) {
        if (i + 1 < raw.length && WORD_SET.has(`${raw[i]}-${raw[i + 1]}`)) {
            tokens.push(`${raw[i]}-${raw[i + 1]}`);
            i++;
        } else {
            tokens.push(raw[i]);
        }
    }
    if (tokens.length < 4 || tokens.length > 12) return 0;
    if (!tokens.every((t) => WORD_SET.has(t))) return 0;
    return tokens.length;
}

/**
 * Estimate password strength.
 * @param {string} password
 * @returns {{bits: number, level: 'empty'|'weak'|'fair'|'strong',
 *            blocked: boolean, message: string}}
 */
export function assessPassword(password) {
    if (!password) {
        return { bits: 0, level: 'empty', blocked: false, message: '' };
    }

    // Blocklist: leet-normalized, and the same with trailing digits/punct
    // stripped BEFORE normalization ("!" would otherwise become "i"), so
    // "password1!" and "P4ssw0rd!" are still just "password".
    const lowered = password.toLowerCase();
    const stripped = lowered.replace(/[\d\W_]+$/g, '');
    const candidates = [normalizeLeet(lowered), normalizeLeet(stripped)];
    if (candidates.some((c) => COMMON_PASSWORDS.has(c))) {
        return {
            bits: 10,
            level: 'weak',
            blocked: true,
            message: 'That password is on every cracker list ever published.',
        };
    }

    // Exact dice math when every token is an EFF word — this is the case
    // the Generate button produces.
    const wordCount = isEffPassphrase(password);
    if (wordCount > 0) {
        const bits = wordCount * BITS_PER_WORD;
        const level = bits >= STRONG_ENTROPY_BITS ? 'strong' : 'fair';
        return {
            bits,
            level,
            blocked: false,
            message: `~${Math.round(bits)} bits — ${wordCount}-word passphrase.`,
        };
    }

    const pool = characterPoolSize(password);
    let bits = password.length * Math.log2(pool);

    // Structural penalties: patterns make the effective pool tiny no
    // matter how long the string is.
    if (isRepetition(password) || new Set(password).size < 4) {
        bits = Math.min(bits, 20);
    }
    if (sequentialFraction(password) > 0.6) {
        // "abcd...z" and friends: entropy is really just (start, length).
        bits = Math.min(bits, 30);
    }
    // "word + year" tail adds far less than the raw math suggests.
    if (/\d{2,4}$/.test(password) && /[a-zA-Z]/.test(password.slice(0, -2))) {
        bits -= 8;
    }
    // Composition rules buy little; a single-class password is cheap.
    if (password.length < 12 && pool <= 36) {
        bits = Math.min(bits, password.length * Math.log2(pool) * 0.8);
    }
    bits = Math.max(0, bits);

    if (bits < MIN_ENTROPY_BITS) {
        return {
            bits,
            level: 'weak',
            blocked: true,
            message: `Too weak (~${Math.round(bits)} bits). Use Generate or a longer passphrase.`,
        };
    }
    if (bits < STRONG_ENTROPY_BITS) {
        return {
            bits,
            level: 'fair',
            blocked: false,
            message: `Acceptable (~${Math.round(bits)} bits) — a generated 6-word passphrase is stronger.`,
        };
    }
    return {
        bits,
        level: 'strong',
        blocked: false,
        message: `Strong (~${Math.round(bits)} bits).`,
    };
}

/**
 * Return a `wordCount`-word passphrase from the EFF large wordlist using
 * crypto.getRandomValues. Rejection sampling keeps the index uniform —
 * a plain `% 7776` would slightly favour the first words.
 * @param {number} [wordCount]
 * @returns {string}
 */
export function generatePassphrase(wordCount = PASSPHRASE_WORDS) {
    const limit = Math.floor(0x100000000 / EFF_WORDLIST.length) * EFF_WORDLIST.length;
    const buffer = new Uint32Array(1);
    const words = [];
    while (words.length < wordCount) {
        globalThis.crypto.getRandomValues(buffer);
        if (buffer[0] < limit) {
            words.push(EFF_WORDLIST[buffer[0] % EFF_WORDLIST.length]);
        }
    }
    return words.join('-');
}
