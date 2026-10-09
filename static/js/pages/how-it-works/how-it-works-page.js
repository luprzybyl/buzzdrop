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
 * The view an address asks for, as the server reads it: unknown values fall
 * back to the web app sending a file, and the CLI sends files only (#247).
 * @param {string} search - location.search
 * @returns {Choice}
 */
function choiceFrom(search) {
    const params = new URLSearchParams(search);
    const sender = /** @type {Choice['sender']} */ (
        SENDERS.includes(params.get('sender') ?? '') ? params.get('sender') : 'web');
    const content = /** @type {Choice['content']} */ (
        sender !== 'cli' && CONTENTS.includes(params.get('content') ?? '') ? params.get('content') : 'file');
    return { sender, content };
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
    const hint = required(flow, '#content-cli-hint', 'p');
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
        });
        counter.textContent = `Step ${index + 1} of ${steps.length}`;
        prev.disabled = index === 0;
        next.disabled = index === steps.length - 1;
    };

    const stopPlaying = () => {
        clearTimeout(timer);
        timer = undefined;
        playing = false;
        play.textContent = 'Play';
        // A step changed by hand is announced; one changing on a timer
        // would talk over the reader, as a carousel's does.
        stepsBox.setAttribute('aria-live', 'polite');
    };

    const scheduleNext = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
            showStep(current + 1);
            if (current === steps.length - 1) stopPlaying();
            else scheduleNext();
        }, HOLD_MS);
    };

    const startPlaying = () => {
        playing = true;
        play.textContent = 'Pause';
        stepsBox.setAttribute('aria-live', 'off');
        // Play on the last step starts over.
        if (current === steps.length - 1) showStep(0);
        scheduleNext();
    };

    const applyChoice = () => {
        for (const radio of senderRadios) radio.checked = radio.value === choice.sender;
        for (const radio of contentRadios) radio.checked = radio.value === choice.content;
        const cli = choice.sender === 'cli';
        textRadio.disabled = cli;
        hint.toggleAttribute('hidden', !cli);
        if (cli) textRadio.setAttribute('aria-describedby', hint.id);
        else textRadio.removeAttribute('aria-describedby');
        for (const part of /** @type {HTMLElement[]} */ (Array.from(root.querySelectorAll('[data-show]')))) {
            const [name, value] = (part.dataset.show ?? '').split(':');
            part.toggleAttribute('hidden', choice[/** @type {keyof Choice} */ (name)] !== value);
        }
    };

    const onSwitch = () => {
        const sender = senderRadios.find((radio) => radio.checked)?.value;
        const content = contentRadios.find((radio) => radio.checked)?.value;
        choice = choiceFrom(`?sender=${sender}&content=${content}`);
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
    play.addEventListener('click', () => (playing ? stopPlaying() : startPlaying()));

    // A link to a step (#step-release) opens it, here as on load.
    window.addEventListener('hashchange', () => {
        const index = stepNamedBy(window.location.hash);
        if (index === -1) return;
        stopPlaying();
        showStep(index);
    });

    // Don't advance in a background tab, where nobody is reading.
    root.addEventListener('visibilitychange', () => {
        if (root.hidden && playing) stopPlaying();
    });

    // The controls only work with this script, so they appear with it.
    for (const control of [prev, play, next]) control.hidden = false;
    applyChoice();
    showStep(current);
}
