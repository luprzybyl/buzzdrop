// --- Landing Hero: animated walkthrough of a Buzzdrop hand-off ---
// Cycles a mock UI through the six stages a drop actually goes through. The
// artwork in each stage is aria-hidden; the captions are real text in an
// ordered list, so assistive tech reads the whole sequence regardless of which
// stage happens to be on screen.
import { requiredWindow } from '../../lib/required.js';

/**
 * @typedef {Record<string, never>} HeroFlowDeps
 */

/**
 * The hero needs nothing beyond the DOM, which comes in as `root`; the
 * reduced-motion query is read from the root's own window.
 * @returns {HeroFlowDeps}
 */
export function browserDeps() {
    return {};
}

/**
 * @param {Document} root - the index.html document; pages without the hero are a no-op
 * @param {HeroFlowDeps} deps
 */
export function initHeroFlow(root, deps) {
    const stage = root.getElementById('flow-stage');
    if (!stage) return;

    const steps = Array.from(stage.querySelectorAll('.flow-step'));
    const dots = Array.from(stage.querySelectorAll('.flow-dot'));
    // Each stage gets as long as its caption needs to be read.
    const HOLD_MS = [4320, 3840, 3480, 3960, 3720, 5040];
    const DEFAULT_HOLD_MS = 3840;

    const reduceMotion = requiredWindow(root).matchMedia('(prefers-reduced-motion: reduce)');
    let current = 0;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    // A deliberate pause has to outlast hovering and tab switches, so it is
    // tracked apart from the transient reasons to hold still.
    let paused = false;
    // The countdown to the next stage: what is left of it, and when the
    // running part of it started. Holding still keeps what is left, so the
    // stage picks up where the ring froze instead of starting over.
    let remaining = DEFAULT_HOLD_MS;
    let countingSince = 0;

    // The ring around the toggle and the fill in the active pip are drawn by
    // CSS from --flow-hold. .is-counting on the stage runs them (dropping and
    // re-adding it starts both over together) and .is-held freezes them.
    const restartCountdown = () => {
        remaining = HOLD_MS[current] ?? DEFAULT_HOLD_MS;
        stage.style.setProperty('--flow-hold', `${remaining}ms`);
        stage.classList.remove('is-counting');
        void stage.offsetWidth;
        stage.classList.add('is-counting');
    };

    /** @param {number} index */
    const render = (index) => {
        current = index;
        stage.dataset.step = String(index);
        steps.forEach((step, i) => {
            step.classList.toggle('is-active', i === index);
            // Which caption is on screen, for assistive tech; the list keeps
            // every caption readable either way.
            if (i === index) step.setAttribute('aria-current', 'step');
            else step.removeAttribute('aria-current');
        });
        dots.forEach((dot, i) => {
            dot.classList.toggle('is-active', i === index);
            dot.classList.toggle('is-done', i < index);
        });
    };

    const stop = () => {
        stage.classList.add('is-held');
        // Already still (paused, then hovered): nothing more has elapsed.
        if (timer === undefined) return;
        clearTimeout(timer);
        timer = undefined;
        remaining = Math.max(0, remaining - (Date.now() - countingSince));
    };

    const play = () => {
        stop();
        // Reduced motion shows every stage at once instead of auto-advancing;
        // see the prefers-reduced-motion block in the stylesheet.
        if (paused || reduceMotion.matches || root.hidden) return;
        stage.classList.remove('is-held');
        countingSince = Date.now();
        timer = setTimeout(() => {
            timer = undefined;
            render((current + 1) % steps.length);
            restartCountdown();
            play();
        }, remaining);
    };

    render(0);
    restartCountdown();
    play();

    // Hover only pauses while the pointer is there, which leaves keyboard and
    // touch users with no way to stop it; this control is the real mechanism.
    const toggle = root.getElementById('flow-toggle');
    if (toggle) {
        const pauseIcon = toggle.querySelector('[data-flow-icon="pause"]');
        const playIcon = toggle.querySelector('[data-flow-icon="play"]');

        /** @param {boolean} value */
        const setPaused = (value) => {
            paused = value;
            toggle.setAttribute('aria-label', paused ? 'Play walkthrough' : 'Pause walkthrough');
            if (pauseIcon) pauseIcon.toggleAttribute('hidden', paused);
            if (playIcon) playIcon.toggleAttribute('hidden', !paused);
            // Pressing play while the pointer rests on the stage resumes it:
            // an explicit press outranks the hover heuristic.
            if (paused) stop(); else play();
        };

        toggle.addEventListener('click', () => setPaused(!paused));
    }

    // Let people linger on a stage they are still reading.
    stage.addEventListener('mouseenter', stop);
    stage.addEventListener('mouseleave', play);

    // Don't burn frames in a background tab.
    root.addEventListener('visibilitychange', () => (root.hidden ? stop() : play()));

    reduceMotion.addEventListener('change', () => {
        if (reduceMotion.matches) {
            stop();
        } else {
            // Reduced motion cancelled the ring's animation, so it starts
            // over from empty; the stage gets a full hold to match.
            restartCountdown();
            play();
        }
    });
}
