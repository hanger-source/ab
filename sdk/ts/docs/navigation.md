# Navigation, readiness, and waits

Browser lifecycle readiness and application readiness are different facts. `domcontentloaded` proves that the new document parsed; `load` proves its load event fired. Neither proves that a SPA finished rendering, data loaded, authentication succeeded, or a submitted operation completed.

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

For UI state with changing structure, repeatedly take bounded AX states and inspect their identity rather than repeatedly guessing selectors. For network or console facts, open the corresponding resource before the triggering action and wait on that resource.

Do not use arbitrary sleep as the primary readiness mechanism. A delay neither proves the expected fact nor distinguishes a slow page from a failed page.

## Actions that may navigate

An action result can report a semantic diff, but the navigation and application result still need observation. A safe sequence is:

```js
await tab.ax.click("e12", { write: "diff", timeoutMs: 15_000 });
await tab.refresh();
await tab.ax.write("state");
```

If the click can open a dialog, download, file chooser, or new tab, open the matching watcher or capture the tab baseline before clicking. Waiting after the action can miss an event or deadlock on a modal dialog.

## New tabs and popups

AB exposes target discovery through `browser.tabs.list()` rather than an implicit popup object:

```js
const before = new Set((await browser.tabs.list()).map(t => t.id));
await trigger.click();
const after = await browser.tabs.list();
const opened = after.filter(t => !before.has(t.id));
```

Do not assume the new tab is last, active, or already loaded. Select it by target id, URL, title, opener context, and a fresh AX observation. A tab opened by an authorized task action belongs to that task's working set and may be the correct place to continue even when only the starting tab was named initially. Track that inherited ownership before later closing it; never operate unrelated pre-existing tabs.

## Timeouts and cancellation

`timeoutMs` bounds a mechanical operation. `AbortSignal` represents caller cancellation. Neither implies rollback.

If a read times out, gather a new fact or report the missing readiness condition. If a mutation returns `outcome_unknown`, reconnect or re-observe before retrying; the first dispatch may have succeeded.
