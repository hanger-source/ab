import assert from "node:assert/strict";
import http from "node:http";
import { join } from "node:path";
import { connect, type Tab } from "../../../../sdk/ts/src/index.ts";

const runtimeDirectory = requiredEnv("AB_RUNTIME_DIR");

let markScriptRequested!: () => void;
const scriptRequested = new Promise<void>((resolve) => {
  markScriptRequested = resolve;
});
let releaseScript!: () => void;
const scriptRelease = new Promise<void>((resolve) => {
  releaseScript = resolve;
});

const server = http.createServer((request, response) => {
  if (request.url === "/held.js") {
    markScriptRequested();
    void scriptRelease.then(() => {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      response.end("globalThis.__heldScriptExecuted = true;");
    });
    return;
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(`<!doctype html>
    <html>
      <head>
        <title>Held lifecycle</title>
        <script src="/held.js"></script>
      </head>
      <body><h1>Lifecycle complete</h1></body>
    </html>`);
});

await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

let chromePid: number | null = null;
let tab: Tab | null = null;
try {
  const address = server.address();
  assert(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const browser = await connect();
  chromePid = browser.identity.chrome.pid;
  tab = await browser.tabs.open("data:text/html,<title>Wait boundary source</title>");

  await tab.navigate(`${origin}/lifecycle`, { waitUntil: "none", timeoutMs: 5_000 });
  await tab.waitForURL("/lifecycle", { timeoutMs: 2_000 });
  await scriptRequested;

  let loadStateResolved = false;
  const loadState = tab.waitForLoadState("domcontentloaded", { timeoutMs: 5_000 }).then(() => {
    loadStateResolved = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    loadStateResolved,
    false,
    "DOMContentLoaded must stay pending while the parser-blocking script is withheld",
  );

  releaseScript();
  await loadState;
  assert.equal(await tab.evaluate(() => document.readyState), "complete");
  assert.equal(await tab.evaluate(() => globalThis.__heldScriptExecuted), true);
  assert.equal(await tab.getByRole("heading", { name: "Lifecycle complete", exact: true }).count(), 1);

  console.log(JSON.stringify({
    scenario: "page-wait-boundaries",
    destinationUrl: tab.url,
    heldBeforeRelease: true,
    finalReadyState: "complete",
  }, null, 2));

  await tab.close();
  tab = null;
  await browser.disconnect();
} finally {
  releaseScript();
  await tab?.close().catch(() => undefined);
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
