import assert from 'node:assert/strict';
import test from 'node:test';

// Deliberately failing: checks that a red js-fast blocks merging into main (#183). Do not merge.
test('required checks canary fails on purpose', () => {
  assert.equal(1, 2);
});
