import assert from 'node:assert/strict';
import test from 'node:test';
import { bytesToHex, hexToBytes } from '../../static/js/lib/hex.js';

test('hex helpers round-trip and reject malformed input', () => {
    const bytes = hexToBytes('00ff10');
    assert.deepEqual([...bytes], [0, 255, 16]);
    assert.equal(bytesToHex(bytes), '00ff10');
    assert.throws(() => hexToBytes('xyz'));
    assert.throws(() => hexToBytes('abc'));
});
