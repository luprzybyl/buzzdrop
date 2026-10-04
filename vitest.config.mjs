// PROTOTYPE config — DOM/integration only; unit suites stay on node --test.
import { defineConfig } from 'vitest/config';
export default defineConfig({
    test: { environment: 'happy-dom', include: ['tests/js/{dom,integration}/**/*.test.mjs'] },
});
