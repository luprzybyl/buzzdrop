// The composer's password field: the strength meter, Show/Hide, Generate,
// and the gate every upload passes through. The server never sees the
// password (encryption is client-side), so this gate is the only place a
// weak key can be refused — and it must refuse.

import { assessPassword, generatePassphrase } from '../../lib/passphrase.js';
import { required } from '../../lib/required.js';

/**
 * @typedef {object} PasswordGate
 * @property {HTMLInputElement} input - the password field
 * @property {(password: string) => boolean} accept - whether `password` may
 *   be used; a missing or weak one is refused inline in #password-error,
 *   with the field focused
 */

// Per level: the bar's and the message's colour, and the word the meter
// reports to assistive tech (the colour carries it on screen).
const STRENGTH = {
    weak: { fill: 'pw-fill-weak', text: 'pw-text-weak', label: 'Weak' },
    fair: { fill: 'pw-fill-fair', text: 'pw-text-fair', label: 'Fair' },
    strong: { fill: 'pw-fill-strong', text: 'pw-text-strong', label: 'Strong' },
};

/**
 * Wire up the password field, or return null where the page has none (an
 * anonymous visitor's landing page).
 * @param {Document} root
 * @returns {PasswordGate | null}
 */
export function initPasswordGate(root) {
    const input = /** @type {HTMLInputElement | null} */ (root.getElementById('shared-password'));
    return input && wire(root, input);
}

/**
 * @param {Document} root
 * @param {HTMLInputElement} input
 * @returns {PasswordGate}
 */
function wire(root, input) {
    const generateBtn = required(root, '#generate-password-btn', 'button');
    const toggleBtn = required(root, '#toggle-password-btn', 'button');
    // Copied by the page; the gate only keeps it disabled while there is nothing to copy.
    const copyBtn = required(root, '#copy-password-btn', 'button');
    const strengthRegion = required(root, '#password-strength', 'div');
    const strengthMeter = required(root, '#password-strength-meter', 'div');
    const strengthBar = required(root, '#password-strength-bar', 'div');
    const strengthText = required(root, '#password-strength-text', 'p');
    // Always present: only its text changes, so assistive tech announces
    // every refusal rather than a one-time reveal.
    const refusal = required(root, '#password-error', 'p');

    function updateStrength() {
        const result = assessPassword(input.value);
        if (result.level === 'empty') {
            strengthRegion.hidden = true;
            return;
        }
        strengthRegion.hidden = false;
        const level = STRENGTH[result.level];
        strengthBar.className = `pw-fill ${level.fill}`;
        // Scale ~90 bits to a full bar so "fair" doesn't read as nearly done.
        // The meter holds the fill once, for the bar's width and for
        // assistive tech alike.
        const fill = Math.min(100, Math.round((result.bits / 90) * 100));
        strengthMeter.style.setProperty('--strength-fill', `${fill}%`);
        strengthMeter.setAttribute('aria-valuenow', String(fill));
        strengthMeter.setAttribute('aria-valuetext', level.label);
        strengthText.className = `field-help ${level.text}`;
        strengthText.textContent = result.message;
    }

    /**
     * Mask or reveal the password, keeping the toggle's name in step: it
     * names what pressing it will do.
     * @param {boolean} visible
     */
    function setVisible(visible) {
        input.type = visible ? 'text' : 'password';
        required(toggleBtn, '#toggle-password-label', 'span').textContent = visible ? 'Hide' : 'Show';
        toggleBtn.setAttribute('aria-label', visible ? 'Hide password' : 'Show password');
    }

    /** Show/Hide and Copy have nothing to act on until there is a password. */
    function syncButtons() {
        for (const button of [toggleBtn, copyBtn]) button.disabled = !input.value;
    }

    input.addEventListener('input', () => {
        updateStrength();
        syncButtons();
        // Re-typing clears a stale refusal so the user sees progress.
        refusal.textContent = '';
    });

    toggleBtn.addEventListener('click', () => setVisible(input.type === 'password'));

    generateBtn.addEventListener('click', () => {
        input.value = generatePassphrase();
        // Show the phrase so the sender can read it back on another channel;
        // the success page reveals it again via the URL fragment.
        setVisible(true);
        refusal.textContent = '';
        updateStrength();
        syncButtons();
        input.focus();
    });

    return {
        input,
        accept(password) {
            if (!password) {
                refusal.textContent = 'Enter a password, or press Generate.';
                input.focus();
                return false;
            }
            const result = assessPassword(password);
            if (result.blocked) {
                updateStrength();
                refusal.textContent = `Password rejected: ${result.message}`;
                input.focus();
                return false;
            }
            return true;
        },
    };
}
