import assert from "node:assert/strict";
import http from "node:http";
import { join } from "node:path";
import { connect } from "../../../../sdk/ts/src/index.ts";

const runtimeDirectory = requiredEnv("AB_RUNTIME_DIR");
const page = `<!doctype html>
<html>
  <head><title>Pointer click sequence</title></head>
  <body>
    <button id="target" type="button">Pointer target</button>
    <output id="events"></output>
    <script>
      const target = document.querySelector('#target');
      const output = document.querySelector('#events');
      const records = [];
      for (const type of ['mousedown', 'mouseup', 'click', 'dblclick']) {
        target.addEventListener(type, event => {
          records.push({ type: event.type, detail: event.detail, trusted: event.isTrusted });
          output.value = JSON.stringify(records);
        });
      }
    </script>
  </body>
</html>`;

const server = http.createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(page);
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
  const tab = await browser.tabs.open(`http://127.0.0.1:${address.port}`);

  const action = await tab
    .getByRole("button", { name: "Pointer target", exact: true })
    .doubleClick({ observe: "none" });
  const events = JSON.parse(await tab.locator("#events").textContent()) as Array<{
    type: string;
    detail: number;
    trusted: boolean;
  }>;

  assert.match(action.dispatchMechanism, /^cdp\./);
  assert.deepEqual(events, [
    { type: "mousedown", detail: 1, trusted: true },
    { type: "mouseup", detail: 1, trusted: true },
    { type: "click", detail: 1, trusted: true },
    { type: "mousedown", detail: 2, trusted: true },
    { type: "mouseup", detail: 2, trusted: true },
    { type: "click", detail: 2, trusted: true },
    { type: "dblclick", detail: 2, trusted: true },
  ]);

  console.log(JSON.stringify({
    scenario: "pointer-click-sequence",
    dispatchMechanism: action.dispatchMechanism,
    events,
  }, null, 2));

  await tab.close();
  await browser.disconnect();
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await stopDaemon(join(runtimeDirectory, "browser.sock"));
  if (chromePid !== null) stopProcess(chromePid);
}

async function stopDaemon(socketPath: string): Promise<void> {
  const child = Bun.spawn(["lsof", "-t", socketPath], { stdout: "pipe", stderr: "ignore" });
  const output = await new Response(child.stdout).text();
  await child.exited;
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
