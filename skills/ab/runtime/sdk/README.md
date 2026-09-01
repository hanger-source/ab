# AB

`@hanger-source/ab` is the Node.js ESM SDK for AB's persistent local Chrome runtime.

```js
import { connect } from "@hanger-source/ab/agent";

const browser = await connect();
const tabs = await browser.tabs.list();
const tab = tabs[0] ?? await browser.tabs.open("https://example.com/");
const state = await tab.ax.write("state");
await tab.playwright.getByRole("button", { name: "Continue", exact: true }).click();
```

Import `@hanger-source/ab` for the explicit Core SDK and `@hanger-source/ab/agent` for Agent presentation and short-ref ergonomics. Both connect to the same version-matched Rust runtime and fixed AB Chrome profile. The package does not require Playwright, an extension, a lifecycle CLI, or an API key.

The repository uses Bun for development and packaging. Published consumers use Node.js 20 or newer.
