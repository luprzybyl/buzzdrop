import assert from 'node:assert/strict';
import test from 'node:test';
import { open, receiptHash, seal } from '../../static/js/lib/crypto.js';
import { bytesToHex, hexToBytes } from '../../static/js/lib/hex.js';

const encoder = new TextEncoder();

// Deterministic fixtures, byte-identical to tests/unit/test_cli_crypto.py:
// salt = 0x00..0x0f, iv = 0x10..0x1b, h = 0x20..0x3f, receipt = 0x40..0x5f,
// password 'fixture-password-123', plaintext payload = 'fixture-data'
// (prefixed with 'BKP-FILE' ‖ receipt inside ct).
const FIXTURE_PASSWORD = 'fixture-password-123';
const FIXTURE_DATA = encoder.encode('fixture-data');
const V3_FIXTURE = Uint8Array.from(
    Buffer.from(
        '424b5633' +
        '000102030405060708090a0b0c0d0e0f' +
        '101112131415161718191a1b' +
        '9d9e3a85dc0667cf2d932f2ff111e26d53863a05b353260ca7f44e971372b9' +
        '1bc0238a04ef05c5b1e79f2b61b3a603b53c45ea318ba552f5d223fffcaa' +
        'e506cbea569cd3',
        'hex',
    ),
);
const V3_FIXTURE_H = hexToBytes(
    '202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f');
const V3_FIXTURE_V =
    '0ec3a6fe37dd4e652583c3dcde17bad20e019cbbf47d8f281bbf3f028ab482db';
const V3_FIXTURE_RECEIPT = hexToBytes(
    '404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f');

const randomShare = () => crypto.getRandomValues(new Uint8Array(32));

test('seal produces a BKV3 envelope with a verifier and a receipt', async () => {
    const { blob, verifier, receipt } = await seal(encoder.encode('secret'), 'pw', randomShare());
    assert.deepEqual([...blob.slice(0, 4)], [...encoder.encode('BKV3')]);
    assert.equal(verifier.length, 32);
    assert.equal(receipt.length, 32);
});

test('a sealed share opens with its password and the server share', async () => {
    const h = randomShare();
    const data = encoder.encode('key-release payload \x00\x01');
    const sealed = await seal(data, 'pw', h);

    const attempt = await open(sealed.blob).unlock('pw');
    assert.deepEqual(attempt.verifier, sealed.verifier);
    const opened = await attempt.finish(h);
    assert.deepEqual(opened.data, data);
    assert.deepEqual(opened.receipt, sealed.receipt);
});

test('unlocking derives the master key once per attempt', async () => {
    const h = randomShare();
    const { blob } = await seal(encoder.encode('x'), 'pw', h);
    const deriveBits = crypto.subtle.deriveBits;
    let pbkdf2 = 0;
    crypto.subtle.deriveBits = function (algorithm, ...rest) {
        if (/** @type {Algorithm} */ (algorithm).name === 'PBKDF2') pbkdf2 += 1;
        return deriveBits.call(this, algorithm, ...rest);
    };
    try {
        const attempt = await open(blob).unlock('pw');
        await attempt.finish(h);
    } finally {
        crypto.subtle.deriveBits = deriveBits;
    }
    assert.equal(pbkdf2, 1);
});

test('receiptHash is the hex SHA-256 of the receipt', async () => {
    const { receipt } = await seal(encoder.encode('x'), 'pw', randomShare());
    const expected = bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', receipt)));
    assert.equal(await receiptHash(receipt), expected);
});

test('seal and finish reject a malformed server share', async () => {
    const h = randomShare();
    const { blob } = await seal(encoder.encode('x'), 'pw', h);
    await assert.rejects(seal(encoder.encode('x'), 'pw', h.slice(0, 8)));
    const attempt = await open(blob).unlock('pw');
    await assert.rejects(attempt.finish(h.slice(0, 8)));
    // @ts-expect-error -- a non-bytes H must be rejected by the runtime guard
    await assert.rejects(attempt.finish('not-bytes'));
});

test('python-generated v3 fixture opens in JS', async () => {
    const attempt = await open(V3_FIXTURE).unlock(FIXTURE_PASSWORD);
    assert.equal(bytesToHex(attempt.verifier), V3_FIXTURE_V);
    const { data, receipt } = await attempt.finish(V3_FIXTURE_H);
    assert.deepEqual(data, FIXTURE_DATA);
    assert.deepEqual(receipt, V3_FIXTURE_RECEIPT);
});

test('a share cannot open without the server share or the password', async () => {
    const h = randomShare();
    const { blob } = await seal(encoder.encode('x'), 'pw', h);
    // Wrong H fails the GCM tag...
    await assert.rejects((await open(blob).unlock('pw')).finish(randomShare()));
    // ...and a wrong password fails even with the right H.
    await assert.rejects((await open(blob).unlock('wrong')).finish(h));
});

test('non-BKV3 payloads are rejected outright', async () => {
    const { blob } = await seal(encoder.encode('x'), 'pw', randomShare());
    const bkv2 = new Uint8Array(blob);
    bkv2[3] = '2'.charCodeAt(0); // 'BKV2'
    assert.throws(() => open(bkv2), /Unsupported share format/);
    assert.throws(() => open(crypto.getRandomValues(new Uint8Array(64))), /Unsupported share format/);
    assert.throws(() => open(new Uint8Array(4)), /Unsupported/);
    // below the BKV3 minimum (magic + salt + iv + GCM tag + header + receipt)
    assert.throws(() => open(new Uint8Array(87)), /Unsupported/);
});
