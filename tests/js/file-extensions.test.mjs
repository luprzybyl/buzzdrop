import assert from 'node:assert/strict';
import test from 'node:test';
import { isAllowedFile } from '../../static/js/file-extensions.mjs';

const allowed = ['pdf', 'gz', 'jpg', 'bashrc', 'readme'];

test('allows a file whose extension is on the list', () => {
    assert.equal(isAllowedFile('report.pdf', allowed), true);
});

test('refuses a file whose extension is not on the list', () => {
    assert.equal(isAllowedFile('setup.exe', allowed), false);
});

test('matches the extension case-insensitively', () => {
    assert.equal(isAllowedFile('PHOTO.JPG', allowed), true);
});

test('checks only the last extension of a double extension', () => {
    assert.equal(isAllowedFile('backup.tar.gz', allowed), true);
    assert.equal(isAllowedFile('invoice.pdf.exe', allowed), false);
});

test('treats a name without a dot as its own extension', () => {
    // Pins current behaviour: README → "readme".
    assert.equal(isAllowedFile('README', allowed), true);
    assert.equal(isAllowedFile('Makefile', allowed), false);
});

test('treats the part after the leading dot of a dotfile as the extension', () => {
    assert.equal(isAllowedFile('.bashrc', allowed), true);
});

test('refuses a name with a trailing dot', () => {
    assert.equal(isAllowedFile('report.', allowed), false);
});
