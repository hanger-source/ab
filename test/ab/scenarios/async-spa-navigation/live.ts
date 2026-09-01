import assert from "node:assert/strict";
import http from "node:http";
import { join } from "node:path";
import { connect } from "../../../../sdk/ts/src/index.ts";

const runtimeDirectory = requiredEnv("AB_RUNTIME_DIR");
const page = `<!doctype html>
<html>
  <head><title>Async SPA navigation</title></head>
  <body>
    <main>
      <h1 id="title">Workspace index</h1>
      <a id="destination" href="/destination">Open destination workspace</a>
      <p id="status">Index ready</p>
    </main>
    <script>
      const link = document.querySelector('#destination');
      const title = document.querySelector('#title');
      const status = document.querySelector('#status');
      link.addEventListener('click', async event => {
        event.preventDefault();
        status.textContent = 'Loading workspace';
        const response = await fetch('/route-data');
        const route = await response.json();
        history.pushState({ route: route.id }, '', link.href);
        title.textContent = route.title;
        status.textContent = 'Workspace ready';
      });
    </script>
  </body>
</html>`;

let routeResponsesSent = 0;
const server = http.createServer((request, response) => {
  if (request.url === "/route-data") {
    setTimeout(() => {
      routeResponsesSent += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "destination", title: "Destination workspace" }));
    }, 220);
    return;
  }
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

  const actionOnlyTab = await browser.tabs.open(`http://127.0.0.1:${address.port}`);
  const responsesBeforeAction = routeResponsesSent;
  const actionOnly = await actionOnlyTab
    .getByRole("link", { name: "Open destination workspace", exact: true })
    .click({ observe: "none" });
  const responsesSentAtActionReturn = routeResponsesSent - responsesBeforeAction;
  assert.equal(
    responsesSentAtActionReturn,
    0,
    "an action without a post-action observation must not wait for application route data",
  );
  assert.equal(actionOnly.observation, null);
  await waitForPath(browser, actionOnlyTab.id, "/destination");

  const tab = await browser.tabs.open(`http://127.0.0.1:${address.port}`);
  const baseline = await tab.ax.snapshot({ mode: "full", surface: "active" });

  const action = await tab
    .getByRole("link", { name: "Open destination workspace", exact: true })
    .click({ observe: "diff", baseline });
  const destination = action.observation;
  assert(destination, "SPA link action must return a post-action observation");
  assert.equal(action.navigation.changed, true);
  assert.equal(new URL(action.navigation.afterUrl).pathname, "/destination");
  assert.equal(action.document.changed, false);
  assert(destination.text.includes("Destination workspace"), destination.text);
  assert(destination.text.includes("Workspace ready"), destination.text);
  assert(!destination.text.includes("Loading workspace"), destination.text);

  const current = await browser.tabs.get(tab.id);
  assert.equal(current.url, action.navigation.afterUrl);

  console.log(JSON.stringify({
    scenario: "async-spa-navigation",
    actionOnly: {
      durationMs: actionOnly.timing.durationMs,
      navigation: actionOnly.navigation,
      responsesSentAtReturn: responsesSentAtActionReturn,
    },
    action: {
      durationMs: action.timing.durationMs,
      navigation: action.navigation,
      document: action.document,
      observationStatus: action.observationOutcome.status,
    },
  }, null, 2));

  await destination.dispose();
  await baseline.dispose();
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

async function waitForPath(
  browser: Awaited<ReturnType<typeof connect>>,
  targetId: string,
  pathname: string,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const current = await browser.tabs.get(targetId);
    if (new URL(current.url).pathname === pathname) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`tab ${targetId} did not reach ${pathname}`);
}
