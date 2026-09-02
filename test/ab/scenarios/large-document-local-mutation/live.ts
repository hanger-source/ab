import assert from "node:assert/strict";
import http from "node:http";
import { join } from "node:path";
import {
  connect,
  type ImagePresentation,
  type Presenter,
  type TextPresentation,
} from "../../../../sdk/ts/src/agent/index.ts";

const runtimeDirectory = requiredEnv("AB_RUNTIME_DIR");
const presentations: TextPresentation[] = [];
const presenter: Presenter = {
  presentText(value) {
    presentations.push(value);
  },
  presentImage(value: ImagePresentation) {
    throw new Error(`unexpected image presentation ${value.screenshot.id}`);
  },
};
const server = http.createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(largeDocumentPage());
});

await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

let chromePid: number | null = null;
try {
  const address = server.address();
  assert(address && typeof address === "object");
  const browser = await connect({ presenter, timeoutMs: 20_000 });
  chromePid = browser.identity.chrome.pid;
  const tab = await browser.tabs.open(`http://127.0.0.1:${address.port}/page`);
  await tab.playwright.waitFor({ selector: "#field-449", state: "attached", timeoutMs: 10_000 });

  try {
    var baseline = await tab.ax.write("state", { mode: "full", surface: "active", timeoutMs: 20_000 });
  } catch (error) {
    console.error(JSON.stringify({
      scenario: "large-document-local-mutation",
      stage: "initial-observation",
      error: error instanceof Error
        ? { name: error.name, message: error.message, details: "details" in error ? error.details : undefined }
        : error,
    }, null, 2));
    throw error;
  }
  assert.equal(baseline.truncated, true, "fixture did not exceed the Agent text budget");
  assert(baseline.text.length <= 24_100, `Agent state exceeded its budget: ${baseline.text.length}`);
  assert(baseline.refs().length >= 400, `fixture exposed only ${baseline.refs().length} refs`);
  assert(
    baseline.sources.backendNodeCount >= 6_000,
    `fixture exposed only ${baseline.sources.backendNodeCount} backend nodes`,
  );

  const baselineRefs = baseline.refs();
  const stableRef = baselineRefs.find((ref) => ref.name.startsWith("Stable field 449 "));
  assert(stableRef, "late stable field is missing from the baseline ref map");
  const stableBefore = { id: stableRef.id, name: stableRef.name };
  const baselineRefIds = new Set(baselineRefs.map((ref) => ref.id));
  const baselineSummary = {
    observationId: baseline.id,
    documentGeneration: baseline.documentGeneration,
    textChars: baseline.text.length,
    refs: baselineRefs.length,
    backendNodes: baseline.sources.backendNodeCount,
    truncated: baseline.truncated,
  };
  const started = performance.now();
  const action = await tab.playwright.getByText("Toggle local detail", { exact: true }).click({ timeoutMs: 5_000 });
  const elapsedMs = Math.round(performance.now() - started);
  assert.equal(action.observation, null);
  assert.equal(action.observationOutcome.status, "notRequested");
  assert.equal(baseline.disposed, false, "action replaced the presented baseline");
  const current = await tab.ax.write("diff");
  assert.equal(current.documentGeneration, baselineSummary.documentGeneration);
  assert(current.diff, "explicit Agent observation did not return a diff");

  const stableAfter = current.refs().find((ref) => ref.name === stableBefore.name);
  assert.equal(stableAfter?.id, stableBefore.id, "unchanged late node received a different ref ID");
  const added = current.refs().find((ref) => ref.name === "New local action");
  assert(added, "local mutation did not expose its new action");
  assert(!baselineRefIds.has(added.id), `${added.id} collides with a ref from the presented baseline`);
  assert(current.diff.addedRefs.includes(added.id), `${added.id} was not reported as an added ref`);
  assert(
    current.diff.text.length < 5_000,
    `local mutation produced a ${current.diff.text.length}-character Agent diff`,
  );
  assert.equal(presentations.at(-1)?.text, current.diff.text);

  const interactiveBaseline = await tab.ax.write("state", {
    mode: "interactive",
    surface: "active",
    maxChars: 24_000,
    timeoutMs: 20_000,
  });
  assert(
    !interactiveBaseline.text.includes("StaticText"),
    "interactive fixture unexpectedly contains full-tree StaticText output",
  );
  const interactiveStarted = performance.now();
  const interactiveAction = await tab.playwright.getByText("Toggle local detail", { exact: true }).click({ timeoutMs: 5_000 });
  const interactiveElapsedMs = Math.round(performance.now() - interactiveStarted);
  assert.equal(interactiveAction.observation, null);
  assert.equal(interactiveAction.observationOutcome.status, "notRequested");
  assert.equal(interactiveBaseline.disposed, false, "action replaced the interactive baseline");
  const interactiveCurrent = await tab.ax.write("diff");
  assert(interactiveCurrent.diff, "explicit interactive observation did not return a diff");
  assert(
    interactiveCurrent.diff.text.length < 5_000,
    `interactive baseline produced a ${interactiveCurrent.diff.text.length}-character Agent diff`,
  );
  assert(
    !interactiveCurrent.diff.text.includes("StaticText"),
    "interactive action diff silently changed to a full-tree capture shape",
  );
  assert.equal(presentations.at(-1)?.text, interactiveCurrent.diff.text);

  const deadlineTarget = interactiveCurrent.refs().find((ref) => ref.name === "Toggle local detail");
  assert(deadlineTarget, "deadline action target is missing from the retained observation");
  const deadlineAction = await deadlineTarget.click({
    observe: "state",
    observation: { mode: "full", surface: "active", maxChars: 24_000 },
    timeoutMs: 75,
  });
  assert.equal(deadlineAction.observation, null);
  assert.equal(deadlineAction.observationOutcome.status, "failed");
  assert.equal(deadlineAction.observationOutcome.error?.kind, "timeout");
  assert.equal(deadlineAction.observationOutcome.error?.stage, "action.observation.deadline");

  console.log(JSON.stringify({
    scenario: "large-document-local-mutation",
    baseline: baselineSummary,
    action: {
      elapsedMs,
      observationId: current.id,
      diffChars: current.diff.text.length,
      additions: current.diff.additions,
      removals: current.diff.removals,
      addedRef: added.id,
      stableLateRef: stableAfter.id,
    },
    interactiveAction: {
      elapsedMs: interactiveElapsedMs,
      baselineObservationId: interactiveBaseline.id,
      observationId: interactiveCurrent.id,
      diffChars: interactiveCurrent.diff.text.length,
      additions: interactiveCurrent.diff.additions,
      removals: interactiveCurrent.diff.removals,
    },
    deadlineAction: deadlineAction.observationOutcome,
  }, null, 2));

  await browser.disconnect();
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await stopDaemon(join(runtimeDirectory, "browser.sock"));
  if (chromePid !== null) stopProcess(chromePid);
}

function largeDocumentPage(): string {
  const rows = Array.from({ length: 450 }, (_, index) => `
    <section class="record">
      <label for="field-${index}">Stable field ${index} with deliberately verbose accessible context for bounded Agent observation pressure</label>
      <input id="field-${index}" />
      ${Array.from({ length: 12 }, (__, part) => `<span>record ${index} supporting datum ${part}</span>`).join("")}
    </section>`).join("");
  return `<!doctype html>
    <html>
      <head><title>Large local mutation</title></head>
      <body>
        <main>
          <h1>Large agent workspace</h1>
          <button id="toggle" type="button">Toggle local detail</button>
          <div id="records">${rows}</div>
        </main>
        <script>
          document.querySelector('#toggle').addEventListener('click', () => {
            const current = document.querySelector('#local-detail');
            if (current) {
              current.remove();
              return;
            }
            const detail = document.createElement('section');
            detail.id = 'local-detail';
            detail.innerHTML = '<h2>Local detail</h2><p>One small region changed.</p><button>New local action</button>';
            document.querySelector('#records').before(detail);
          });
        </script>
      </body>
    </html>`;
}

async function stopDaemon(socketPath: string): Promise<void> {
  const lsof = Bun.spawn(["lsof", "-t", socketPath], { stdout: "pipe", stderr: "ignore" });
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
