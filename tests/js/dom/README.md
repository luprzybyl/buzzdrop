# DOM tests

Vitest + happy-dom, one page module against its rendered template fixture
(`tests/js/fixtures/html/`). The spec is `docs/frontend-test-strategy.md`.

- **Drive the page through its driver** (`tests/js/support/pages/`, spec §7a):
  open it with `openShare`, `openUploadPage`, `openSuccessPage`, … and act
  through verbs named after what the user does. A test never loads a fixture,
  calls `init<Page>()`, stubs `fetch` or crypto, or dispatches an event itself.
- **Set the situation with options in app terms** (`maxAttempts: 3`,
  `server: 'claimed'`, `link: 'one-click'`), never with HTTP statuses.
- **Find elements as a user does** (spec §7b): by role, then label, then text,
  through the `screen` the driver module exports. Never by id, class,
  `data-testid` or selector.
- **Assert on what is perceivable**: `toBeDisabled`, `toBeVisible`,
  `toHaveFocus`, `toHaveAccessibleName`… — not `.disabled`, `.style` or
  `.classList`. If no role-based query can find something, fix the template.
