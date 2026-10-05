import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';

// Paths, not URLs: under the happy-dom environment the global URL is happy-dom's.
const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'html');

/**
 * Loads a rendered template fixture (tests/js/fixtures/html/<name>.html) into a
 * fresh happy-dom window, so listeners and state from one test can't leak into
 * the next. `settings` are happy-dom browser settings, e.g.
 * { device: { prefersReducedMotion: 'reduce' } }; `url` is the page's address,
 * for pages that read it (a password fragment, say).
 * @param {string} name
 * @param {import('happy-dom').IOptionalBrowserSettings} [settings]
 * @param {string} [url]
 * @returns {Window}
 */
export function loadFixture(name, settings = {}, url = 'http://localhost/') {
    const window = new Window({ url, settings });
    window.document.write(readFileSync(join(FIXTURE_DIR, `${name}.html`), 'utf8'));
    return window;
}

/**
 * The page modules are typed against the browser's DOM (lib.dom); happy-dom
 * implements that same DOM, but under its own class types, which TypeScript
 * can't relate to lib.dom's. This is the one place the two are bridged: tests
 * drive the page through the returned lib.dom view of the fixture's window.
 * @param {Window} window - a window from loadFixture
 * @returns {globalThis.Window & typeof globalThis}
 */
export function browserView(window) {
    return /** @type {globalThis.Window & typeof globalThis} */ (/** @type {unknown} */ (window));
}
