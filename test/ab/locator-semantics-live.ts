import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { inspect } from "node:util";
import { fileURLToPath } from "node:url";
import { ABError, connect, type ActionResult } from "../../sdk/ts/src/index.ts";

const socketPath = join(requiredEnv("AB_RUNTIME_DIR"), "browser.sock");
const uploadPath = fileURLToPath(import.meta.url);
const server = http.createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><html><body>
    <button data-testid="save" data-index="0">Save changes</button>
    <button data-testid="save" data-index="1">Save changes</button>
    <span class="visibility">Visible marker</span>
    <span class="visibility" style="display:none">Visible marker</span>
    <label for="email">Email address</label><input id="email" placeholder="Work Email" aria-autocomplete="list">
    <label for="departure">Departure date</label><input id="departure" placeholder="MM/DD/YYYY" readonly>
    <label for="choice">Choice</label><select id="choice"><option value="a">A</option><option value="b">B</option></select>
    <label for="enabled">Enabled</label><input id="enabled" type="checkbox">
    <label for="upload">Upload</label><input id="upload" type="file">
    <button data-testid="dom-action">DOM action</button>
    <div data-testid="rich-text">Visible text <span style="display:none">Hidden text</span></div>
    <div data-testid="wheel-box" style="width:160px;height:80px;overflow:auto"><div style="height:500px">Wheel surface</div></div>
    <div data-testid="drag-source" style="width:80px;height:40px">Drag source</div>
    <div data-testid="drag-target" style="width:100px;height:50px">Drop target</div>
    <div id="virtual-composite" style="position:relative;width:196px;height:32px">
      <div role="listbox" style="position:absolute;left:1px;top:5px;width:0;height:0">
        <div role="option" aria-selected="false" style="width:0;height:22px">Virtual choice</div>
      </div>
      <div data-testid="virtual-choice" style="position:absolute;inset:0">Virtual choice</div>
    </div>
    <div id="shadow-host"></div>
    <script>
      globalThis.clicked = [];
      globalThis.domInvoked = 0;
      globalThis.wheelEvents = 0;
      globalThis.dragging = false;
      globalThis.dropped = false;
      globalThis.shadowClicked = 0;
      document.querySelectorAll('button').forEach(button => button.onclick = () => clicked.push(button.dataset.index));
      document.querySelector('[data-testid="dom-action"]').onclick = () => domInvoked += 1;
      document.querySelector('[data-testid="wheel-box"]').addEventListener('wheel', () => wheelEvents += 1);
      document.querySelector('[data-testid="drag-source"]').addEventListener('mousedown', () => dragging = true);
      document.querySelector('[data-testid="drag-target"]').addEventListener('mouseup', () => dropped = dragging);
      document.querySelector('[data-testid="virtual-choice"]').onclick = () => document.body.dataset.virtualChoice = 'selected';
      document.addEventListener('mouseup', () => dragging = false);
      const shadow = document.querySelector('#shadow-host').attachShadow({ mode: 'open' });
      shadow.innerHTML = '<button data-testid="shadow-save">Shadow action</button>';
      shadow.querySelector('button').onclick = () => shadowClicked += 1;
    </script>
  </body></html>`);
});

await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

let chromePid: number | null = null;
try {
  const address = server.address();
  assert(address && typeof address === "object");
  const browser = await connect();
  chromePid = browser.identity.chrome.pid;
  try {
    const tab = await browser.tabs.open();
    await tab.navigate(`http://127.0.0.1:${address.port}/`, { waitUntil: "load" });
    const saves = tab.getByRole("button", { name: "save" });
    assert.equal(await saves.count(), 2);
    assert.equal((await saves.all()).length, 2);

    let strictFailure: unknown;
    try {
      await saves.click();
    } catch (error) {
      strictFailure = error;
    }
    assert(strictFailure instanceof ABError);
    assert.equal(strictFailure.kind, "strict_violation");
    const strictDetails = strictFailure.details as {
      count: number;
      candidates: Array<{
        index: number;
        tagName: string;
        role: string;
        name: string;
        text: string;
        visible: boolean;
        attributes: Record<string, string>;
      }>;
      truncated: boolean;
    };
    assert.equal(strictDetails.count, 2);
    assert.equal(strictDetails.truncated, false);
    assert.deepEqual(strictDetails.candidates.map((candidate) => ({
      index: candidate.index,
      tagName: candidate.tagName,
      role: candidate.role,
      name: candidate.name,
      text: candidate.text,
      visible: candidate.visible,
      dataIndex: candidate.attributes["data-index"],
    })), [
      { index: 0, tagName: "button", role: "button", name: "Save changes", text: "Save changes", visible: true, dataIndex: "0" },
      { index: 1, tagName: "button", role: "button", name: "Save changes", text: "Save changes", visible: true, dataIndex: "1" },
    ]);
    assert.match(inspect(strictFailure), /details:/);
    assert.match(inspect(strictFailure), /data-index/);

    const locatorBaseline = await tab.ax.snapshot({ mode: "full" });
    const locatorAction = await saves.nth(1).click({
      observe: "diff",
      baseline: locatorBaseline,
    });
    assertActionResult(locatorAction, "locator");
    assert(locatorAction.observation?.diff);
    await locatorAction.observation.dispose();
    await locatorBaseline.dispose();
    assert.deepEqual(await tab.evaluate(() => globalThis.clicked), ["1"]);
    assert.equal(await saves.nth(-1).getAttribute("data-index"), "1");
    assert(await saves.first().boundingBox());
    const saveInspection = await saves.first().inspect({ attributes: ["data-index", "missing"] });
    assert.equal(saveInspection.tagName, "button");
    assert.equal(saveInspection.attributes["data-index"], "0");
    assert.equal(saveInspection.attributes.missing, null);
    assert.equal(saveInspection.innerText, "Save changes");
    assert.equal(saveInspection.visible, true);
    assert.equal(saveInspection.enabled, true);
    assert.equal(saveInspection.checked, null);
    assert(saveInspection.bounds.width > 0);

    const saveHandle = await saves.first().elementHandle();
    assert.equal(await saveHandle.getAttribute("data-index"), "0");
    assert.equal(await saveHandle.textContent(), "Save changes");
    assert.equal((await saveHandle.inspect()).tagName, "button");

    const markers = tab.getByText("visible MARKER");
    assert.equal(await markers.count(), 2);
    assert.equal(await markers.filter({ visible: true }).count(), 1);
    assert.equal(await markers.filter({ visible: false }).count(), 1);

    const richText = tab.getByTestId("rich-text");
    assert.match(await richText.textContent(), /Hidden text/);
    assert.equal((await richText.innerText()).trim(), "Visible text");
    const elementShot = await richText.screenshot();
    assert(elementShot.width > 0 && elementShot.height > 0);
    assert((await elementShot.read()).byteLength > 0);
    assert(elementShot.artifact.expiresAtUnixMs > elementShot.artifact.createdAtUnixMs);
    assert(existsSync(elementShot.path));
    await elementShot.dispose();
    assert.equal(existsSync(elementShot.path), false);
    await assert.rejects(elementShot.read(), (error: unknown) => {
      assert(error instanceof ABError);
      assert.equal(error.kind, "resource_disposed");
      return true;
    });

    await tab.getByTestId("dom-action").domInvoke("click");
    assert.equal(await tab.evaluate(() => globalThis.domInvoked), 1);
    await tab.getByTestId("wheel-box").wheel(0, 100);
    assert.equal(await tab.evaluate(() => globalThis.wheelEvents), 1);
    await tab.getByTestId("drag-source").dragTo(tab.getByTestId("drag-target"));
    assert.equal(await tab.evaluate(() => globalThis.dropped), true);
    await tab.getByTestId("shadow-save").click();
    assert.equal(await tab.evaluate(() => globalThis.shadowClicked), 1);

    const email = tab.getByLabel("email");
    const axState = await tab.ax.snapshot({ mode: "interactive" });
    const emailRef = axState.refs().find(
      (reference) => reference.role === "textbox" && reference.name === "Email address",
    );
    assert(emailRef, axState.text);
    assert.equal(await emailRef.isEnabled(), true);
    const emailInspection = await emailRef.inspect({ attributes: ["aria-autocomplete", "placeholder"] });
    assert.equal(emailInspection.inputType, "text");
    assert.equal(emailInspection.attributes["aria-autocomplete"], "list");
    assert.equal(emailInspection.attributes.placeholder, "Work Email");
    assert.equal(emailInspection.readOnly, false);
    const refAction = await emailRef.fill("from-ref@example.com", { observe: "diff" });
    assertActionResult(refAction, "axRef");
    assert(refAction.observation?.diff);
    const emailHandle = await emailRef.elementHandle();
    assert.equal(await emailHandle.inputValue(), "from-ref@example.com");
    const handleAction = await emailHandle.fill("from-handle@example.com", {
      observe: "diff",
      baseline: refAction.observation,
    });
    assertActionResult(handleAction, "elementHandle");
    assert(handleAction.observation?.diff);
    await handleAction.observation.dispose();
    await refAction.observation.dispose();
    assert.equal(
      await tab.evaluate(() => (document.querySelector("#email") as HTMLInputElement).value),
      "from-handle@example.com",
    );
    await emailHandle.dispose();

    const domRef = axState.refs().find((reference) => reference.name === "DOM action");
    assert(domRef, axState.text);
    await domRef.domInvoke("focus");
    assert.equal(
      await tab.evaluate(() => document.activeElement?.getAttribute("data-testid")),
      "dom-action",
    );
    const refShot = await domRef.screenshot();
    assert(refShot.bytes > 0);
    await refShot.dispose();
    await axState.dispose();

    await email.fill("agent@example.com");
    assert.equal(await tab.evaluate(() => (document.querySelector("#email") as HTMLInputElement).value), "agent@example.com");
    assert.equal(await email.inputValue(), "agent@example.com");
    assert.equal(await email.isEnabled(), true);
    assert.equal(await tab.getByPlaceholder("work").count(), 1);

    const readonlyDate = tab.getByLabel("departure date");
    const dateInspection = await readonlyDate.inspect({ attributes: ["placeholder", "readonly"] });
    assert.equal(dateInspection.readOnly, true);
    assert.equal(dateInspection.value, "");
    assert.equal(dateInspection.attributes.placeholder, "MM/DD/YYYY");
    assert.equal(dateInspection.attributes.readonly, "");
    await assert.rejects(readonlyDate.fill("2016-10-04"), (error: unknown) => {
      assert(error instanceof ABError);
      assert.equal(error.kind, "element_not_editable");
      assert.equal(error.stage, "action.fill");
      return true;
    });
    assert.equal(await readonlyDate.inputValue(), "");

    const closedOption = tab.getByRole("option", { name: "B", exact: true });
    assert.equal(await closedOption.count(), 1);
    assert.equal((await closedOption.inspect()).value, "b");
    const virtualState = await tab.ax.snapshot({ mode: "interactive" });
    const virtualOption = virtualState.refs().find(
      (reference) => reference.role === "option" && reference.name === "Virtual choice",
    );
    assert(virtualOption, virtualState.text);
    const virtualInspection = await virtualOption.inspect();
    assert.equal(virtualInspection.visible, false);
    assert.equal(virtualInspection.bounds.width, 0);
    await virtualOption.click();
    assert.equal(await tab.evaluate(() => document.body.dataset.virtualChoice), "selected");
    await virtualState.dispose();
    await tab.getByLabel("choice").selectOption("b");
    await tab.getByLabel("enabled").check();
    assert.equal(await tab.getByLabel("enabled").isChecked(), true);
    await tab.getByLabel("enabled").uncheck();
    assert.equal(await tab.getByLabel("enabled").isChecked(), false);
    await tab.getByLabel("upload").setFiles(uploadPath);
    const state = await tab.evaluate(() => ({
      choice: (document.querySelector("#choice") as HTMLSelectElement).value,
      enabled: (document.querySelector("#enabled") as HTMLInputElement).checked,
      upload: (document.querySelector("#upload") as HTMLInputElement).files?.[0]?.name,
    }));
    assert.deepEqual(state, {
      choice: "b",
      enabled: false,
      upload: "locator-semantics-live.ts",
    });

    const delayed = tab.getByText("Delayed readiness", { exact: true });
    await tab.evaluate(() => {
      const value = document.createElement("div");
      value.textContent = "Delayed readiness";
      value.style.display = "none";
      document.body.append(value);
      setTimeout(() => { value.style.display = "block"; }, 250);
    });
    assert.equal(await delayed.isVisible(), false);
    const waitStarted = performance.now();
    await delayed.waitFor({ state: "visible", timeoutMs: 2_000 });
    assert(performance.now() - waitStarted >= 100);
    assert.equal(await delayed.isVisible(), true);
    await tab.evaluate(() => {
      setTimeout(() => {
        [...document.querySelectorAll("div")]
          .find((value) => value.textContent === "Delayed readiness")
          ?.remove();
      }, 100);
    });
    await tab.waitFor({ text: "Delayed readiness", state: "detached", timeoutMs: 2_000 });

    const replacementState = await tab.ax.snapshot({ mode: "interactive" });
    const oldSaveRef = replacementState.refs().find(
      (reference) => reference.role === "button" && reference.name === "Save changes",
    );
    assert(oldSaveRef, replacementState.text);
    await tab.evaluate(() => {
      const oldButton = document.querySelector<HTMLButtonElement>('[data-testid="save"][data-index="0"]')!;
      const replacement = oldButton.cloneNode(true) as HTMLButtonElement;
      replacement.onclick = () => globalThis.clicked.push("replacement");
      oldButton.replaceWith(replacement);
    });
    console.log(JSON.stringify({ stage: "same-document-stale", target: "element-handle" }));
    await assert.rejects(saveHandle.textContent(), (error: unknown) => {
      assert(error instanceof ABError);
      assert.equal(error.kind, "stale_ref");
      return true;
    });
    console.log(JSON.stringify({ stage: "same-document-stale", target: "ax-ref" }));
    await assert.rejects(oldSaveRef.click(), (error: unknown) => {
      assert(error instanceof ABError);
      assert.equal(error.kind, "stale_ref");
      return true;
    });
    await saves.first().click();
    assert.deepEqual(await tab.evaluate(() => globalThis.clicked), ["1", "replacement"]);
    await tab.evaluate(() => {
      globalThis.__nativeQuerySelectorAll = Document.prototype.querySelectorAll;
      Document.prototype.querySelectorAll = () => {
        throw new Error("main-world-selector-poisoned");
      };
    });
    assert.equal(await tab.getByTestId("shadow-save").count(), 1);
    await tab.waitFor({
      selector: '[data-testid="shadow-save"]',
      state: "visible",
      timeoutMs: 2_000,
    });
    await tab.evaluate(() => {
      Document.prototype.querySelectorAll = globalThis.__nativeQuerySelectorAll;
    });
    await replacementState.dispose();
    await saveHandle.dispose();

    const navigatingHandle = await saves.first().elementHandle();
    await tab.reload();
    await assert.rejects(navigatingHandle.textContent(), (error: unknown) => {
      assert(error instanceof ABError);
      assert.equal(error.kind, "stale_document");
      return true;
    });
    await navigatingHandle.dispose();

    console.log(JSON.stringify({
      strictFailure: strictFailure.kind,
      semanticCount: await saves.count(),
      visibleCount: await markers.filter({ visible: true }).count(),
      hiddenCount: await markers.filter({ visible: false }).count(),
      state,
    }, null, 2));
  } finally {
    await browser.disconnect();
  }
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await stopDaemon(socketPath);
  if (chromePid !== null) stopProcess(chromePid);
}

async function stopDaemon(path: string): Promise<void> {
  const lsof = Bun.spawn(["lsof", "-t", path], { stdout: "pipe", stderr: "ignore" });
  const output = await new Response(lsof.stdout).text();
  await lsof.exited;
  for (const value of output.trim().split(/\s+/).filter(Boolean)) stopProcess(Number(value));
}

function stopProcess(pid: number): void {
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  assert(value, `${name} is required`);
  return value;
}

function assertActionResult(
  result: ActionResult,
  source: ActionResult["target"]["source"],
): void {
  assert.equal(result.target.source, source);
  assert(result.id.length > 0);
  assert(result.target.targetId.length > 0);
  assert(result.target.sessionId.length > 0);
  assert(result.target.frameId.length > 0);
  assert(result.target.documentGeneration.length > 0);
  assert.equal(typeof result.target.backendNodeId, "number");
  assert(result.target.backendNodeId! > 0);
  assert.match(result.dispatchMechanism, /^cdp\./);
  assert(result.timing.endedAtUnixMs >= result.timing.startedAtUnixMs);
  assert(result.timing.durationMs >= 0);
  assert.equal(result.navigation.changed, false);
  assert.equal(result.document.changed, false);
  assert.equal(result.dialog.opened, false);
  assert.equal(result.fileChooser.opened, false);
  assert.equal(result.fileChooser.complete, true);
  assert.deepEqual(result.observationOutcome, { status: "completed" });
  assert.equal(result.lastStage, "action.post_observation.completed");
}
