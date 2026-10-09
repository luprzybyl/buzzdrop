// Page driver for the confirm page: the one-time "Proceed" step before the
// share is downloaded (docs/frontend-test-strategy.md §7a).
import { initConfirmDownload } from '../../../../static/js/pages/confirm-download/confirm-download-page.js';
import { addressOf, openPage } from './page.js';

export { screen } from './page.js';

/** The share the fixture was rendered for. */
export const SHARE_PATH = '/view/00000000-0000-4000-8000-0000000000f1';

/**
 * Open the confirm page the way a share link lands on it.
 * @param {import('./page.js').AddressOptions} [link] - the share link
 */
export function openConfirmPage(link = {}) {
    const page = openPage('confirm_download--file', { path: addressOf(SHARE_PATH, link) });
    initConfirmDownload(page.window.document, {});
    return {
        url: page.url,
        historyLength: page.historyLength,
        /**
         * Press Proceed. Returns where the confirm POST goes; the fragment on
         * it is what carries the password to the view page.
         * @returns {Promise<string>}
         */
        async proceedToView() {
            await page.user.click(page.screen.getByRole('button', { name: 'Proceed to download' }));
            const submitted = page.formsSubmitted();
            if (submitted.length !== 1) throw new Error(`Proceed sent ${submitted.length} forms, not one`);
            return submitted[0].action;
        },
    };
}
