import assert from "node:assert/strict";
import http from "node:http";
import { join } from "node:path";
import { connect } from "../../../../sdk/ts/src/index.ts";

const runtimeDirectory = requiredEnv("AB_RUNTIME_DIR");
let profileRequests = 0;

const profileServer = http.createServer((request, response) => {
  if (request.url === "/profile") profileRequests += 1;
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end("<!doctype html><html><head><title>Background author profile</title></head><body><h1>Background author profile</h1></body></html>");
});
await listen(profileServer);
const profileOrigin = originOf(profileServer);

const sourceServer = http.createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  if (request.url === "/cover") {
    response.end("<!doctype html><html><head><title>Active cover</title></head><body><h1>Active cover</h1></body></html>");
    return;
  }
  response.end(`<!doctype html>
    <html>
      <head><title>Background detail</title></head>
      <body>
        <a id="author" href="${profileOrigin}/profile" target="_blank">Author</a>
        <output id="clicks">0</output>
        <output id="user-active">false</output>
        <script>
          globalThis.__pointerEvents = [];
          globalThis.__pointerStartedAt = 0;
          for (const type of ['mousemove', 'mousedown', 'mouseup', 'click']) {
            document.addEventListener(type, event => {
              globalThis.__pointerEvents.push({
                type,
                elapsedMs: Math.round(performance.now() - globalThis.__pointerStartedAt),
                trusted: event.isTrusted,
              });
            }, true);
          }
          document.querySelector('#author').addEventListener('click', () => {
            document.querySelector('#clicks').value = '1';
            document.querySelector('#user-active').value = String(navigator.userActivation.isActive);
          });
        </script>
      </body>
    </html>`);
});
await listen(sourceServer);

let chromePid: number | null = null;
try {
  const sourceOrigin = originOf(sourceServer);
  const browser = await connect();
  chromePid = browser.identity.chrome.pid;
  const detail = await browser.tabs.open(sourceOrigin);
  const baseline = await detail.ax.snapshot({
    mode: "full",
    surface: "active",
    maxChars: 4_000,
    timeoutMs: 5_000,
  });
  const author = baseline.refs().find((ref) => ref.role === "link" && ref.name === "Author");
  assert(author, `author ref missing from source observation: ${baseline.text}`);
  const cover = await browser.tabs.open(`${sourceOrigin}/cover`);
  await cover.activate();

  const hiddenProbe = await detail.evaluate(async () => {
    let rafFired = false;
    requestAnimationFrame(() => {
      rafFired = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 750));
    return { visibilityState: document.visibilityState, rafFired };
  });
  assert.deepEqual(
    hiddenProbe,
    { visibilityState: "hidden", rafFired: false },
    "the source must be a background document whose page rAF is suppressed",
  );

  await detail.evaluate(() => {
    (globalThis as typeof globalThis & { __pointerStartedAt: number }).__pointerStartedAt = performance.now();
  });
  const started = performance.now();
  let action;
  try {
    action = await author.click({ observe: "none", timeoutMs: 5_000 });
  } catch (error) {
    const structuredError = error as Error & {
      kind?: string;
      stage?: string;
      context?: { traceId?: string };
    };
    const traceId = error instanceof Error
      ? structuredError.context?.traceId
      : undefined;
    await Bun.sleep(2_500);
    console.error(JSON.stringify({
      checkpoint: "background-action-failed",
      error: error instanceof Error
        ? {
            name: error.name,
            message: error.message,
            kind: structuredError.kind,
            stage: structuredError.stage,
          }
        : String(error),
      trace: traceId ? browser.diagnostics.snapshot({ traceId }) : null,
      tabs: (await browser.tabs.list()).map(({ id, title, url }) => ({ id, title, url })),
      pointerEvents: await detail.evaluate(
        () => (globalThis as typeof globalThis & {
          __pointerEvents: Array<{ type: string; elapsedMs: number; trusted: boolean }>;
        }).__pointerEvents,
      ),
      profileRequests,
    }, null, 2));
    throw error;
  }
  const actionMs = Math.round(performance.now() - started);
  const pointerEvents = await detail.evaluate(
    () => (globalThis as typeof globalThis & {
      __pointerEvents: Array<{ type: string; elapsedMs: number; trusted: boolean }>;
    }).__pointerEvents,
  );

  console.log(JSON.stringify({ checkpoint: "background-action-returned", actionMs, action, pointerEvents }, null, 2));
  assert.match(action.dispatchMechanism, /^cdp\./);
  assert.equal(action.observationOutcome.status, "notRequested");
  assert.deepEqual(
    pointerEvents.map(({ type, trusted }) => ({ type, trusted })),
    [
      { type: "mousemove", trusted: true },
      { type: "mousedown", trusted: true },
      { type: "mouseup", trusted: true },
      { type: "click", trusted: true },
    ],
    "the bound AX ref must dispatch one complete trusted pointer sequence",
  );
  const sourceStatus = await detail.getByRole("status").all();
  const status = await Promise.all(sourceStatus.map(async (item) => item.textContent()));
  assert.deepEqual(status, ["1", "true"], "the hidden source must receive one trusted activation");

  const profile = await waitForProfileTab(browser, `${profileOrigin}/profile`, 5_000);
  const profileState = await profile.ax.snapshot({
    mode: "full",
    surface: "active",
    maxChars: 4_000,
    timeoutMs: 5_000,
  });
  assert.match(profileState.text, /heading "Background author profile"/);
  assert.equal(profileRequests, 1, "the hidden-tab click must navigate one popup exactly once");

  console.log(JSON.stringify({
    scenario: "background-tab-popup-action",
    hiddenProbe,
    actionMs,
    pointerEvents,
    dispatchMechanism: action.dispatchMechanism,
    observationStatus: action.observationOutcome.status,
    childTabId: profile.id,
    profileRequests,
    status,
  }, null, 2));

  await profileState.dispose();
  await action.observation?.dispose();
  await baseline.dispose();
  await browser.disconnect();
} finally {
  await Promise.all([close(sourceServer), close(profileServer)]);
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
  throw new Error(`background popup did not become ready at ${url}; profileRequests=${profileRequests}; tabs=${JSON.stringify(tabs)}`);
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
