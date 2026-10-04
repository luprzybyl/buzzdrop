import assert from 'node:assert/strict';
import test from 'node:test';

// crypto.js uses `window.crypto`; Node exposes Web Crypto on globalThis.
globalThis.window = globalThis;

const { CryptoService } = await import('../../static/js/crypto.js');

const service = new CryptoService();
const encoder = new TextEncoder();

// Deterministic fixtures, byte-identical to tests/unit/test_cli_crypto.py:
// salt = 0x00..0x0f, iv = 0x10..0x1b, password 'fixture-password-123',
// plaintext payload = 'fixture-data' (prefixed with 'BKP-FILE' inside ct).
const FIXTURE_PASSWORD = 'fixture-password-123';
const FIXTURE_DATA = encoder.encode('fixture-data');
const V1_FIXTURE = Uint8Array.from(
    Buffer.from(
        '000102030405060708090a0b0c0d0e0f' +
        '101112131415161718191a1b' +
        'd56b4e5b1641d0eaeacce061df6849f4af753cdfd77c893e82c18731742215deb41d16c7',
        'hex',
    ),
);
const V2_FIXTURE = Uint8Array.from(
    Buffer.from(
        '424b5632' +
        '000102030405060708090a0b0c0d0e0f' +
        '101112131415161718191a1b' +
        'e3e9c2fdac1fb1a52e4bbc89c1ba01a137ea1936f57eec0d0ccf39fff550f508ee017e67',
        'hex',
    ),
);

async function manualDecrypt(blob, password, iterations, offset = 0) {
    const salt = blob.slice(offset, offset + 16);
    const iv = blob.slice(offset + 16, offset + 28);
    const ct = blob.slice(offset + 28);
    const keyMaterial = await crypto.subtle.importKey(
        'raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey'],
    );
    const key = await crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
        keyMaterial,
        { name: 'AES-GCM', length: 256 },
        true,
        ['encrypt', 'decrypt'],
    );
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct));
}

test('encrypt produces a v2 envelope with the BKV2 magic', async () => {
    const encrypted = await service.encrypt(encoder.encode('hello'), 'pw');
    assert.deepEqual([...encrypted.slice(0, 4)], [...encoder.encode('BKV2')]);
    assert.equal(service.detectVersion(encrypted).version, 2);
});

test('v2 encrypt/decrypt round-trips', async () => {
    const data = encoder.encode('roundtrip \x00\x01');
    const encrypted = await service.encrypt(data, 'some-password');
    const decrypted = await service.decrypt(encrypted, 'some-password');
    assert.deepEqual(decrypted, data);
});

test('v2 payload really uses 600k PBKDF2 iterations', async () => {
    const encrypted = await service.encrypt(encoder.encode('secret'), 'pw');
    // Legacy 100k derivation must fail the GCM tag...
    await assert.rejects(manualDecrypt(encrypted, 'pw', 100_000, 4));
    // ...while 600k succeeds.
    const plain = await manualDecrypt(encrypted, 'pw', 600_000, 4);
    assert.deepEqual(plain.slice(8), encoder.encode('secret'));
});

test('legacy v1 payload (no magic, 100k) still decrypts', async () => {
    assert.equal(service.detectVersion(V1_FIXTURE).version, 1);
    const decrypted = await service.decrypt(V1_FIXTURE, FIXTURE_PASSWORD);
    assert.deepEqual(decrypted, FIXTURE_DATA);
});

test('python-generated v2 fixture decrypts in JS', async () => {
    assert.equal(service.detectVersion(V2_FIXTURE).version, 2);
    const decrypted = await service.decrypt(V2_FIXTURE, FIXTURE_PASSWORD);
    assert.deepEqual(decrypted, FIXTURE_DATA);
});

test('wrong password rejects for both versions', async () => {
    const encrypted = await service.encrypt(encoder.encode('x'), 'right');
    await assert.rejects(service.decrypt(encrypted, 'wrong'));
    await assert.rejects(service.decrypt(V1_FIXTURE, 'wrong'));
    await assert.rejects(service.decrypt(V2_FIXTURE, 'wrong'));
});

test('random v1-style blob is detected as v1', () => {
    const blob = crypto.getRandomValues(new Uint8Array(64));
    blob[0] = 0xff; // ensure it does not accidentally start with 'B'
    assert.equal(service.detectVersion(blob).version, 1);
});
