# Tabs and navigation

List before opening when an existing signed-in tab may be useful. Track tabs created by the task and close only those tabs.

```js
let tabs = await browser.tabs.list();
let tab = tabs.find(value => value.url.startsWith("https://example.com/"));
if (!tab) tab = await browser.tabs.open("https://example.com/", { waitUntil: "domcontentloaded" });
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

## Existing versus task-created tabs

Maintain explicit ownership in the Node session. Reusing an existing tab does not make it task-owned. Closing it can destroy user or previous-task state.

```js
const taskTabs = new Set();
const created = await browser.tabs.open("about:blank");
taskTabs.add(created.id);
```

The tab initially selected by a user, coordinator, or benchmark is the task entry point, not necessarily the only task tab. If an authorized click opens a product editor, authentication flow, detail view, or other child tab needed by that task, the new target inherits task ownership. Continue the workflow there after verifying its id and rendered identity. A generic instruction to operate the named starting tab does not forbid these task-created descendants unless the caller explicitly says the workflow must remain in one target.

If an operation can open a popup, capture the baseline before the trigger and compare ids afterwards. Do not assume the popup is last or active:

```js
const before = new Set((await browser.tabs.list()).map(value => value.id));
await opener.click({ write: "none" });
const after = await browser.tabs.list();
const opened = after.filter(value => !before.has(value.id));
for (const child of opened) taskTabs.add(child.id);
```

Inspect each new candidate by id, URL/title, opener context, and fresh AX state before mutating it. Never convert unrelated pre-existing tabs into task-owned tabs merely because they share an origin.

## Navigation operations

- `navigate(url, { waitUntil, timeoutMs, signal })`: replaces the current document.
- `reload(options)`: reloads the current URL.
- `goBack(options)` / `goForward(options)`: traverse browser history.
- `activate(options)`: make a tab visibly active.
- `refresh(options)`: refresh SDK metadata only; it does not reload the page.
- `waitFor({ selector, text, state, timeoutMs, signal })`: wait for an explicit page condition.
- `close(options)`: close that target; use only for task-owned tabs or an explicitly requested close.

Navigation methods update `tab.url`, `tab.title`, and `tab.active` through `refresh()`. They do not update local frame, realm, AX, element, screenshot, or resource objects held elsewhere.

## SPA transitions

A client-side route change can keep the same top-level document while replacing most interactive nodes. Old AX refs and element handles may still be attached or may become stale; neither means they still represent the user's current intent. Present a new state after a meaningful route or component transition.

## Cleanup

Close only ids in the task-owned set:

```js
for (const id of taskTabs) {
  const owned = await browser.tabs.get(id).catch(() => null);
  if (owned) await owned.close();
}
```

Then disconnect the Agent client. Leaving the fixed-profile Chrome running is expected.
