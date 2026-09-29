// --- Landing Hero: animated walkthrough of a Buzzdrop hand-off ---
// Cycles a mock UI through the six stages a drop actually goes through. The
// artwork in each stage is aria-hidden; the captions are real text in an
// ordered list, so assistive tech reads the whole sequence regardless of which
// stage happens to be on screen.

const stage = document.getElementById('flow-stage');

if (stage) {
    const steps = Array.from(stage.querySelectorAll('.flow-step'));
    const dots = Array.from(stage.querySelectorAll('.flow-dot'));
    // Each stage gets as long as its caption needs to be read.
    const HOLD_MS = [4320, 3840, 3480, 3960, 3720, 5040];
    const DEFAULT_HOLD_MS = 3840;

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let current = 0;
    let timer = null;

    const render = (index) => {
        current = index;
        stage.dataset.step = String(index);
        steps.forEach((step, i) => step.classList.toggle('is-active', i === index));
        dots.forEach((dot, i) => {
            dot.classList.toggle('is-active', i === index);
            dot.classList.toggle('is-done', i < index);
        });
    };

    const stop = () => {
        clearTimeout(timer);
        timer = null;
    };

    const play = () => {
        stop();
        // Reduced motion shows every stage at once instead of auto-advancing;
        // see the prefers-reduced-motion block in the stylesheet.
        if (reduceMotion.matches || document.hidden) return;
        timer = setTimeout(() => {
            render((current + 1) % steps.length);
            play();
        }, HOLD_MS[current] ?? DEFAULT_HOLD_MS);
    };

    render(0);
    play();

    // Let people linger on a stage they are still reading.
    stage.addEventListener('mouseenter', stop);
    stage.addEventListener('mouseleave', play);

    // Don't burn frames in a background tab.
    document.addEventListener('visibilitychange', () => (document.hidden ? stop() : play()));

    reduceMotion.addEventListener('change', () => {
        if (reduceMotion.matches) {
            stop();
        } else {
            play();
        }
    });
}
