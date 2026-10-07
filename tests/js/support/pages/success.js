// Page driver for the success page, where the uploader picks up the link and
// password (docs/frontend-test-strategy.md §7a).
import { initSuccess } from '../../../../static/js/success-page.js';
import { addressOf, openPage } from './page.js';

export { screen } from './page.js';

/** The share the fixture was rendered for, and the page's address. */
export const SHARE_LINK = 'http://localhost/view/00000000-0000-4000-8000-0000000000f1';
export const PAGE_PATH = '/success/00000000-0000-4000-8000-0000000000f1';

/**
 * Open the success page. A finished upload navigates to it with the password
 * in the fragment, as `link: 'one-click'`.
 * @param {import('./page.js').AddressOptions} [address]
 */
export function openSuccessPage(address = {}) {
    const page = openPage('success--file', { path: addressOf(PAGE_PATH, address) });
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
