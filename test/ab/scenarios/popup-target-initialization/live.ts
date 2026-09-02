import assert from "node:assert/strict";
import http from "node:http";
import { join } from "node:path";
import { connect } from "../../../../sdk/ts/src/index.ts";

const runtimeDirectory = requiredEnv("AB_RUNTIME_DIR");
let profileRequests = 0;
const profileServer = http.createServer((request, response) => {
  if (request.url === "/profile") profileRequests += 1;
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end("<!doctype html><html><head><title>Author profile</title></head><body><h1>Author profile</h1></body></html>");
});
await listen(profileServer);
const profileOrigin = originOf(profileServer);

const detailServer = http.createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(`<!doctype html>
    <html>
      <head><title>Detail</title></head>
      <body>
        <a id="author" href="${profileOrigin}/profile" target="_blank">Author</a>
        <output id="clicks">0</output>
        <output id="user-active">false</output>
        <script>
          document.querySelector('#author').addEventListener('click', () => {
            document.querySelector('#clicks').value = '1';
            document.querySelector('#user-active').value = String(navigator.userActivation.isActive);
          });
        </script>
      </body>
    </html>`);
});
await listen(detailServer);

let chromePid: number | null = null;
try {
  const origin = originOf(detailServer);
  const browser = await connect();
  chromePid = browser.identity.chrome.pid;
  const detail = await browser.tabs.open(origin);

  const started = performance.now();
  const action = await detail
    .getByRole("link", { name: "Author", exact: true })
    .click({
      observe: "state",
      observation: { mode: "full", surface: "active", maxChars: 4_000 },
      timeoutMs: 5_000,
    });
  const actionMs = Math.round(performance.now() - started);

  assert.match(action.dispatchMechanism, /^cdp\./);
  if (action.observationOutcome.status !== "completed") {
    console.error(JSON.stringify({
      checkpoint: "popup-source-observation-failed",
      actionMs,
      action,
      tabs: (await browser.tabs.list()).map(({ id, title, url }) => ({ id, title, url })),
      profileRequests,
    }, null, 2));
  }
  assert.equal(action.observationOutcome.status, "completed");
  const clicks = await detail.getByRole("status").all();
  const status = await Promise.all(clicks.map(async (item) => item.textContent()));
  assert.deepEqual(status, ["1", "true"], "the popup must originate from one trusted user activation");
  console.log(JSON.stringify({
    checkpoint: "popup-click-returned",
    actionMs,
    dispatchMechanism: action.dispatchMechanism,
    observationStatus: action.observationOutcome.status,
    navigation: action.navigation,
    tabs: (await browser.tabs.list()).map(({ id, title, url }) => ({ id, title, url })),
    profileRequests,
    status,
  }, null, 2));
  const profile = await waitForProfileTab(browser, `${profileOrigin}/profile`, 5_000);
  const profileState = await profile.ax.snapshot({
    mode: "full",
    surface: "active",
    maxChars: 4_000,
    timeoutMs: 5_000,
  });
  assert.match(profileState.text, /heading "Author profile"/);
  assert.equal(profileRequests, 1, "the trusted click must navigate one popup exactly once");

  console.log(JSON.stringify({
    scenario: "popup-target-initialization",
    actionMs,
    dispatchMechanism: action.dispatchMechanism,
    observationStatus: action.observationOutcome.status,
    childTabId: profile.id,
  }, null, 2));

  await profileState.dispose();
  await action.observation?.dispose();
  await browser.disconnect();
} finally {
  await Promise.all([close(detailServer), close(profileServer)]);
  await stopDaemon(join(runtimeDirectory, "browser.sock"));
  if (chromePid !== null) stopProcess(chromePid);
}

async function listen(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function originOf(server: http.Server): string {
  const address = server.address();
  assert(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function waitForProfileTab(
  browser: Awaited<ReturnType<typeof connect>>,
  url: string,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tab = (await browser.tabs.list()).find((candidate) => candidate.url === url);
    if (tab) return tab;
    await Bun.sleep(25);
  }
  const tabs = (await browser.tabs.list()).map(({ id, title, url: currentUrl }) => ({
    id,
    title,
    url: currentUrl,
  }));
  throw new Error(`popup target did not become ready at ${url}; profileRequests=${profileRequests}; tabs=${JSON.stringify(tabs)}`);
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
