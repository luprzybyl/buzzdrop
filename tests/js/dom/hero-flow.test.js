import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WALKTHROUGH_HOLD_MS, openLandingPage, screen } from '../support/pages/upload.js';

// Longer than any stage's hold time, so an autoplaying flow must have advanced.
const LONGEST_HOLD_MS = Math.max(...WALKTHROUGH_HOLD_MS) + 1;

// The stage on screen, by the caption assistive tech reads for it.
const currentStage = () => screen.getByRole('listitem', { current: 'step' });
const FIRST_STAGE = /Pick a file/;
const SECOND_STAGE = /Set a password/;
// The resume tests need to land just either side of the end of a hold.
const [FIRST_HOLD_MS, SECOND_HOLD_MS] = WALKTHROUGH_HOLD_MS;

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

    // The countdown ring freezes while the stage is held, so the stage has to
    // pick up where it froze rather than start a full hold again.
    it('resumes the hold where hovering froze it', async () => {
        const landing = openLandingPage();

        vi.advanceTimersByTime(3000);
        await landing.pointAtWalkthrough();
        vi.advanceTimersByTime(LONGEST_HOLD_MS * 3);
        await landing.moveAwayFromWalkthrough();
        vi.advanceTimersByTime(FIRST_HOLD_MS - 3000 - 1);

        expect(currentStage()).toHaveTextContent(FIRST_STAGE);

        vi.advanceTimersByTime(1);

        expect(currentStage()).toHaveTextContent(SECOND_STAGE);
    });

    it('resumes the hold where the pause button froze it', async () => {
        const landing = openLandingPage();

        vi.advanceTimersByTime(1000);
        await landing.pauseWalkthrough();
        vi.advanceTimersByTime(500);
        // Hovering and leaving while paused takes nothing more off the hold.
        await landing.pointAtWalkthrough();
        await landing.moveAwayFromWalkthrough();
        vi.advanceTimersByTime(LONGEST_HOLD_MS * 3);
        await landing.playWalkthrough();
        vi.advanceTimersByTime(FIRST_HOLD_MS - 1000 - 1);

        expect(currentStage()).toHaveTextContent(FIRST_STAGE);

        vi.advanceTimersByTime(1);

        expect(currentStage()).toHaveTextContent(SECOND_STAGE);
    });

    // Coming back to the tab must not override the pointer still resting on
    // the stage; leaving the stage then resumes what was left of the hold.
    it('stays held under the pointer when the tab comes back', async () => {
        const landing = openLandingPage();

        vi.advanceTimersByTime(1000);
        await landing.pointAtWalkthrough();
        landing.leaveTab();
        landing.returnToTab();
        vi.advanceTimersByTime(LONGEST_HOLD_MS * 3);

        expect(currentStage()).toHaveTextContent(FIRST_STAGE);

        await landing.moveAwayFromWalkthrough();
        vi.advanceTimersByTime(FIRST_HOLD_MS - 1000);

        expect(currentStage()).toHaveTextContent(SECOND_STAGE);
    });

    it('gives the next stage its full hold after a resumed one', async () => {
        const landing = openLandingPage();

        vi.advanceTimersByTime(3000);
        await landing.pointAtWalkthrough();
        await landing.moveAwayFromWalkthrough();
        vi.advanceTimersByTime(FIRST_HOLD_MS - 3000);
        vi.advanceTimersByTime(SECOND_HOLD_MS - 1);

        expect(currentStage()).toHaveTextContent(SECOND_STAGE);

        vi.advanceTimersByTime(1);

        expect(currentStage()).not.toHaveTextContent(SECOND_STAGE);
    });
});
