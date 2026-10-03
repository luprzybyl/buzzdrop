# Frontend ideas

Follow-ups left over from the PR #125 review work (branch `new-looks`).

## Next up: browser smoke test

No test executes any browser JavaScript. `node --check` only proves the files parse, and pytest renders templates without running JS. Until real frontend tests exist, click through the paths changed in this PR:

- [ ] **Composer tabs:** click both tabs, then use ArrowLeft/ArrowRight/Home/End. Panels should swap and the share button should relabel. (Largest behavioural change in the batch.)
- [ ] **Dropzone:** select a valid file, then drop a disallowed one. The inline error should appear and nothing should stay queued.
- [ ] **Hero walkthrough:** press pause. It should stop and stay stopped when the pointer leaves.
- [ ] **Success page:** copy both links. The flash should appear, and a double-click shouldn't leave it stuck.

## Smaller items, most useful first

1. **CI guard for `app.css` drift.** Add a workflow step:
   ```bash
   npm run build:css && git diff --exit-code static/css/app.css
   ```
   The committed stylesheet has already drifted from its sources once, and it will happen again without a check.
2. **The four remaining `alert()` calls** in `static/js/main.js` (lines 141, 156, 165 on the upload path, 315 for a missing text or password). Move them to the non-blocking inline-region pattern that's already used in three places. Raised as a non-blocking nitpick in the PR #125 review.
3. **`aria-pressed` on the "Show" password toggle** (`templates/success.html:48`). It's the last loose a11y end on that page.

## Plan: thorough frontend testing

Scope is the frontend only. The backend already has 141 pytest tests.

### Obstacles

1. **Top-level DOM side effects.** `main.js` and `hero-flow.js` load as `type="module"`, so they can be imported, but they touch `document` at import time. For example, `main.js:10` parses `#allowed-extensions-json` when it loads, so importing it in bare Node throws. `success.js` is a classic script with the same issue.
2. **Nothing is exported.** There's no handle on `rejectFile`, `selectShareMode` or the pause state, so tests have to drive behaviour through real DOM events. That's the right approach for these regressions anyway.

### What's needed

- **`jsdom`** (or `happy-dom`) as a devDependency, because Node's test runner has no DOM.
- **A fixture helper** in `tests/js/` that builds the minimal markup each script needs and sets globals before a dynamic `await import()`.
- **Stubs** for `window.matchMedia` (hero-flow reads `prefers-reduced-motion`) and `DataTransfer` (`main.js` builds one on the accept path).
- **Ideally, an `init()` export per script** instead of wiring things up at the top level, so the logic that decides is separate from the logic that binds events. This refactor makes all three scripts testable without depending on import order.

### Tests by area

| Area | Difficulty | Notes |
|---|---|---|
| Tabs | easy | Fixture + `keydown` ArrowRight/Home/End; assert `aria-selected`, `tabIndex`, panel `display`. No stubs needed. |
| Dropzone rejection | medium | Needs a `DataTransfer` stub. jsdom resists setting `input.files`, but the rejection path only needs `input.value = ''`, so that regression is testable even if the accept path isn't. |
| Walkthrough pause | medium | Needs a `matchMedia` stub plus fake timers (`mock.timers` in `node:test`) to assert the walkthrough doesn't advance while paused. |

### Why jsdom rather than pure-function extraction

The existing `shared-files.mjs` pattern (pure functions tested in bare Node) is cheaper, but it would have caught none of the bugs fixed in this PR: the stale `fileField.files`, the span wiped by `textContent`, and the swallowed clipboard rejection. All of them were DOM side-effect bugs. Extracting pure predicates would produce green tests with no real protection.

### Heavier alternative

Run Playwright against a live Flask test server. It would cover rendering, SRI and the real clipboard, so it's the most faithful option, but it's a much bigger lift and a second test stack to maintain.

### Suggested starting point

Add `jsdom` and write the tabs test first. Tabs are the newest and most intricate logic, need no stubs, and the fixture helper built for them can be reused by the other two tests.
