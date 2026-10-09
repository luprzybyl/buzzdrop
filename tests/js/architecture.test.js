// The layer rules of static/js (static/js/CLAUDE.md), checked from the source:
//
//   lib/              may import lib/ only
//   features/<name>/  may import lib/ and its own folder
//   pages/<name>/     may import lib/, a feature's index.js and its own folder
//
// Only runtime imports count (`import … from`, `import '…'`, `export … from`),
// matched the way tests/integration/test_module_integrity.py matches them.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const JS_DIR = join(ROOT, 'static', 'js');
const TEMPLATES_DIR = join(ROOT, 'templates');

const STATIC_IMPORT = /^\s*(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]/gm;
const SIDE_EFFECT_IMPORT = /^\s*import\s*['"]([^'"]+)['"]/gm;
const TEMPLATE_SCRIPT = /filename='js\/([^']+\.js)'/g;

/**
 * Every .js file under static/js, as a path relative to it with `/` separators.
 * @returns {string[]}
 */
function modules() {
    return readdirSync(JS_DIR, { recursive: true, encoding: 'utf8' })
        .filter((path) => path.endsWith('.js'))
        .map((path) => path.split(sep).join('/'))
        .sort();
}

/**
 * The folders directly under `static/js/<layer>`.
 * @param {string} layer
 * @returns {string[]}
 */
function slices(layer) {
    const dir = join(JS_DIR, layer);
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((name) => statSync(join(dir, name)).isDirectory());
}

/**
 * Where a module sits: its layer and, under features/ and pages/, the slice
 * it belongs to. `null` for a file outside the three layers.
 * @typedef {{ layer: 'lib' } | { layer: 'features' | 'pages', name: string }} Place
 * @param {string} path - relative to static/js
 * @returns {Place | null}
 */
function placeOf(path) {
    const [layer, name, ...rest] = path.split('/');
    if (layer === 'lib' && name) return { layer };
    if ((layer === 'features' || layer === 'pages') && name && rest.length) return { layer, name };
    return null;
}

/**
 * The specifiers a module imports at runtime.
 * @param {string} source
 * @returns {string[]}
 */
function importsOf(source) {
    return [...source.matchAll(STATIC_IMPORT), ...source.matchAll(SIDE_EFFECT_IMPORT)].map((match) => match[1]);
}

/**
 * Why `from` may not import `to`, or null when it may.
 * @param {string} from - relative to static/js
 * @param {string} to - relative to static/js
 * @returns {string | null}
 */
function violation(from, to) {
    const source = /** @type {Place} */ (placeOf(from));
    const target = placeOf(to);
    if (!target) return 'imports may only reach lib/, features/ and pages/';
    if (target.layer === 'lib') return null;
    if (source.layer === 'lib') return 'lib/ may import lib/ only';
    if (source.layer === 'features') {
        if (target.layer === 'features' && target.name === source.name) return null;
        return 'a feature may import lib/ and its own folder only; features are composed in a page';
    }
    if (target.layer === 'pages') {
        return target.name === source.name ? null : 'a page may not import another page';
    }
    return to === `features/${target.name}/index.js`
        ? null
        : `a page may import a feature only through features/${target.name}/index.js`;
}

test('every module sits in lib/, a feature folder or a page folder', () => {
    const stray = modules().filter((path) => !placeOf(path));
    assert.deepEqual(stray, [], `move these under lib/, features/<name>/ or pages/<name>/: ${stray.join(', ')}`);
});

test('every import follows the layer rules', () => {
    const broken = [];
    for (const path of modules()) {
        if (!placeOf(path)) continue;
        const source = readFileSync(join(JS_DIR, path), 'utf8');
        for (const specifier of importsOf(source)) {
            if (!specifier.startsWith('.')) {
                broken.push(`${path} imports '${specifier}': every import is a relative specifier under static/js`);
                continue;
            }
            const target = relative(JS_DIR, resolve(JS_DIR, dirname(path), specifier)).split(sep).join('/');
            const reason = target.startsWith('..')
                ? 'imports may not leave static/js'
                : violation(path, target);
            if (reason) broken.push(`${path} imports '${specifier}': ${reason}`);
        }
    }
    assert.deepEqual(broken, [], `\n${broken.join('\n')}`);
});

test('every feature has an index.js', () => {
    const missing = slices('features').filter((name) => !existsSync(join(JS_DIR, 'features', name, 'index.js')));
    assert.deepEqual(missing, [], `features without an index.js: ${missing.join(', ')}`);
});

test('every page has an entry.js that a template loads, and templates load only page entries', () => {
    const loaded = new Set(readdirSync(TEMPLATES_DIR)
        .filter((name) => name.endsWith('.html'))
        .flatMap((name) => [...readFileSync(join(TEMPLATES_DIR, name), 'utf8').matchAll(TEMPLATE_SCRIPT)])
        .map((match) => match[1]));

    const pages = slices('pages');
    assert.notDeepEqual(pages, [], 'static/js/pages/ has no pages');
    const unloaded = pages
        .map((name) => `pages/${name}/entry.js`)
        .filter((entry) => !existsSync(join(JS_DIR, entry)) || !loaded.has(entry));
    assert.deepEqual(unloaded, [], `page entries missing or loaded by no template: ${unloaded.join(', ')}`);

    const notEntries = [...loaded].filter((path) => !/^pages\/[^/]+\/entry\.js$/.test(path));
    assert.deepEqual(notEntries, [], `templates load scripts that are not page entries: ${notEntries.join(', ')}`);
});
