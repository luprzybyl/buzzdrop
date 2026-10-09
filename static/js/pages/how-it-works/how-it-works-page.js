// --- How it works: the share flow, one step at a time ---
// The template renders every step in full, for every sender and content;
// parts that differ carry data-show="<switch>:<value>". This script shows one
// step at a time, steps through them by hand or on a timer, and switches the
// variants live when a switch changes: the step on screen stays and replays
// its animation, and the choice goes into the address so a view can be
// linked. Without it, every step is shown and the switches submit the form.
import { required, requiredWindow } from '../../lib/required.js';

/**
 * @typedef {Record<string, never>} HowItWorksDeps
 */

/**
 * The page needs nothing beyond the DOM, which comes in as `root`; the
 * address and history are read from the root's own window.
 * @returns {HowItWorksDeps}
 */
export function browserDeps() {
    return {};
}

/** How long each step holds while playing. */
const HOLD_MS = 7000;

const SENDERS = ['web', 'cli'];
const CONTENTS = ['file', 'text'];

/** What the status line calls each choice. */
const SENDER_NAMES = { web: 'the web app', cli: 'the buzz CLI' };
const CONTENT_NAMES = { file: 'a file', text: 'a text note' };

/**
 * @typedef {object} Choice
 * @property {'web' | 'cli'} sender
 * @property {'file' | 'text'} content
 */

/**
 * A view that exists, by the same rules as app.py's how_it_works() (change
 * them together): unknown values fall back to the web app sending a file,
 * and the CLI sends files only (#247).
 * @param {string | null | undefined} sender
 * @param {string | null | undefined} content
 * @returns {Choice}
 */
function normalizeChoice(sender, content) {
    const validSender = /** @type {Choice['sender']} */ (SENDERS.includes(sender ?? '') ? sender : 'web');
    const validContent = /** @type {Choice['content']} */ (
        validSender !== 'cli' && CONTENTS.includes(content ?? '') ? content : 'file');
    return { sender: validSender, content: validContent };
}

/**
 * The view an address asks for.
 * @param {string} search - location.search
 * @returns {Choice}
 */
function choiceFrom(search) {
    const params = new URLSearchParams(search);
    return normalizeChoice(params.get('sender'), params.get('content'));
}

/**
 * @param {Document} root - the how_it_works.html document
 * @param {HowItWorksDeps} deps
 */
export function initHowItWorks(root, deps) {
    const window = requiredWindow(root);
    const flow = required(root, '#hiw-flow', 'section');
    const steps = /** @type {HTMLElement[]} */ (Array.from(flow.querySelectorAll('.hiw-step')));
    const stepButtons = /** @type {HTMLButtonElement[]} */ (Array.from(flow.querySelectorAll('[data-step-id]')));
    const stepsBox = required(flow, '#hiw-steps', 'div');
    const counter = required(flow, '#hiw-counter', 'p');
    const prev = required(flow, '#hiw-prev', 'button');
    const next = required(flow, '#hiw-next', 'button');
    const play = required(flow, '#hiw-play', 'button');
    const status = required(flow, '#hiw-choice-status', 'p');
    const cliTextHint = required(flow, '#content-cli-hint', 'p');
    const senderRadios = /** @type {HTMLInputElement[]} */ (Array.from(flow.querySelectorAll('input[name="sender"]')));
    const contentRadios = /** @type {HTMLInputElement[]} */ (Array.from(flow.querySelectorAll('input[name="content"]')));
    const textRadio = required(flow, 'input[name="content"][value="text"]', 'input');

    /** The step an address's fragment names (#step-release), or -1. */
    const stepNamedBy = (/** @type {string} */ hash) => steps.findIndex((step) => `#${step.id}` === hash);

    let choice = choiceFrom(window.location.search);
    let current = Math.max(0, stepNamedBy(window.location.hash));
    let playing = false;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    // The countdown to the next step: what is left of it, and when the
    // running part of it started. A pause keeps what is left.
    let remaining = HOLD_MS;
    let countingSince = 0;

    // The countdown is drawn by CSS (the ring around Play and the bar under
    // the current step), timed by the same hold; the classes on the flow
    // run, freeze and clear it.
    flow.style.setProperty('--hiw-hold', `${HOLD_MS}ms`);
    const playIcon = required(play, '[data-icon="play"]', 'span');
    const pauseIcon = required(play, '[data-icon="pause"]', 'span');
    const ring = required(play, '.hiw-play-ring', 'span');

    // Restart the step's animation: drop the class, let the browser see the
    // step without it, then put it back.
    const replay = () => {
        const step = steps[current];
        step.classList.remove('is-active');
        void step.offsetWidth;
        step.classList.add('is-active');
    };

    /** @param {number} index */
    const showStep = (index) => {
        current = index;
        steps.forEach((step, i) => {
            step.toggleAttribute('hidden', i !== index);
            step.classList.toggle('is-active', i === index);
        });
        stepButtons.forEach((button, i) => {
            if (i === index) button.setAttribute('aria-current', 'step');
            else button.removeAttribute('aria-current');
            // The steps behind the reader, for the step list to tick off.
            button.classList.toggle('is-done', i < index);
        });
        counter.textContent = `Step ${index + 1} of ${steps.length}`;
        prev.disabled = index === 0;
        next.disabled = index === steps.length - 1;
    };

    /** @param {boolean} value */
    const setPlaying = (value) => {
        playing = value;
        play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
        play.title = playing ? 'Pause' : 'Play the steps';
        playIcon.toggleAttribute('hidden', playing);
        pauseIcon.toggleAttribute('hidden', !playing);
        // A step changed by hand is announced; one changing on a timer
        // would talk over the reader, as a carousel's does.
        stepsBox.setAttribute('aria-live', playing ? 'off' : 'polite');
    };

    // A fresh countdown for the step on screen: the ring starts over (the
    // step bar does by itself, as it moves to another step's button).
    const restartCountdown = () => {
        remaining = HOLD_MS;
        ring.classList.remove('is-counting');
        void ring.getBoundingClientRect();
        ring.classList.add('is-counting');
    };

    const countDown = () => {
        countingSince = Date.now();
        timer = setTimeout(() => {
            showStep(current + 1);
            if (current === steps.length - 1) {
                stopPlaying();
            } else {
                restartCountdown();
                countDown();
            }
        }, remaining);
    };

    // No step change pending, and Play shown again.
    const halt = () => {
        clearTimeout(timer);
        timer = undefined;
        setPlaying(false);
    };

    // Stepping by hand, or reaching the end: autoplay is over, and the
    // countdown with it.
    const stopPlaying = () => {
        halt();
        remaining = HOLD_MS;
        flow.classList.remove('is-playing', 'is-paused');
        ring.classList.remove('is-counting');
    };

    // The countdown freezes where it is, for Play to pick up.
    const pausePlaying = () => {
        remaining = Math.max(0, remaining - (Date.now() - countingSince));
        halt();
        flow.classList.add('is-paused');
    };

    const startPlaying = () => {
        const resuming = flow.classList.contains('is-paused');
        setPlaying(true);
        flow.classList.add('is-playing');
        flow.classList.remove('is-paused');
        // Play on the last step starts over.
        if (!resuming && current === steps.length - 1) showStep(0);
        if (!resuming) restartCountdown();
        countDown();
    };

    const applyChoice = () => {
        for (const radio of senderRadios) radio.checked = radio.value === choice.sender;
        for (const radio of contentRadios) radio.checked = radio.value === choice.content;
        const cli = choice.sender === 'cli';
        textRadio.disabled = cli;
        cliTextHint.toggleAttribute('hidden', !cli);
        if (cli) textRadio.setAttribute('aria-describedby', cliTextHint.id);
        else textRadio.removeAttribute('aria-describedby');
        for (const part of /** @type {HTMLElement[]} */ (Array.from(root.querySelectorAll('[data-show]')))) {
            const [name, value] = (part.dataset.show ?? '').split(':');
            part.toggleAttribute('hidden', choice[/** @type {keyof Choice} */ (name)] !== value);
        }
    };

    const onSwitch = () => {
        const sender = senderRadios.find((radio) => radio.checked)?.value;
        const content = contentRadios.find((radio) => radio.checked)?.value;
        choice = normalizeChoice(sender, content);
        applyChoice();
        replay();
        status.textContent = `Showing ${SENDER_NAMES[choice.sender]} sending ${CONTENT_NAMES[choice.content]}.`;
        const url = new URL(window.location.href);
        url.search = new URLSearchParams({ sender: choice.sender, content: choice.content }).toString();
        window.history.replaceState(window.history.state, '', url);
    };

    for (const radio of [...senderRadios, ...contentRadios]) radio.addEventListener('change', onSwitch);

    stepButtons.forEach((button, i) => button.addEventListener('click', () => {
        stopPlaying();
        showStep(i);
    }));
    prev.addEventListener('click', () => {
        stopPlaying();
        showStep(current - 1);
    });
    next.addEventListener('click', () => {
        stopPlaying();
        showStep(current + 1);
    });
    play.addEventListener('click', () => (playing ? pausePlaying() : startPlaying()));

    // A link to a step (#step-release) opens it, here as on load.
    window.addEventListener('hashchange', () => {
        const index = stepNamedBy(window.location.hash);
        if (index === -1) return;
        stopPlaying();
        showStep(index);
    });

    // Don't advance in a background tab, where nobody is reading; Play
    // picks up where it was.
    root.addEventListener('visibilitychange', () => {
        if (root.hidden && playing) pausePlaying();
    });

    // The controls only work with this script, so they appear with it.
    for (const control of [prev, play, next]) control.hidden = false;
    applyChoice();
    showStep(current);
}
