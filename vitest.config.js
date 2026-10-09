import { defineConfig } from 'vitest/config';

// DOM + JS-integration tiers only; the pure-module unit tests in tests/js/*.test.js
// stay on `node --test` (docs/frontend-test-strategy.md §2).
export default defineConfig({
    test: {
        environment: 'happy-dom',
        include: ['tests/js/dom/**/*.test.js', 'tests/js/integration/**/*.test.js'],
        // jest-dom's matchers, and closing every page a driver opened.
        setupFiles: ['tests/js/support/setup.js'],
        coverage: {
            provider: 'v8',
            include: ['static/js/**'],
            // Never imported by tests: the page entry scripts (tests import
            // the page module instead) and the passphrase wordlist, which is data.
            exclude: ['static/js/pages/*/entry.js', 'static/js/lib/eff-wordlist.js'],
            reporter: ['text', 'html'],
        },
    },
});
