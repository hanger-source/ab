import assert from "node:assert/strict";
import http from "node:http";
import { join } from "node:path";
import { ABError, connect } from "../../../../sdk/ts/src/index.ts";

const runtimeDirectory = requiredEnv("AB_RUNTIME_DIR");
const server = http.createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(`<!doctype html>
    <html>
      <head><title>Icon font controls</title></head>
      <body>
        <button id="filters" type="button"><span class="icon">&#xe605;</span>Filters</button>
        <button id="icon-only" type="button"><span class="icon">&#xe606;</span></button>
        <p id="status">Filters closed</p>
        <script>
          document.querySelector('#filters').addEventListener('click', () => {
            document.querySelector('#status').textContent = 'Filters opened';
          });
        </script>
      </body>
    </html>`);
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
  const tab = await browser.tabs.open(`http://127.0.0.1:${address.port}/`);

  const state = await tab.ax.snapshot({ mode: "interactive", surface: "document" });
  assert(!state.text.includes("\ue605"), state.text);
  assert(!state.text.includes("\ue606"), state.text);
  assert(state.text.includes('button "Filters"'), state.text);
  const filterRef = state.refs().find((reference) => reference.role === "button" && reference.name === "Filters");
  assert(filterRef, state.text);
  const iconOnlyRef = state.refs().find((reference) => reference.role === "button" && reference.name === "");
  assert(iconOnlyRef, state.text);

  const filters = tab.getByRole("button", { name: "Filters", exact: true });
  assert.equal(await filters.count({ timeoutMs: 2_000 }), 1);
  const actionStarted = performance.now();
  await filters.click({ observe: "none", timeoutMs: 3_000 });
  const actionMs = Math.round(performance.now() - actionStarted);
  assert(actionMs < 2_000, `exact role action took ${actionMs}ms`);
  assert.equal(await tab.getByText("Filters opened", { exact: true }).count(), 1);

  const missingStarted = performance.now();
  let missingError: unknown;
  try {
    await tab.getByRole("button", { name: "Missing action", exact: true }).click({
      observe: "none",
      timeoutMs: 350,
    });
  } catch (error) {
    missingError = error;
  }
  const missingMs = Math.round(performance.now() - missingStarted);
  assert(missingError instanceof ABError);
  assert.equal(missingError.kind, "timeout");
  assert.equal(missingError.stage, "locator.resolve.deadline");
  assert.match(missingError.message, /last attempt failed at selector\.resolve/);
  assert.deepEqual((missingError.details as { lastError: { kind: string; stage: string } }).lastError, {
    kind: "not_found",
    stage: "selector.resolve",
    message: "locator did not match any element",
  });
  assert(missingMs < 1_500, `missing Locator took ${missingMs}ms`);

  console.log(JSON.stringify({
    scenario: "icon-font-accessible-name",
    observationId: state.id,
    filterRef: filterRef.id,
    iconOnlyRef: iconOnlyRef.id,
    actionMs,
    missingMs,
    missingStage: missingError.stage,
  }, null, 2));

  await state.dispose();
  await browser.disconnect();
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await stopDaemon(join(runtimeDirectory, "browser.sock"));
  if (chromePid !== null) stopProcess(chromePid);
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
