import assert from 'node:assert/strict';
import test from 'node:test';

test('deliberately failing test to verify required checks (#183)', () => {
    assert.equal(1 + 1, 3);
});
