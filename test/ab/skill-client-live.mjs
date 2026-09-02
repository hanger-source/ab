import assert from "node:assert/strict";

const clientPath = requiredEnv("AB_SKILL_CLIENT");
const { connect } = await import(clientPath);

let taskTab;
const presented = [];
let rejectNextAxPresentation = false;
const browser = await connect({
    presenter: {
      presentText(value) {
        if (rejectNextAxPresentation && value.kind === "ax") {
          rejectNextAxPresentation = false;
          throw new Error("intentional AX presentation rejection");
        }
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
      <label>Short name <input aria-label="Short name" maxlength="15"></label>
      <button onclick="result.textContent = 'Saved: ' + document.querySelector('input').value">Continue</button>
      <button onclick="result.textContent = 'Silent action completed'">Silent action</button>
      <button onclick="history.pushState({}, '', '#silent-navigation'); result.textContent = 'Silent navigation completed'">Silent navigate action</button>
      <button onclick="history.pushState({}, '', '#after-action'); result.textContent = 'Navigated action completed'">Navigate action</button>
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

    const initialState = await taskTab.ax.write("state", { mode: "interactive" });
    assert.equal(
      initialState.id,
      presented.filter((value) => value.kind === "ax").at(-1).observationId,
    );
    const initialAxPresentations = presented.filter((value) => value.kind === "ax").length;
    const fillResult = await taskTab.playwright.getByLabel("Email").fill("agent@example.com");
    const afterFillPresentations = presented.filter((value) => value.kind === "ax");
    assert.equal(afterFillPresentations.length, initialAxPresentations);
    assert.deepEqual(fillResult.observationOutcome, { status: "notRequested" });
    assert.equal(fillResult.observation, null);
    assert.equal(initialState.disposed, false);
    await assert.rejects(
      taskTab.ax.write("diff", { maxChars: 8_000 }),
      /inherits the presented observation capture shape and only accepts timeoutMs or signal/,
    );
    const afterFillState = await taskTab.ax.write("diff");
    assert(afterFillState.diff);
    assert.equal(afterFillState.sources.surface, initialState.sources.surface);
    assert.deepEqual(
      afterFillState.sources.surfaceIdentity,
      initialState.sources.surfaceIdentity,
      "explicit diff did not inherit the presented observation surface",
    );
    assert.equal(initialState.disposed, true);
    await taskTab.playwright.getByRole("button", { name: "Continue", exact: true }).click();
    const pageBody = taskTab.playwright.locator("body");
    assert.equal(
      await pageBody.getByRole("button", { name: "Continue", exact: true }).count(),
      1,
    );
    assert.equal(
      await pageBody.getByText("Saved: agent@example.com", { exact: true }).count(),
      1,
    );
    const afterClickPresentations = presented.filter((value) => value.kind === "ax");
    assert.equal(afterClickPresentations.length, initialAxPresentations + 1);
    await taskTab.playwright.getByText("Saved: agent@example.com", { exact: true }).waitFor();
    const afterClickState = await taskTab.ax.write("diff");
    assert.match(afterClickState.text, /Saved: agent@example.com/);
    assert.equal(presented.filter((value) => value.kind === "ax").length, initialAxPresentations + 2);
    assert.equal(
      await taskTab.playwright.getByText("Saved: agent@example.com", { exact: true }).textContent(),
      "Saved: agent@example.com",
    );

    const beforeSilentPresentations = presented.filter((value) => value.kind === "ax").length;
    const silentResult = await taskTab.playwright.getByRole("button", {
      name: "Silent action",
      exact: true,
    }).domInvoke("click");
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

    const beforeSilentNavigationPresentations = presented.filter((value) => value.kind === "ax").length;
    const silentNavigationResult = await taskTab.playwright.getByRole("button", {
      name: "Silent navigate action",
      exact: true,
    }).click();
    await taskTab.playwright.waitForURL("#silent-navigation", { timeoutMs: 2_000 });
    assert.equal(silentNavigationResult.navigation.changed, true);
    assert.match(silentNavigationResult.navigation.afterUrl, /#silent-navigation$/);
    assert.match(taskTab.url, /#silent-navigation$/);
    assert.deepEqual(silentNavigationResult.observationOutcome, { status: "notRequested" });
    assert.equal(silentNavigationResult.observation, null);
    assert.equal(
      presented.filter((value) => value.kind === "ax").length,
      beforeSilentNavigationPresentations,
    );

    const beforeNavigatePresentations = presented.filter((value) => value.kind === "ax").length;
    await taskTab.playwright.getByRole("button", {
      name: "Navigate action",
      exact: true,
    }).click();
    await taskTab.playwright.waitForURL("#after-action", { timeoutMs: 2_000 });
    assert.equal(presented.filter((value) => value.kind === "ax").length, beforeNavigatePresentations);
    await taskTab.ax.write("diff");
    const navigationPresentation = presented.filter((value) => value.kind === "ax").at(-1);
    assert(navigationPresentation);
    assert.match(navigationPresentation.origin, /#after-action$/);
    assert.match(taskTab.url, /#after-action$/);
    assert.match(navigationPresentation.text, /Navigated action completed/);

    const inputWarningCount = presented.filter((value) => value.kind === "action").length;
    const shortened = await taskTab.playwright.getByLabel("Short name").fill("a deliberately overlong value");
    assert.equal(shortened.data.field.matchesRequestedText, false);
    assert.equal(shortened.data.field.inputValue?.length, 15);
    const inputWarnings = presented.filter((value) => value.kind === "action");
    assert.equal(inputWarnings.length, inputWarningCount + 1);
    assert.match(inputWarnings.at(-1).text, /did not retain the requested text exactly/);

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
    assert.equal(afterWaitPresentations.length, beforeWaitPresentations);
    const afterWaitState = await taskTab.ax.write("state");
    assert.match(afterWaitState.text, /Delayed semantic option/);

    await taskTab.playwright.waitForLoadState("domcontentloaded", { timeoutMs: 2_000 });

    await assert.rejects(
      taskTab.playwright.getByRole("button", { name: "Silent action", exact: true }).click({ write: "diff" }),
      /actions do not accept write/,
    );

    const presentedBeforeGets = await taskTab.ax.write("state", { mode: "interactive" });
    const silentRef = presentedBeforeGets.refs().find((ref) => ref.name === "Silent action");
    assert(silentRef);
    const retainedOne = await taskTab.ax.get("state", { mode: "interactive" });
    const retainedTwo = await taskTab.ax.get("state", { mode: "interactive" });
    assert(taskTab.ax.liveObservations >= 3);
    await taskTab.ax.click(silentRef.id);

    const rejectedState = await taskTab.ax.get("state", { mode: "interactive" });
    rejectNextAxPresentation = true;
    await assert.rejects(
      taskTab.ax.write(rejectedState),
      /intentional AX presentation rejection/,
    );
    assert.equal(rejectedState.disposed, true);
    assert.equal(presentedBeforeGets.disposed, false);
    await taskTab.ax.click(silentRef.id);

    await taskTab.ax.dispose();
    assert.equal(taskTab.ax.liveObservations, 0);
    assert.equal(retainedOne.disposed, true);
    assert.equal(retainedTwo.disposed, true);
    const resetState = await taskTab.ax.write("state", { mode: "interactive" });
    assert.equal(taskTab.ax.liveObservations, 1);
    assert.equal(
      resetState.id,
      presented.filter((value) => value.kind === "ax").at(-1).observationId,
    );

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
      agentActionPresentations: 0,
      explicitObservationPresentations: 3,
      silentActionObservation: silentResult.observationOutcome.status,
      agentLocatorWaitPresentation: "none",
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
