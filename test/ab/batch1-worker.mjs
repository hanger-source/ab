import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { connect } from "../../sdk/ts/src/index.ts";

const mode = process.argv[2];
const browser = await connect();

try {
  if (mode === "identity") {
    await delay(750);
    console.log(JSON.stringify({ identity: browser.identity }));
  } else if (mode === "create") {
    assert(process.env.AB_TEST_URL, "AB_TEST_URL is required");
    const tab = await browser.tabs.open();
    await tab.navigate(process.env.AB_TEST_URL, { waitUntil: "load" });
    const cdp = await tab.cdp();
    const evaluated = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        localStorage.setItem("ab-batch-1", "persisted-across-processes");
        return { title: document.title, value: localStorage.getItem("ab-batch-1") };
      })()`,
      returnByValue: true,
    });
    const screenshot = await tab.screenshot();
    console.log(JSON.stringify({
      identity: browser.identity,
      tab: { id: tab.id, title: tab.title, url: tab.url },
      evaluated: evaluated.result.value,
      screenshot: {
        bytes: screenshot.bytes,
        viewportId: screenshot.viewportId,
        width: screenshot.width,
        height: screenshot.height,
      },
    }));
  } else if (mode === "verify") {
    assert(process.env.AB_TEST_TAB_ID, "AB_TEST_TAB_ID is required");
    const tab = await browser.tabs.get(process.env.AB_TEST_TAB_ID);
    const cdp = await tab.cdp();
    const evaluated = await cdp.send("Runtime.evaluate", {
      expression: `({ title: document.title, value: localStorage.getItem("ab-batch-1") })`,
      returnByValue: true,
    });
    console.log(JSON.stringify({
      identity: browser.identity,
      tab: { id: tab.id, title: tab.title, url: tab.url },
      evaluated: evaluated.result.value,
    }));
  } else {
    throw new Error(`unknown batch1 worker mode: ${mode}`);
  }
} finally {
  await browser.disconnect();
}
