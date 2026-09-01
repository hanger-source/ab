import assert from "node:assert/strict";

const clientPath = requiredEnv("AB_SKILL_CLIENT");
const { connect } = await import(clientPath);

let taskTab;
const presented = [];
const agent = await connect({
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
    assert.equal(agent.core, undefined);
    taskTab = await agent.tabs.open("data:text/html," + encodeURIComponent(`
      <title>AB Skill client</title>
      <label>Email <input aria-label="Email"></label>
      <button onclick="result.textContent = 'Saved: ' + document.querySelector('input').value">Continue</button>
      <button onclick="result.textContent = 'Silent action completed'">Silent action</button>
      <output id="result"></output>
    `));
    assert.equal(taskTab.core, undefined);

    assert.throws(
      () => taskTab.evaluate(() => document.title),
      (error) => error?.kind === "documentation_required"
        && error?.details?.topic === "evaluate",
    );
    await agent.documentation("evaluate");
    const documentTitle = await taskTab.evaluate(() => document.title);
    assert.equal(documentTitle, "AB Skill client");

    await taskTab.ax.write("state", { mode: "interactive" });
    const initialAxPresentations = presented.filter((value) => value.kind === "ax").length;
    await taskTab.getByLabel("Email").fill("agent@example.com");
    const afterFillPresentations = presented.filter((value) => value.kind === "ax");
    assert.equal(afterFillPresentations.length, initialAxPresentations + 1);
    assert.match(afterFillPresentations.at(-1).text, /Email/);
    await taskTab.getByRole("button", { name: "Continue", exact: true }).click();
    const afterClickPresentations = presented.filter((value) => value.kind === "ax");
    assert.equal(afterClickPresentations.length, initialAxPresentations + 2);
    assert.match(afterClickPresentations.at(-1).text, /Saved: agent@example.com/);
    assert.notEqual(afterClickPresentations.at(-1).observationId, afterFillPresentations.at(-1).observationId);
    assert.equal(
      await taskTab.getByText("Saved: agent@example.com", { exact: true }).textContent(),
      "Saved: agent@example.com",
    );

    const beforeSilentPresentations = presented.filter((value) => value.kind === "ax").length;
    const silentResult = await taskTab.getByRole("button", {
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
      await taskTab.getByText("Silent action completed", { exact: true }).textContent(),
      "Silent action completed",
    );

    const beforeWaitPresentations = presented.filter((value) => value.kind === "ax").length;
    await taskTab.evaluate(() => {
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
    await taskTab.getByRole("option", { name: "Delayed semantic option", exact: true }).waitFor({
      state: "visible",
      timeoutMs: 2_000,
    });
    const afterWaitPresentations = presented.filter((value) => value.kind === "ax");
    assert.equal(afterWaitPresentations.length, beforeWaitPresentations + 1);
    assert.match(afterWaitPresentations.at(-1).text, /Delayed semantic option/);

    await agent.documentation("screenshot");
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
      daemonId: agent.identity.daemonId,
      documentTitle,
      result: "Saved: agent@example.com",
      agentLocatorPresentations: afterClickPresentations.length - initialAxPresentations,
      silentActionObservation: silentResult.observationOutcome.status,
      agentLocatorWaitPresentation: "Delayed semantic option",
      documentationGate: "evaluate",
      screenshotMetadata: "top-level-and-artifact-aligned",
    }, null, 2));
} finally {
  await taskTab?.close().catch(() => undefined);
  await agent.disconnect();
}

function requiredEnv(name) {
  const value = process.env[name];
  assert(value, `${name} is required`);
  return value;
}
