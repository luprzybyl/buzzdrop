import { within } from '@testing-library/dom';
import { describe, expect, it, vi } from 'vitest';
import { openHowItWorks, screen } from '../support/pages/how-it-works.js';

// Longer than any step's hold time, so a playing flow must have advanced.
const LONGEST_HOLD_MS = 10_000;
const STEPS = 8;

// The step on screen: every other step is hidden.
const currentStep = () => screen.getByRole('article');
const stepButton = (/** @type {RegExp} */ title) =>
    within(screen.getByRole('navigation', { name: 'Steps' })).getByRole('button', { name: title });
/** A part of the step on screen's text, shown or not; its diagram is left out. */
const inStep = (/** @type {RegExp} */ text) =>
    within(currentStep()).getByText(text, { ignore: '[aria-hidden="true"] *' });

describe('how it works: stepping through', () => {
    it('starts on the first step, with nowhere to go back to', () => {
        openHowItWorks();

        expect(currentStep()).toHaveAccessibleName(/Upload, phase 1/);
        expect(stepButton(/Upload, phase 1/)).toHaveAttribute('aria-current', 'step');
        expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
        expect(screen.getByText(`Step 1 of ${STEPS}`)).toBeVisible();
    });

    it('Next and Previous move one step', async () => {
        const page = openHowItWorks();

        await page.nextStep();
        await page.nextStep();
        expect(currentStep()).toHaveAccessibleName(/Upload, phase 2/);
        expect(stepButton(/Upload, phase 2/)).toHaveAttribute('aria-current', 'step');
        expect(stepButton(/Upload, phase 1/)).not.toHaveAttribute('aria-current');

        await page.previousStep();
        expect(currentStep()).toHaveAccessibleName(/Encrypt where you are/);
        expect(screen.getByText(`Step 2 of ${STEPS}`)).toBeVisible();
    });

    it('the step list jumps to a step, and Next stops at the last', async () => {
        const page = openHowItWorks();

        await page.goToStep(/Expiry and manual delete/);

        expect(currentStep()).toHaveAccessibleName(/Expiry and manual delete/);
        expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    });

    it('opens on the step its address names', () => {
        openHowItWorks({ path: '/how-it-works#step-release' });

        expect(currentStep()).toHaveAccessibleName(/The recipient proves the password/);
    });

    it('follows a link to a step on the page', async () => {
        const page = openHowItWorks();

        await page.followLinkTo('#step-download');

        expect(currentStep()).toHaveAccessibleName(/Download once/);
    });

    it('Play walks through the steps until Pause', async () => {
        const page = openHowItWorks();
        vi.useFakeTimers();

        await page.play();
        vi.advanceTimersByTime(LONGEST_HOLD_MS);
        expect(currentStep()).toHaveAccessibleName(/Encrypt where you are/);

        await page.pause();
        vi.advanceTimersByTime(LONGEST_HOLD_MS * 3);
        expect(currentStep()).toHaveAccessibleName(/Encrypt where you are/);
    });

    it('does not move on its own until asked to', () => {
        openHowItWorks();
        vi.useFakeTimers();

        vi.advanceTimersByTime(LONGEST_HOLD_MS * 3);

        expect(currentStep()).toHaveAccessibleName(/Upload, phase 1/);
    });

    it('playing stops at the last step, and plays again from the first', async () => {
        const page = openHowItWorks();
        vi.useFakeTimers();

        await page.play();
        vi.advanceTimersByTime(LONGEST_HOLD_MS * (STEPS + 2));
        expect(currentStep()).toHaveAccessibleName(/Expiry and manual delete/);
        expect(screen.getByRole('button', { name: 'Play' })).toBeVisible();

        await page.play();
        expect(currentStep()).toHaveAccessibleName(/Upload, phase 1/);
    });

    // Reduced motion drops the animation, not the steps: they still play
    // when asked, and every step reads the same.
    it('still plays when reduced motion is preferred', async () => {
        const page = openHowItWorks({ reducedMotion: true });
        vi.useFakeTimers();

        await page.play();
        vi.advanceTimersByTime(LONGEST_HOLD_MS);

        expect(currentStep()).toHaveAccessibleName(/Encrypt where you are/);
    });

    it('stepping by hand stops playing', async () => {
        const page = openHowItWorks();
        vi.useFakeTimers();

        await page.play();
        await page.nextStep();
        vi.advanceTimersByTime(LONGEST_HOLD_MS * 3);

        expect(currentStep()).toHaveAccessibleName(/Encrypt where you are/);
        expect(screen.getByRole('button', { name: 'Play' })).toBeVisible();
    });
});

describe('how it works: the switches', () => {
    it('defaults to the web app sending a file', () => {
        openHowItWorks();

        expect(screen.getByRole('radio', { name: 'Web app' })).toBeChecked();
        expect(screen.getByRole('radio', { name: 'File' })).toBeChecked();
        expect(screen.getByRole('radio', { name: 'Text' })).toBeEnabled();
    });

    it('switching to the CLI changes the step on screen in place', async () => {
        const page = openHowItWorks();
        await page.goToStep(/Upload, phase 2/);

        await page.sendFrom('buzz CLI');

        expect(currentStep()).toHaveAccessibleName(/Upload, phase 2/);
        expect(inStep(/Your terminal/)).toBeVisible();
        expect(inStep(/Your browser/)).not.toBeVisible();
        expect(inStep(/signed in by your API token/)).toBeVisible();
        expect(inStep(/signed in by your session/)).not.toBeVisible();
        expect(page.url()).toBe('http://localhost/how-it-works?sender=cli&content=file');
    });

    it('switching to text changes the upload and the end of decryption', async () => {
        const page = openHowItWorks();
        await page.goToStep(/Upload, phase 2/);

        await page.send('Text');

        expect(inStep(/base64-encoded/)).toHaveTextContent('base64-encoded, in a note_text field');
        expect(inStep(/as a multipart/)).not.toBeVisible();
        expect(inStep(/Secret Note/)).toBeVisible();

        await page.goToStep(/Decrypt in the browser/);
        expect(inStep(/shown on the page, with a Copy button/)).toBeVisible();
        expect(inStep(/saved as a download/)).not.toBeVisible();
        expect(page.url()).toBe('http://localhost/how-it-works?sender=web&content=text');
    });

    it('the filename is said to be visible while a file is sent', async () => {
        const page = openHowItWorks();
        await page.goToStep(/Upload, phase 2/);

        expect(inStep(/original filename, in plain text/)).toBeVisible();

        await page.send('Text');
        expect(inStep(/original filename, in plain text/)).not.toBeVisible();
    });

    it('the CLI sends files only: Text is disabled, and says why', async () => {
        const page = openHowItWorks();
        await page.send('Text');

        await page.sendFrom('buzz CLI');

        const text = screen.getByRole('radio', { name: 'Text' });
        expect(text).toBeDisabled();
        expect(text).toHaveAccessibleDescription(/the CLI sends files only/);
        expect(screen.getByRole('radio', { name: 'File' })).toBeChecked();
        expect(page.url()).toBe('http://localhost/how-it-works?sender=cli&content=file');

        await page.sendFrom('Web app');
        expect(text).toBeEnabled();
        expect(text).not.toHaveAccessibleDescription(/the CLI sends files only/);
    });

    it('opens on the view its address names', () => {
        openHowItWorks({ path: '/how-it-works?sender=cli&content=file' });

        expect(screen.getByRole('radio', { name: 'buzz CLI' })).toBeChecked();
        expect(screen.getByRole('radio', { name: 'Text' })).toBeDisabled();
        expect(inStep(/Your terminal/)).toBeVisible();
    });

    it('an address asking for CLI + text opens on CLI + file', () => {
        openHowItWorks({ path: '/how-it-works?sender=cli&content=text' });

        expect(screen.getByRole('radio', { name: 'File' })).toBeChecked();
        expect(screen.getByRole('radio', { name: 'Text' })).not.toBeChecked();
    });

    it('announces the view it switched to', async () => {
        const page = openHowItWorks();

        await page.sendFrom('buzz CLI');

        expect(screen.getByRole('status')).toHaveTextContent('Showing the buzz CLI sending a file.');
    });

    it('keeps the step in the address when switching', async () => {
        const page = openHowItWorks({ path: '/how-it-works#step-share' });

        await page.sendFrom('buzz CLI');

        expect(page.url()).toBe('http://localhost/how-it-works?sender=cli&content=file#step-share');
    });
});
