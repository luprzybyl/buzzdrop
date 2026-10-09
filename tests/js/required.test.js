import assert from 'node:assert/strict';
import test from 'node:test';
import { Window } from 'happy-dom';
import { required, requiredClosest, requiredWindow } from '../../static/js/lib/required.js';
import { browserView } from './support/dom-fixture.js';

const page = () => {
    const window = browserView(new Window());
    window.document.body.innerHTML = `
        <div class="card">
            <div class="field"><input id="name"><button class="copy">Copy</button></div>
        </div>`;
    return window;
};

test('required returns the element the selector matches', () => {
    const { document } = page();

    assert.equal(required(document, '#name', 'input'), document.getElementById('name'));
});

test('required throws, naming the selector, when nothing matches', () => {
    const { document } = page();

    assert.throws(() => required(document, '#missing', 'input'), /<input> #missing/);
});

test('required throws when the match is not the promised element', () => {
    const { document } = page();

    assert.throws(() => required(document, '.copy', 'input'), /<input> \.copy/);
});

test('requiredClosest returns the matching ancestor', () => {
    const { document } = page();
    const button = required(document, '.copy', 'button');

    assert.equal(requiredClosest(button, '.card', 'div'), document.querySelector('.card'));
});

test('requiredClosest throws when no ancestor matches', () => {
    const { document } = page();
    const button = required(document, '.copy', 'button');

    assert.throws(() => requiredClosest(button, '.missing', 'div'), /<div> \.missing/);
});

test('requiredWindow returns the window a document belongs to', () => {
    const window = page();

    assert.equal(requiredWindow(window.document), window);
});

test('requiredWindow throws for a document without a window', () => {
    const { document } = page();
    const detached = document.implementation.createHTMLDocument('');

    assert.throws(() => requiredWindow(detached), /window/);
});
