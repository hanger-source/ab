import assert from "node:assert/strict";
import { join } from "node:path";
import { connect, type AXState, type Tab } from "../../sdk/ts/src/index.ts";
import {
  beginMiniWobEpisode,
  readMiniWobResult,
  startMiniWobServer,
  type MiniWobEpisodeResult,
} from "./miniwob.ts";
import { ABHarRecorder } from "./har.ts";

const runtimeDirectory = requiredEnv("AB_RUNTIME_DIR");
const server = startMiniWobServer();
let chromePid: number | null = null;

try {
  const browser = await connect();
  chromePid = browser.identity.chrome.pid;
  const tab = await browser.tabs.open();
  const har = await ABHarRecorder.start(tab);

  const click = await runTask(tab, "click-test", async (state) => {
    const button = state.refs().find((ref) => ref.role === "button" && ref.name === "Click Me!");
    assert(button, state.text);
    await button.click({ observe: "none" });
  });

  const enterText = await runTask(tab, "enter-text", async (state, instruction) => {
    const expected = instruction.match(/Enter "([^"]+)"/)?.[1];
    assert(expected, instruction);
    const textbox = state.refs().find((ref) => ref.role === "textbox");
    const submit = state.refs().find((ref) => ref.role === "button" && ref.name === "Submit");
    assert(textbox, state.text);
    assert(submit, state.text);
    await textbox.fill(expected, { observe: "none" });
    await submit.click({ observe: "none" });
  });

  const autocomplete = await runAutocompleteBoundary(tab);

  assert(click.result.passed, JSON.stringify(click));
  assert(enterText.result.passed, JSON.stringify(enterText));
  const harPath = join(requiredEnv("AB_DATA_DIR"), "miniwob-network.har");
  const harResult = await har.write(harPath);
  assert(harResult.entries > 0, "AB HAR recorder did not capture official MiniWoB++ requests");
  console.log(JSON.stringify({
    source: "official MiniWoB++ HTML",
    transport: "AB TypeScript SDK -> Rust runtime -> CDP -> Chrome",
    browser: browser.identity,
    har: { path: harPath, ...harResult },
    tasks: [click, enterText],
    autocomplete,
  }, null, 2));

  await har.dispose();
  await tab.close();
  await browser.disconnect();
} finally {
  server.stop();
  await stopDaemon(join(runtimeDirectory, "browser.sock"));
  if (chromePid !== null) stopProcess(chromePid);
}

async function runAutocompleteBoundary(tab: Tab): Promise<{
  taskId: string;
  instruction: string;
  requestedText: string;
  committedValue: string;
  signals: string[];
}> {
  const taskId = "book-flight-nodelay";
  const instruction = await beginMiniWobEpisode(tab, server.taskUrl(taskId));
  const requestedText = instruction.match(/from:\s*(.+?)\s+to:/)?.[1]?.trim();
  assert(requestedText, instruction);
  const field = tab.getByRole("textbox", { name: "From:", exact: true });
  const result = await field.fillAndSelectSuggestion(requestedText, requestedText, {
    expectedValue: requestedText,
    observe: "diff",
    observation: { mode: "full", maxChars: 24_000 },
  });
  assert.equal(result.input.data.field.popupBacked, true, JSON.stringify(result.input.data.field));
  assert(result.input.data.field.signals.includes("jquery-ui-autocomplete"), JSON.stringify(result.input.data.field));
  assert.equal(result.input.data.field.next, "selectSuggestion");
  assert.equal(result.input.data.field.inputValue, requestedText);
  assert(result.selection.observation, "suggestion selection omitted its post-action observation");
  const committedValue = result.committedValue;
  await result.selection.observation.dispose();
  return {
    taskId,
    instruction,
    requestedText,
    committedValue,
    signals: result.input.data.field.signals,
  };
}

async function runTask(
  tab: Tab,
  taskId: string,
  act: (state: AXState, instruction: string) => Promise<void>,
): Promise<{
  taskId: string;
  instruction: string;
  observationId: string;
  refCount: number;
  screenshot: { bytes: number; viewportId: string };
  result: MiniWobEpisodeResult;
}> {
  const instruction = await beginMiniWobEpisode(tab, server.taskUrl(taskId));
  const observation = await tab.observe({ ax: { mode: "full" }, screenshot: true });
  assert(observation.state, `${taskId}: missing AX state`);
  assert(observation.screenshot, `${taskId}: missing screenshot`);
  const state = observation.state;
  const screenshot = observation.screenshot;
  // BrowserGym-equivalent episode setup deliberately removes the human query
  // before Agent handoff. The coordinator owns `instruction`; AX owns only the
  // rendered operation surface. See `test/benchmarks/README.md`.
  assert(
    screenshot.viewportId.includes(state.documentGeneration),
    `${taskId}: AX and screenshot do not share a document transaction`,
  );
  await act(state, instruction);
  const result = await readMiniWobResult(tab);
  const record = {
    taskId,
    instruction,
    observationId: state.id,
    refCount: state.refs().length,
    screenshot: { bytes: screenshot.bytes, viewportId: screenshot.viewportId },
    result,
  };
  await screenshot.dispose();
  await state.dispose();
  return record;
}

async function stopDaemon(socketPath: string): Promise<void> {
  const lsof = Bun.spawn(["lsof", "-t", socketPath], { stdout: "pipe", stderr: "ignore" });
  const output = await new Response(lsof.stdout).text();
  await lsof.exited;
  for (const value of output.trim().split(/\s+/).filter(Boolean)) {
    stopProcess(Number(value));
  }
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
