// The play/pause button with a countdown ring (templates/_play_toggle.html),
// and the timer the ring draws. The timer keeps the time left when it
// freezes, so the ring and the step change it counts down to agree.
//
// The ring is drawn by CSS from --countdown-hold on `scope`, which also
// carries .is-playing while a countdown is set and .is-paused while it is
// frozen; a page's own countdown bars read the same three.
import { required } from '../../lib/required.js';

/**
 * @typedef {object} PlayToggleLabels
 * @property {string} play - the button's name while pressing it plays
 * @property {string} pause - the button's name while pressing it pauses
 * @property {string} [playTitle] - its tooltip while pressing it plays
 * @property {string} [pauseTitle] - its tooltip while pressing it pauses
 */

/**
 * @typedef {object} PlayToggle
 * @property {(playing: boolean) => void} showPlaying - name the button and
 *   show the icon for playing (Pause) or not (Play); the countdown is apart
 * @property {(holdMs: number) => void} restart - a fresh countdown of
 *   `holdMs`, with the ring starting over (from onElapsed, the full ring
 *   fades out over it); it runs unless frozen
 * @property {() => void} freeze - hold the countdown where it is
 * @property {() => void} resume - run the countdown on from where it froze
 * @property {() => void} stop - drop the countdown, and clear the ring
 * @property {() => boolean} isFrozen
 */

/**
 * @param {HTMLButtonElement} button - rendered by the play_toggle macro
 * @param {HTMLElement} scope - an ancestor of the button, and of any bar
 *   that counts down with it
 * @param {PlayToggleLabels} labels
 * @param {() => void} onElapsed - a countdown ran out
 * @returns {PlayToggle}
 */
export function createPlayToggle(button, scope, labels, onElapsed) {
    const ring = required(button, '.play-toggle-ring', 'span');
    const playIcon = required(button, '[data-icon="play"]', 'span');
    const pauseIcon = required(button, '[data-icon="pause"]', 'span');

    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    // What is left of the countdown, and when the running part of it
    // started.
    let remaining = 0;
    let countingSince = 0;
    let frozen = false;
    // Set while onElapsed runs, so the countdown it starts fades out the
    // full ring instead of snapping it back to empty.
    let ranOut = false;

    const run = () => {
        countingSince = Date.now();
        timer = setTimeout(() => {
            timer = undefined;
            ranOut = true;
            onElapsed();
            ranOut = false;
        }, remaining);
    };

    const halt = () => {
        if (timer === undefined) return;
        clearTimeout(timer);
        timer = undefined;
        remaining = Math.max(0, remaining - (Date.now() - countingSince));
    };

    return {
        showPlaying(playing) {
            button.setAttribute('aria-label', playing ? labels.pause : labels.play);
            const title = playing ? labels.pauseTitle : labels.playTitle;
            if (title) button.title = title;
            playIcon.toggleAttribute('hidden', playing);
            pauseIcon.toggleAttribute('hidden', !playing);
        },
        restart(holdMs) {
            clearTimeout(timer);
            timer = undefined;
            remaining = holdMs;
            scope.style.setProperty('--countdown-hold', `${holdMs}ms`);
            scope.classList.add('is-playing');
            // Drop the class, let the browser see the ring without it, then
            // put it back: the ring's animation starts over.
            ring.classList.toggle('after-full', ranOut);
            ring.classList.remove('is-counting');
            void ring.getBoundingClientRect();
            ring.classList.add('is-counting');
            if (!frozen) run();
        },
        freeze() {
            frozen = true;
            scope.classList.add('is-paused');
            halt();
        },
        resume() {
            frozen = false;
            scope.classList.remove('is-paused');
            if (timer === undefined && scope.classList.contains('is-playing')) run();
        },
        stop() {
            clearTimeout(timer);
            timer = undefined;
            frozen = false;
            scope.classList.remove('is-playing', 'is-paused');
            ring.classList.remove('is-counting', 'after-full');
        },
        isFrozen: () => frozen,
    };
}
