import assert from "node:assert/strict";

const clientPath = requiredEnv("AB_SKILL_CLIENT");
const { connect } = await import(clientPath);

let taskTab;
const presented = [];
const browser = await connect({
    presenter: {
      presentText(value) {
        presented.push(value);
      },
      presentImage() {
        throw new Error("this scenario does not present images");
      },
    },
});
try {
    assert.equal(browser.core, undefined);
    taskTab = await browser.tabs.open("data:text/html," + encodeURIComponent(`
      <title>AB Skill client</title>
      <label>Email <input aria-label="Email"></label>
      <button onclick="result.textContent = 'Saved: ' + document.querySelector('input').value">Continue</button>
      <button onclick="result.textContent = 'Silent action completed'">Silent action</button>
      <output id="result"></output>
    `));
    assert.equal(taskTab.core, undefined);
    assert.deepEqual(
      Object.getOwnPropertyNames(taskTab).sort(),
      ["ax", "cua", "dev", "playwright", "resources"],
    );
    assert.deepEqual(
      ["navigate", "locator", "getByRole", "evaluate", "frames", "cdp", "observeNetwork"]
        .filter((member) => taskTab[member] !== undefined),
      [],
    );
    assert.equal(typeof taskTab.goto, "function");
    assert.equal(typeof taskTab.playwright.getByRole, "function");
    assert.equal(typeof taskTab.resources.network, "function");
    assert.equal(typeof taskTab.dev.evaluate, "function");

    assert.throws(
      () => taskTab.dev.evaluate(() => document.title),
      (error) => error?.kind === "documentation_required"
        && error?.details?.topic === "evaluate",
    );
    await browser.documentation("evaluate");
    const documentTitle = await taskTab.dev.evaluate(() => document.title);
    assert.equal(documentTitle, "AB Skill client");

    await taskTab.ax.write("state", { mode: "interactive" });
    const initialAxPresentations = presented.filter((value) => value.kind === "ax").length;
    await taskTab.playwright.getByLabel("Email").fill("agent@example.com");
    const afterFillPresentations = presented.filter((value) => value.kind === "ax");
    assert.equal(afterFillPresentations.length, initialAxPresentations + 1);
    assert.match(afterFillPresentations.at(-1).text, /Email/);
    await taskTab.playwright.getByRole("button", { name: "Continue", exact: true }).click();
    const afterClickPresentations = presented.filter((value) => value.kind === "ax");
    assert.equal(afterClickPresentations.length, initialAxPresentations + 2);
    assert.match(afterClickPresentations.at(-1).text, /Saved: agent@example.com/);
    assert.notEqual(afterClickPresentations.at(-1).observationId, afterFillPresentations.at(-1).observationId);
    assert.equal(
      await taskTab.playwright.getByText("Saved: agent@example.com", { exact: true }).textContent(),
      "Saved: agent@example.com",
    );

    const beforeSilentPresentations = presented.filter((value) => value.kind === "ax").length;
    const silentResult = await taskTab.playwright.getByRole("button", {
      name: "Silent action",
      exact: true,
    }).click({ write: "none" });
    assert.deepEqual(silentResult.observationOutcome, { status: "notRequested" });
    assert.equal(silentResult.observation, null);
    assert.equal(
      presented.filter((value) => value.kind === "ax").length,
      beforeSilentPresentations,
    );
    assert.equal(
      await taskTab.playwright.getByText("Silent action completed", { exact: true }).textContent(),
      "Silent action completed",
    );

    const beforeWaitPresentations = presented.filter((value) => value.kind === "ax").length;
    await taskTab.dev.evaluate(() => {
      setTimeout(() => {
        const listbox = document.createElement("div");
        listbox.setAttribute("role", "listbox");
        const option = document.createElement("div");
        option.setAttribute("role", "option");
        option.textContent = "Delayed semantic option";
        listbox.append(option);
        document.body.append(listbox);
      }, 150);
    });
    await taskTab.playwright.getByRole("option", { name: "Delayed semantic option", exact: true }).waitFor({
      state: "visible",
      timeoutMs: 2_000,
    });
    const afterWaitPresentations = presented.filter((value) => value.kind === "ax");
    assert.equal(afterWaitPresentations.length, beforeWaitPresentations + 1);
    assert.match(afterWaitPresentations.at(-1).text, /Delayed semantic option/);

    await browser.documentation("screenshot");
    const screenshot = await taskTab.ax.get("screenshot");
    try {
      assert.equal(screenshot.id, screenshot.artifact.id);
      assert.equal(screenshot.sha256, screenshot.artifact.sha256);
      assert.equal(screenshot.bytes, (await screenshot.read()).byteLength);
    } finally {
      await screenshot.dispose();
    }

    const state = presented.find((value) => value.kind === "ax");
    const documentation = presented.find((value) => value.kind === "documentation");
    assert(state);
    assert(documentation);
    assert.equal(state.untrusted, true);
    assert.equal(documentation.untrusted, false);

    console.log(JSON.stringify({
      clientPath,
      daemonId: browser.identity.daemonId,
      documentTitle,
      result: "Saved: agent@example.com",
      agentLocatorPresentations: afterClickPresentations.length - initialAxPresentations,
      silentActionObservation: silentResult.observationOutcome.status,
      agentLocatorWaitPresentation: "Delayed semantic option",
      documentationGate: "evaluate",
      screenshotMetadata: "top-level-and-artifact-aligned",
      tabSurface: Object.getOwnPropertyNames(taskTab).sort(),
    }, null, 2));
} finally {
  await taskTab?.close().catch(() => undefined);
  await browser.disconnect();
}

function requiredEnv(name) {
  const value = process.env[name];
  assert(value, `${name} is required`);
  return value;
}
