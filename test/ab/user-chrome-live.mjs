import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

// Opt-in: connects a real personal Chrome and may request consent.
assert.equal(process.env.AB_USER_CHROME_LIVE, "1", "Run via test:ab:user-chrome to opt into the real Chrome experiment");
const exec = promisify(execFile);
const clientPath = process.env.AB_SKILL_CLIENT
  ?? fileURLToPath(new URL("../../skills/ab/scripts/ab-client.mjs", import.meta.url));
const { connect } = await import(clientPath);

if (process.argv.includes("--reconnect")) {
  const browser = await connect({ provider: { kind: "user" }, timeoutMs: 10_000 });
  try {
    assert.equal(browser.identity.chrome.source, "external");
    process.stdout.write(JSON.stringify({ daemonId: browser.identity.daemonId,
      targetIds: (await browser.tabs.list()).map((tab) => tab.id).sort() }));
  } finally {
    await browser.disconnect();
  }
} else {
  const chromeBefore = await chromeProcesses();
  assert(chromeBefore.length > 0, "Open regular Google Chrome before running this experiment");
  await assert.rejects(connect({ provider: { kind: "user" }, signal: AbortSignal.abort() }),
    (error) => error.name === "AbortError");
  const browser = await connect({ provider: { kind: "user" }, timeoutMs: 60_000 });
  let taskTab;
  let originalIds;
  const daemonId = browser.identity.daemonId;
  try {
    assert.equal(browser.identity.chrome.source, "external");
    assert.equal(browser.identity.chrome.pid, null, "AB must not launch or own this Chrome");
    const original = await browser.tabs.list();
    assert(original.length > 0, "Expected existing user tabs");
    originalIds = original.map((tab) => tab.id).sort();
    assert(original.every((tab) => tab.ownership !== "owned"), "Discovery must not acquire user tabs");
    taskTab = await browser.tabs.open("data:text/html," + encodeURIComponent(
      '<title>AB user Chrome connection check</title><button onclick="document.querySelector(\'output\').textContent=\'Connection verified\'">Verify connection</button><output></output>',
    ));
    await browser.documentation("evaluate");
    // Attaching a tab in personal Chrome animates its debugging infobar. Wait
    // for the observed viewport to become quiet; do not weaken AX consistency.
    await taskTab.dev.evaluate(() => new Promise((resolve, reject) => {
      let size = "";
      let changedAt = performance.now();
      let frame;
      const timer = setTimeout(() => {
        cancelAnimationFrame(frame);
        reject(new Error("Chrome viewport did not settle"));
      }, 5_000);
      function sample() {
        const current = `${innerWidth}:${innerHeight}:${devicePixelRatio}`;
        if (current !== size) { size = current; changedAt = performance.now(); }
        if (performance.now() - changedAt >= 200) {
          clearTimeout(timer);
          resolve(size);
        } else {
          frame = requestAnimationFrame(sample);
        }
      }
      sample();
    }));
    await taskTab.ax.write("state");
    await taskTab.playwright.getByRole("button", { name: "Verify connection", exact: true }).click();
    const state = await taskTab.ax.write("state");
    assert.match(state.text, /Connection verified/);
    await taskTab.close();
    taskTab = undefined;
    assert.deepEqual((await browser.tabs.list()).map((tab) => tab.id).sort(), originalIds,
      "The experiment must preserve every original user tab");
  } finally {
    if (taskTab) await taskTab.close();
    await browser.disconnect();
  }
  // A different Node process reconnects without an address or another Chrome.
  const { stdout } = await exec(process.execPath, [fileURLToPath(import.meta.url), "--reconnect"], {
    env: { ...process.env, AB_SKILL_CLIENT: clientPath }, timeout: 20_000,
  });
  const reconnected = JSON.parse(stdout);
  assert.equal(reconnected.daemonId, daemonId, "Reconnect should reuse the same browser connection");
  assert.deepEqual(reconnected.targetIds, originalIds);
  assert.deepEqual(await chromeProcesses(), chromeBefore, "No Chrome process may be started or closed");
  console.log(JSON.stringify({ result: "passed", clientPath, daemonId,
    chromeProcesses: chromeBefore, preservedUserTabs: originalIds.length,
    axAndClick: "passed", crossProcessReconnect: "passed" }));
}

async function chromeProcesses() {
  const { stdout } = await exec("/bin/ps", ["-axo", "pid=,comm="], { timeout: 5_000 });
  return stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    return match?.[2]?.endsWith("/Google Chrome.app/Contents/MacOS/Google Chrome") ? [Number(match[1])] : [];
  }).sort((a, b) => a - b);
}
