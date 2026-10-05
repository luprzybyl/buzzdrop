import { defineConfig } from 'vitest/config';

// DOM + JS-integration tiers only; the pure-module unit tests in tests/js/*.test.mjs
// stay on `node --test` (docs/frontend-test-strategy.md §2).
export default defineConfig({
    test: {
        environment: 'happy-dom',
        include: ['tests/js/dom/**/*.test.mjs', 'tests/js/integration/**/*.test.mjs'],
        coverage: {
            provider: 'v8',
            include: ['static/js/**'],
            // Never imported by tests: entry scripts (tests import the page
            // module instead; add each entry here as its page is split) and the
            // passphrase wordlist, which is data.
            exclude: ['static/js/hero-flow.js', 'static/js/eff-wordlist.mjs'],
            reporter: ['text', 'html'],
        },
    },
});
