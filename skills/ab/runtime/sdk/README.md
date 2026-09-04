# AB

`@hanger-source/ab` is the Node.js ESM SDK for AB's persistent local Chrome runtime.

```js
import { connect } from "@hanger-source/ab/agent";

const browser = await connect();
const tabs = await browser.tabs.list();
const tab = tabs[0]
  ? await browser.tabs.acquire(tabs[0].id)
  : await browser.tabs.open("https://example.com/");
const state = await tab.ax.write("state");
await tab.playwright.getByRole("button", { name: "Continue", exact: true }).click();
```

Import `@hanger-source/ab` for the explicit Core SDK and `@hanger-source/ab/agent` for Agent presentation and short-ref ergonomics. Both use the same version-matched Rust runtime. The default managed provider owns AB's fixed Chrome profile; an explicit external provider connects a supplied browser-level DevTools WebSocket endpoint:

```js
const browser = await connect({
  provider: { kind: "external", webSocketUrl },
});
```

External tab discovery does not attach every user tab. Acquire the exact target before page observation or mutation; disconnect detaches acquired sessions without closing user tabs or Chrome. The package does not require Playwright, an extension, a lifecycle CLI, or an API key.

All clients may discover and observe shared tabs. `tabs.open()` owns a new target; `tabs.acquire()` is required before mutating an existing available target, and conflicts fail closed. Use Agent `tab.expectPopup(() => action())` or Core `watchPopups()` to arm opener-scoped popup observation before an action.

The repository uses Bun for development and packaging. Published consumers use Node.js 20 or newer.
