// Page driver for the success page, where the uploader picks up the link and
// password (docs/frontend-test-strategy.md §7a).
import { initSuccess } from '../../../../static/js/success-page.js';
import { openPage } from './page.js';

export { screen } from './page.js';

/** The share the fixture was rendered for, and the page's address. */
export const SHARE_LINK = 'http://localhost/view/00000000-0000-4000-8000-0000000000f1';
export const PAGE_PATH = '/success/00000000-0000-4000-8000-0000000000f1';

/**
 * @typedef {object} SuccessOptions
 * @property {string} [password] - the password the upload handed over in the fragment
 * @property {boolean} [mangledFragment] - a fragment that isn't valid percent-encoding instead
 * @property {string} [query] - a query string on the address, e.g. 'x=1'
 */

/**
 * Open the success page the way a finished upload navigates to it.
 * @param {SuccessOptions} [options]
 */
export function openSuccessPage({ password, mangledFragment = false, query } = {}) {
    const fragment = mangledFragment ? '#%ZZ' : password === undefined ? '' : `#${encodeURIComponent(password)}`;
    const page = openPage('success--file', { path: `${PAGE_PATH}${query ? `?${query}` : ''}${fragment}` });
    initSuccess(page.window.document, {});
    const { screen, user } = page;
    return {
        url: page.url,
        historyLength: page.historyLength,
        clipboardText: page.clipboardText,
        copyShareLink: () => user.click(screen.getByRole('button', { name: 'Copy link' })),
        copyOneClickLink: () => user.click(screen.getByRole('button', { name: 'Copy one-click link' })),
        revealPassword: () => user.click(screen.getByRole('button', { name: 'Show' })),
        hidePassword: () => user.click(screen.getByRole('button', { name: 'Hide' })),
    };
}
