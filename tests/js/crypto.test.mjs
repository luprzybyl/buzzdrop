import assert from 'node:assert/strict';
import test from 'node:test';

// crypto.js uses `window.crypto`; Node exposes Web Crypto on globalThis.
globalThis.window = globalThis;

const { CryptoService, bytesToHex, hexToBytes } = await import('../../static/js/crypto.js');

const service = new CryptoService();
const encoder = new TextEncoder();

// Deterministic fixtures, byte-identical to tests/unit/test_cli_crypto.py:
// salt = 0x00..0x0f, iv = 0x10..0x1b, h = 0x20..0x3f,
// password 'fixture-password-123', plaintext payload = 'fixture-data'
// (prefixed with 'BKP-FILE' inside ct).
const FIXTURE_PASSWORD = 'fixture-password-123';
const FIXTURE_DATA = encoder.encode('fixture-data');
const V3_FIXTURE = Uint8Array.from(
    Buffer.from(
        '424b5633' +
        '000102030405060708090a0b0c0d0e0f' +
        '101112131415161718191a1b' +
        '9d9e3a85dc0667cf0bbb1518c026c1077fae042f4b6eb1a5a413d9fc50b9b4d6cbdf69ba',
        'hex',
    ),
);
const V3_FIXTURE_H = hexToBytes(
    '202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f');
const V3_FIXTURE_V =
    '0ec3a6fe37dd4e652583c3dcde17bad20e019cbbf47d8f281bbf3f028ab482db';

test('encrypt produces a BKV3 envelope parsed as version 3', async () => {
    const h = crypto.getRandomValues(new Uint8Array(32));
    const { blob, verifier } = await service.encrypt(
        encoder.encode('secret'), 'pw', h);
    assert.deepEqual([...blob.slice(0, 4)], [...encoder.encode('BKV3')]);
    assert.equal(service.parseBlob(blob).version, 3);
    assert.equal(verifier.length, 32);
});

test('encrypt/decrypt round-trips through the server share', async () => {
    const h = crypto.getRandomValues(new Uint8Array(32));
    const data = encoder.encode('oracle payload \x00\x01');
    const { blob } = await service.encrypt(data, 'pw', h);
    const decrypted = await service.decrypt(blob, 'pw', h);
    assert.deepEqual(decrypted, data);
});

test('python-generated v3 fixture decrypts in JS', async () => {
    const decrypted = await service.decrypt(
        V3_FIXTURE, FIXTURE_PASSWORD, V3_FIXTURE_H);
    assert.deepEqual(decrypted, FIXTURE_DATA);
});

test('verifier derivation matches the python fixture', async () => {
    const salt = V3_FIXTURE.slice(4, 20);
    const v = await service.deriveVerifier(FIXTURE_PASSWORD, salt);
    assert.equal(bytesToHex(v), V3_FIXTURE_V);
});

test('blob cannot decrypt without the server share', async () => {
    const h = crypto.getRandomValues(new Uint8Array(32));
    const { blob } = await service.encrypt(encoder.encode('x'), 'pw', h);
    // Wrong H fails the GCM tag...
    await assert.rejects(
        service.decrypt(blob, 'pw', crypto.getRandomValues(new Uint8Array(32))));
    // ...and a wrong password fails even with the right H.
    await assert.rejects(service.decrypt(blob, 'wrong', h));
});

test('non-BKV3 payloads are rejected outright', async () => {
    const h = crypto.getRandomValues(new Uint8Array(32));
    const { blob } = await service.encrypt(encoder.encode('x'), 'pw', h);
    const bkv2 = new Uint8Array(blob);
    bkv2[3] = '2'.charCodeAt(0); // 'BKV2'
    assert.throws(() => service.parseBlob(bkv2), /Unsupported share format/);
    assert.throws(
        () => service.parseBlob(crypto.getRandomValues(new Uint8Array(64))),
        /Unsupported share format/);
    assert.throws(() => service.parseBlob(new Uint8Array(4)), /Unsupported/);
});

test('hex helpers round-trip and reject malformed input', () => {
    const bytes = hexToBytes('00ff10');
    assert.deepEqual([...bytes], [0, 255, 16]);
    assert.equal(bytesToHex(bytes), '00ff10');
    assert.throws(() => hexToBytes('xyz'));
    assert.throws(() => hexToBytes('abc'));
});
