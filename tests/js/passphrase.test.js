import assert from 'node:assert/strict';
import test from 'node:test';

import { EFF_WORDLIST } from '../../static/js/eff-wordlist.js';
import {
    assessPassword,
    generatePassphrase,
    MIN_ENTROPY_BITS,
    STRONG_ENTROPY_BITS,
} from '../../static/js/passphrase.js';

const WORD_SET = new Set(EFF_WORDLIST);

test('wordlist is the full EFF large wordlist', () => {
    assert.equal(EFF_WORDLIST.length, 7776);
    assert.equal(WORD_SET.size, 7776);
});

test('generated passphrase has 6 EFF words by default', () => {
    const phrase = generatePassphrase();
    const parts = phrase.split('-');
    assert.equal(parts.length, 6);
    for (const part of parts) {
        assert.ok(WORD_SET.has(part), `${part} not in wordlist`);
    }
});

test('generated passphrases are strong and not blocked', () => {
    for (let i = 0; i < 10; i++) {
        const result = assessPassword(generatePassphrase());
        assert.equal(result.level, 'strong');
        assert.equal(result.blocked, false);
        assert.ok(result.bits >= STRONG_ENTROPY_BITS);
    }
});

test('generation is not deterministic', () => {
    const phrases = new Set(Array.from({ length: 20 }, () => generatePassphrase()));
    assert.ok(phrases.size > 1);
});

test('common passwords are blocked, including leet variants', () => {
    for (const pw of ['password', 'P4ssw0rd!', 'qwerty123', 'letmein2024', 'buzzdrop']) {
        const result = assessPassword(pw);
        assert.equal(result.blocked, true, `${pw} should be blocked`);
        assert.equal(result.level, 'weak');
    }
});

test('short simple passwords are blocked', () => {
    for (const pw of ['hunter2', 'abcdefghi', 'aaaaaaaaaa', 'abcabcabcabc']) {
        assert.equal(assessPassword(pw).blocked, true, `${pw} should be blocked`);
    }
});

test('sequential input is capped', () => {
    const result = assessPassword('abcdefghijklmnopqrstuvwxyz');
    assert.ok(result.bits < MIN_ENTROPY_BITS);
    assert.equal(result.blocked, true);
});

test('long random-ish mixed password is acceptable', () => {
    const result = assessPassword('xk9#mQ2$vL7!pR4w');
    assert.equal(result.blocked, false);
    assert.ok(result.bits >= STRONG_ENTROPY_BITS);
});

test('typed EFF passphrase gets exact word-count credit', () => {
    const result = assessPassword('abacus-abdomen-abide-ability');
    // 4 * log2(7776) ≈ 51.7 bits -> fair, not blocked
    assert.equal(result.blocked, false);
    assert.ok(Math.abs(result.bits - 4 * Math.log2(7776)) < 0.01);
});

test('empty password is not blocked but reports empty', () => {
    const result = assessPassword('');
    assert.equal(result.level, 'empty');
    assert.equal(result.blocked, false);
});
