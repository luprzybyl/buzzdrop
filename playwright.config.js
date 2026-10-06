// E2E: Playwright on the host against the Buzzdrop image
// (docs/frontend-test-strategy.md §8). One fresh container per run, shared
// by every browser project and worker.
import { defineConfig, devices } from '@playwright/test';

// 5000 is taken by the macOS AirPlay Receiver.
const port = process.env.E2E_PORT || '5055';
const image = process.env.E2E_IMAGE || 'buzzdrop-e2e';

export default defineConfig({
    testDir: 'tests/e2e',
    retries: 0,
    // Playwright advises one worker on CI; it also suits a single Flask
    // dev server with in-memory rate limits.
    workers: process.env.CI ? 1 : undefined,
    forbidOnly: !!process.env.CI,
    reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
    use: {
        // localhost is a secure context, so crypto.subtle works without TLS.
        baseURL: `http://localhost:${port}`,
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
        video: 'off',
        // No animations: entrance animations and the hero walkthrough move
        // elements while tests click them. The app collapses every animation
        // under prefers-reduced-motion.
        contextOptions: { reducedMotion: 'reduce' },
    },
    projects: [
        { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
        { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
        { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    ],
    webServer: {
        // --init and the SIGTERM shutdown are both needed, or the container
        // outlives the run: flask as PID 1 ignores SIGTERM, and a SIGKILLed
        // `docker run` client can't forward anything.
        command: `docker run --rm --init --env-file tests/e2e/e2e.env -p 127.0.0.1:${port}:5000 ${image}`,
        url: `http://localhost:${port}/login`,
        gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
        stdout: 'pipe',
        stderr: 'pipe',
    },
});
