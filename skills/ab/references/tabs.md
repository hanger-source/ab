# Tabs and navigation

List before opening when an existing signed-in tab may be useful. Track tabs created by the task and close only those tabs.

```js
let tabs = await browser.tabs.list();
const candidate = tabs.find(value => value.url.startsWith("https://example.com/"));
let tab = candidate
  ? await browser.tabs.acquire(candidate.id)
  : await browser.tabs.open("https://example.com/", { waitUntil: "domcontentloaded" });
```

`tabs.open(url)` creates a tab and, by default, waits for that navigation's `domcontentloaded`. `waitUntil: "load"` waits for the load event; `"none"` deliberately returns after dispatch. `tab.goto()` uses the same options. These waits prove browser lifecycle events, not application success.

`Tab.id` is the Chrome target id and remains stable across navigation. Frames, documents, realms, observations, refs, element handles, screenshots, and resources have narrower identities and can become stale while the tab remains valid.

`Tab.active` is live browser state, not creation order or an SDK-local guess. Rust probes whether the attached document is the visible selected tab when metadata is listed or refreshed; an unresponsive/discarded renderer is reported inactive rather than delaying the whole list indefinitely.

After navigation or a meaningful rerender, take a new observation. Do not reuse coordinates across viewport changes or a ref across document generations.

## Tab selection

Tab array position is not identity. Select with a combination of `id`, URL, title, active state, and a new observation:

```js
tabs = await browser.tabs.list();
const candidates = tabs.filter(t => t.url.startsWith("https://app.example.com/"));
for (const candidate of candidates) {
  await candidate.refresh();
  console.log({ id: candidate.id, title: candidate.title, url: candidate.url, active: candidate.active });
}
```

Do not mutate every matching tab to discover which one is relevant. When metadata is insufficient, inspect one candidate at a time with bounded AX state.

`Tab.title` is Chrome Target discovery metadata. It can lag document state or use a URL-like value for special schemes such as `data:`. Treat it as a selection hint, not proof of `document.title`; when the exact page title is a task fact, load the evaluate topic and read `document.title` from the intended tab.

## Discovery, mutation ownership, and task scope

The persistent Chrome is shared, but mutation authority is not. `tabs.list()` and `tabs.get()` return discovery handles whose `ownership` is relative to this client:

- `available`: no active client holds the target lease;
- `owned`: this client may mutate the target;
- `other`: another active client holds the target lease.

`tabs.open()` atomically owns its new target. To reuse an existing available target, call `tabs.acquire(targetId)` before navigation, activation, evaluate, input, CDP mutation, or close. The same client may acquire it again. An acquire against `other` fails with `target_in_use`; do not wait, retry, steal, or silently switch to another target.

Reads and bounded observations remain possible without a lease so an Agent can identify the right candidate. The Runtime checks every mutation again; a stale local `ownership` field never grants authority.

Target mutation ownership is not user-content ownership. Acquiring an existing tab does not authorize closing it. Maintain a local set only for tabs created by this task:

```js
const createdByTask = new Set();
const created = await browser.tabs.open("about:blank");
createdByTask.add(created.id);
```

The tab initially selected by a user, coordinator, or benchmark is the task entry point, not necessarily the only task tab. If an authorized click opens a product editor, authentication flow, detail view, or other child tab needed by that task, the new target inherits task ownership. Continue the workflow there after verifying its id and rendered identity. A generic instruction to operate the named starting tab does not forbid these task-created descendants unless the caller explicitly says the workflow must remain in one target.

If an operation is expected to open a popup, arm the opener-scoped watcher before the trigger:

```js
await browser.documentation("tabs");
const child = await tab.expectPopup(
  () => tab.playwright.getByRole("link", { name: "Open", exact: true }).click(),
  { timeoutMs: 10_000 },
);
createdByTask.add(child.id);
```

`expectPopup()` subscribes before the action, waits for a ready root page whose exact `openerId` is this tab, and returns that child with the opener's lease already inherited. It does not pick the last, active, or same-origin tab. Inspect its URL/title and fresh AX state before continuing.

The same successfully presented tabs topic unlocks the lower-level Agent resource. Use `const watcher = await tab.resources.popups()` before the action, then `await watcher.waitForPopup()` and dispose it. Do not replace either form with a fixed sleep and before/after tab-list diff; a fast or not-yet-ready target can be missed.

## Navigation operations

- `navigate(url, { waitUntil, timeoutMs, signal })`: replaces the current document.
- `reload(options)`: reloads the current URL.
- `goBack(options)` / `goForward(options)`: traverse browser history.
- `activate(options)`: make a tab visibly active.
- `refresh(options)`: refresh SDK metadata only; it does not reload the page.
- `waitFor({ selector, text, state, timeoutMs, signal })`: wait for an explicit page condition.
- `playwright.waitForURL(pattern, options)`: wait for current target URL to match a substring or `*` wildcard pattern.
- `playwright.waitForLoadState(state, options)`: wait for `domcontentloaded` or `load`; it does not imply application readiness.
- `acquire(options)`: atomically acquire an existing available target for this client.
- `close(options)`: close that target; requires the client lease and separate task/user authorization.

Navigation methods update `tab.url`, `tab.title`, and `tab.active` through `refresh()`. They do not update local frame, realm, AX, element, screenshot, or resource objects held elsewhere.

## SPA transitions

A client-side route change can keep the same top-level document while replacing most interactive nodes. Old AX refs and element handles may still be attached or may become stale; neither means they still represent the user's current intent. Present a new state after a meaningful route or component transition.

## Cleanup

Close only ids in the task-owned set:

```js
for (const id of createdByTask) {
  const owned = await browser.tabs.get(id).catch(() => null);
  if (owned) await owned.close();
}
```

Then disconnect the Agent client. Disconnect releases this client's target leases and server-owned resources while leaving ordinary tabs and the fixed-profile Chrome running.
