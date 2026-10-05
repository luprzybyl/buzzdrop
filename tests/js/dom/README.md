# DOM tests

Vitest + happy-dom, one page module against its rendered template fixture
(`tests/js/fixtures/html/`). The spec is `docs/frontend-test-strategy.md`.

- **Import the page module** (`static/js/<page>-page.js`), never the entry script.
- **Drive it through `browserView(page)`** (`support/dom-fixture.js`) and look
  elements up with `required()` (`static/js/required.js`), so the tests
  type-check without casts (spec §2–§3).
- **Selector rule:** find elements by `id`, ARIA role, `data-*` attribute or
  visible text — never by Tailwind or other styling classes, so restyling a
  template doesn't break tests. The one exception is a class the page JS itself
  toggles to show state (status-badge classes, `hidden`, …): asserting on that
  class is asserting on behaviour.
