import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';

// Paths, not URLs: under the happy-dom environment the global URL is happy-dom's.
const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'html');

// Loads a rendered template fixture (tests/js/fixtures/html/<name>.html) into a
// fresh happy-dom window, so listeners and state from one test can't leak into
// the next. `settings` are happy-dom browser settings, e.g.
// { device: { prefersReducedMotion: 'reduce' } }.
export function loadFixture(name, settings = {}) {
    const window = new Window({ url: 'http://localhost/', settings });
    window.document.write(readFileSync(join(FIXTURE_DIR, `${name}.html`), 'utf8'));
    return window;
}
