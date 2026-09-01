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
    assert.equal(afterFillPresentations.length, initialAxPresentations + 1);
    assert.match(afterFillPresentations.at(-1).text, /Email/);
    assert.equal(fillResult.observation.id, afterFillPresentations.at(-1).observationId);
    assert.equal(initialState.disposed, true);
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
    }).domInvoke("click", { write: "none" });
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
    }).click({ write: "none" });
    assert.equal(silentNavigationResult.navigation.changed, true);
    assert.match(silentNavigationResult.navigation.afterUrl, /#silent-navigation$/);
    assert.match(taskTab.url, /#silent-navigation$/);
    assert.deepEqual(silentNavigationResult.observationOutcome, { status: "notRequested" });
    assert.equal(silentNavigationResult.observation, null);
    assert.equal(
      presented.filter((value) => value.kind === "ax").length,
      beforeSilentNavigationPresentations,
    );

    await taskTab.playwright.getByRole("button", {
      name: "Navigate action",
      exact: true,
    }).click();
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
    assert.equal(afterWaitPresentations.length, beforeWaitPresentations + 1);
    assert.match(afterWaitPresentations.at(-1).text, /Delayed semantic option/);

    const presentedBeforeGets = await taskTab.ax.write("state", { mode: "interactive" });
    const silentRef = presentedBeforeGets.refs().find((ref) => ref.name === "Silent action");
    assert(silentRef);
    const retainedOne = await taskTab.ax.get("state", { mode: "interactive" });
    const retainedTwo = await taskTab.ax.get("state", { mode: "interactive" });
    assert(taskTab.ax.liveObservations >= 3);
    await taskTab.ax.click(silentRef.id, { write: "none" });

    const rejectedState = await taskTab.ax.get("state", { mode: "interactive" });
    rejectNextAxPresentation = true;
    await assert.rejects(
      taskTab.ax.write(rejectedState),
      /intentional AX presentation rejection/,
    );
    assert.equal(rejectedState.disposed, true);
    assert.equal(presentedBeforeGets.disposed, false);
    await taskTab.ax.click(silentRef.id, { write: "none" });

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
