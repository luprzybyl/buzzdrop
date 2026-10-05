import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initHeroFlow } from '../../../static/js/hero-flow-page.js';
import { browserView, loadFixture } from '../support/dom-fixture.js';

// Longer than any stage's hold time, so an autoplaying flow must have advanced.
const LONGEST_HOLD_MS = 6000;

describe('hero flow', () => {
    /** @type {import('happy-dom').Window | undefined} */
    let page;

    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(async () => {
        vi.useRealTimers();
        await page?.happyDOM.close();
        page = undefined;
    });

    /** @param {import('happy-dom').IOptionalBrowserSettings} [settings] */
    const start = (settings) => {
        page = loadFixture('index--anonymous', settings);
        const window = browserView(page);
        initHeroFlow(window.document, {});
        return {
            window,
            stage: /** @type {HTMLElement} */ (window.document.getElementById('flow-stage')),
            toggle: /** @type {HTMLButtonElement} */ (window.document.getElementById('flow-toggle')),
        };
    };

    // The control for the reduced-motion test: without it, "still on stage 0"
    // would pass even if the flow never animated at all.
    it('autoplays to the next stage', () => {
        const { stage } = start();

        vi.advanceTimersByTime(LONGEST_HOLD_MS);

        expect(stage.dataset.step).toBe('1');
    });

    it('does not autoplay when reduced motion is preferred', () => {
        const { stage } = start({ device: { prefersReducedMotion: 'reduce' } });

        vi.advanceTimersByTime(LONGEST_HOLD_MS * 3);

        expect(stage.dataset.step).toBe('0');
    });

    it('the toggle pauses the walkthrough and plays it again', () => {
        const { window, stage, toggle } = start();

        toggle.click();
        // A deliberate pause outlasts the pointer leaving the stage.
        stage.dispatchEvent(new window.MouseEvent('mouseenter'));
        stage.dispatchEvent(new window.MouseEvent('mouseleave'));
        vi.advanceTimersByTime(LONGEST_HOLD_MS * 3);

        expect(stage.dataset.step).toBe('0');
        expect(toggle.getAttribute('aria-label')).toBe('Play walkthrough');
        expect(toggle.querySelector('[data-flow-icon="play"]')?.classList.contains('hidden')).toBe(false);
        expect(toggle.querySelector('[data-flow-icon="pause"]')?.classList.contains('hidden')).toBe(true);

        toggle.click();
        vi.advanceTimersByTime(LONGEST_HOLD_MS);

        expect(stage.dataset.step).toBe('1');
        expect(toggle.getAttribute('aria-label')).toBe('Pause walkthrough');
    });
});
