// Page driver for the public "How it works" page: the share flow stepped
// through one step at a time, under two switches, the sender and what is
// sent (docs/frontend-test-strategy.md §7a). The page sends no requests.
import { within } from '@testing-library/dom';
import { initHowItWorks } from '../../../../static/js/pages/how-it-works/how-it-works-page.js';
import { openPage } from './page.js';

export { screen } from './page.js';

/**
 * The page's own names for the switches' options.
 * @typedef {'Web app' | 'buzz CLI'} Sender
 * @typedef {'File' | 'Text'} Content
 */

/**
 * @typedef {object} HowItWorksOptions
 * @property {string} [path] - the address, e.g. '/how-it-works?sender=cli'
 * @property {boolean} [reducedMotion]
 */

/**
 * Open the page as anyone: it needs no login.
 * @param {HowItWorksOptions} [options]
 */
export function openHowItWorks({ path = '/how-it-works', reducedMotion = false } = {}) {
    const page = openPage('how_it_works--default', { path, reducedMotion });
    initHowItWorks(page.window.document, {});
    const { screen, user } = page;
    /** @param {string} name */
    const press = (name) => user.click(screen.getByRole('button', { name }));
    return {
        url: page.url,
        nextStep: () => press('Next'),
        previousStep: () => press('Previous'),
        play: () => press('Play'),
        pause: () => press('Pause'),
        /** @param {string | RegExp} title - the step's title, as the step list shows it */
        goToStep: (title) => user.click(
            within(screen.getByRole('navigation', { name: 'Steps' })).getByRole('button', { name: title })),
        /**
         * Follow an in-page link, e.g. '#step-release'.
         * @param {string} hash
         */
        followLinkTo: async (hash) => {
            page.window.location.hash = hash;
            await new Promise((resolve) => page.window.setTimeout(resolve, 0));
        },
        /** @param {Sender} sender */
        sendFrom: (sender) => user.click(screen.getByRole('radio', { name: sender })),
        /** @param {Content} content */
        send: (content) => user.click(screen.getByRole('radio', { name: content })),
    };
}
