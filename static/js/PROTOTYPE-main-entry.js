// PROTOTYPE — what main.js would shrink to. The template's
// <script type="module" src="js/main.js" integrity=…> tag stays as is; the
// page logic moves to a side-effect-free module that tests import directly.
import { initIndexPage, browserDeps } from './PROTOTYPE-index-page.mjs';

initIndexPage(document, browserDeps());
