import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openLandingPage, screen } from '../support/pages/upload.js';

// Longer than any stage's hold time, so an autoplaying flow must have advanced.
const LONGEST_HOLD_MS = 6000;

// The stage on screen, by the caption assistive tech reads for it.
const currentStage = () => screen.getByRole('listitem', { current: 'step' });
const FIRST_STAGE = /Pick a file/;
const SECOND_STAGE = /Set a password/;

describe('hero flow', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    // The control for the reduced-motion test: without it, "still on stage 0"
    // would pass even if the flow never animated at all.
    it('autoplays to the next stage', () => {
        openLandingPage();

        vi.advanceTimersByTime(LONGEST_HOLD_MS);

        expect(currentStage()).toHaveTextContent(SECOND_STAGE);
    });

    it('does not autoplay when reduced motion is preferred', () => {
        openLandingPage({ reducedMotion: true });

        vi.advanceTimersByTime(LONGEST_HOLD_MS * 3);

        expect(currentStage()).toHaveTextContent(FIRST_STAGE);
    });

    it('the toggle pauses the walkthrough and plays it again', async () => {
        const landing = openLandingPage();

        await landing.pauseWalkthrough();
        // A deliberate pause outlasts the pointer leaving the stage.
        await landing.pointAtWalkthrough();
        await landing.moveAwayFromWalkthrough();
        vi.advanceTimersByTime(LONGEST_HOLD_MS * 3);

        expect(currentStage()).toHaveTextContent(FIRST_STAGE);
        expect(screen.getByRole('button', { name: 'Play walkthrough' })).toBeVisible();

        await landing.playWalkthrough();
        vi.advanceTimersByTime(LONGEST_HOLD_MS);

        expect(currentStage()).toHaveTextContent(SECOND_STAGE);
        expect(screen.getByRole('button', { name: 'Pause walkthrough' })).toBeVisible();
    });
});
