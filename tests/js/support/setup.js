// Vitest setup for the DOM and JS-integration layers
// (docs/frontend-test-strategy.md §2): jest-dom's matchers on `expect`, and
// every page a driver opened closed after each test.
import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { closePages } from './pages/page.js';

afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await closePages();
});
