import assert from 'node:assert/strict';
import test from 'node:test';
import { buildOneClickLink, readFragmentPassword } from '../../static/js/lib/one-click-link.js';

test('reads no password from an empty or bare fragment', () => {
    assert.equal(readFragmentPassword(''), null);
    assert.equal(readFragmentPassword('#'), null);
});

test('reads a plain password from the fragment', () => {
    assert.equal(readFragmentPassword('#abc'), 'abc');
});

test('percent-decodes the fragment', () => {
    assert.equal(readFragmentPassword('#%E2%9C%93'), '✓');
    assert.equal(readFragmentPassword('#a%20b'), 'a b');
});

test('reads no password from a malformed fragment', () => {
    assert.equal(readFragmentPassword('#%ZZ'), null);
});

test('appends the encoded password as the link fragment', () => {
    assert.equal(
        buildOneClickLink('https://example.test/view/123', 'a b#✓'),
        'https://example.test/view/123#a%20b%23%E2%9C%93',
    );
});

test('replaces a fragment the link already carries', () => {
    assert.equal(
        buildOneClickLink('https://example.test/view/123#old', 'new'),
        'https://example.test/view/123#new',
    );
});

test('round-trips any password through the link fragment', () => {
    for (const password of ['abc', 'a b', '✓ zażółć', '#%&?=/+', 'correct-horse-battery-staple']) {
        const link = buildOneClickLink('https://example.test/view/123', password);
        assert.equal(readFragmentPassword(new URL(link).hash), password);
    }
});
