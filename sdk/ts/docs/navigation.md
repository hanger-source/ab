# Navigation, readiness, and waits

Browser lifecycle readiness and application readiness are different facts. `domcontentloaded` proves that the new document parsed; `load` proves its load event fired. Neither proves that a SPA finished rendering, data loaded, authentication succeeded, or a submitted operation completed.

Action completion and application readiness are also different facts. Agent actions record action-owned navigation and dialog facts but do not wait for source-page XHR/Fetch, render settlement, or AX capture. Core callers can deliberately request a bounded post-action observation transaction, but that still does not replace an explicit wait for the business fact the next decision needs.

## Navigate deliberately

```js
await tab.goto("https://example.com/orders", {
  waitUntil: "domcontentloaded",
  timeoutMs: 30_000,
});
await tab.ax.write("state");
```

Use `waitUntil: "none"` only when another explicit signal owns readiness. After navigation, discard old AX refs, element handles, frames, realms, and screenshot coordinates unless their API explicitly proves they remain current.

`reload()`, `goBack()`, and `goForward()` refresh tab metadata after dispatch. Observe again before acting.

## Wait for the fact that matters

For stable DOM facts:

```js
await tab.playwright.waitFor({ text: "Ready", state: "visible", timeoutMs: 20_000 });
await tab.playwright.getByRole("heading", { name: "Ready", exact: true }).waitFor({
  state: "visible",
  timeoutMs: 20_000,
});
```

Both forms execute through Rust's SelectorEngine in the main frame; they do not call page-world `querySelector`. Locator waits keep the Locator's explicit frame scope. States are `attached`, `detached`, `visible`, and `hidden`; `hidden` also succeeds after detachment.

For URL and document lifecycle facts:

```js
await tab.playwright.waitForURL("/orders/1042", { timeoutMs: 20_000 });
await tab.playwright.waitForLoadState("domcontentloaded", { timeoutMs: 20_000 });
```

`waitForURL()` accepts a literal substring or a `*` wildcard pattern. `waitForLoadState()` accepts `"domcontentloaded"` or `"load"`. These waits do not capture or present AX state and do not mean network idle or business completion.

`waitForLoadState()` observes the document that is current when the call reaches the Runtime. Do not place it by itself after a click that might start a new-document navigation: the old document may already satisfy `"load"`. When the destination URL is distinct, wait for that URL first and then wait for its load state. AB does not currently expose a race-free `expectNavigation(action)` primitive for same-URL reloads or events that must be armed before the action; do not simulate one with a fixed sleep or claim that an after-action load check cannot race.

For UI state with changing structure, repeatedly take bounded AX states and inspect their identity rather than repeatedly guessing selectors. For network or console facts, open the corresponding resource before the triggering action and wait on that resource.

Do not use arbitrary sleep as the primary readiness mechanism. A delay neither proves the expected fact nor distinguishes a slow page from a failed page.

## Actions that may navigate

An action result reports dispatch and immediate browser facts. Select the postcondition and observation separately:

```js
await tab.ax.click("e12", { timeoutMs: 15_000 });
await tab.playwright.waitForURL("/orders/", { timeoutMs: 15_000 });
await tab.playwright.waitForLoadState("domcontentloaded", { timeoutMs: 15_000 });
await tab.ax.write("state");
```

If the click can open a dialog, download, file chooser, or new tab, open the matching watcher before clicking. Waiting after the action can miss an event or deadlock on a modal dialog.

## New tabs and popups

Agent code uses the opener-scoped `expectPopup()` composition:

```js
const child = await tab.expectPopup(
  () => trigger.click(),
  { timeoutMs: 10_000 },
);
```

The watcher is established before the action and only accepts a ready page target whose exact opener is `tab`. The child inherits the opener's mutation lease. `expectPopup()` does not prove application readiness; verify its URL/title and take a fresh AX observation before the next decision.

Core orchestration can use `watchPopups()`/`waitForPopup()` directly. Do not assume the new tab is last or active, and do not reconstruct this expectation with a fixed sleep or immediate `tabs.list()` diff.

## Timeouts and cancellation

`timeoutMs` bounds a mechanical operation. `AbortSignal` represents caller cancellation. Neither implies rollback.

If a read times out, gather a new fact or report the missing readiness condition. If a mutation returns `outcome_unknown`, reconnect or re-observe before retrying; the first dispatch may have succeeded.
