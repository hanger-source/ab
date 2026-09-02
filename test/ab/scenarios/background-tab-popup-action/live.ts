import assert from "node:assert/strict";
import http from "node:http";
import { join } from "node:path";
import {
  connect,
  type Presenter,
  type TextPresentation,
} from "../../../../sdk/ts/src/agent/index.ts";

const runtimeDirectory = requiredEnv("AB_RUNTIME_DIR");
let profileRequests = 0;
const presentations: TextPresentation[] = [];
const presenter: Presenter = {
  presentText(value) {
    presentations.push(value);
  },
  presentImage() {},
};

const profileServer = http.createServer((request, response) => {
  if (request.url === "/profile") profileRequests += 1;
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end("<!doctype html><html><head><title>Background author profile</title></head><body><h1>Background author profile</h1><button onclick='setTimeout(() => window.close(), 50)'>Close profile</button></body></html>");
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
  const browser = await connect({ presenter });
  await browser.documentation("evaluate");
  chromePid = browser.identity.chrome.pid;
  const detail = await browser.tabs.open(sourceOrigin);
  const baseline = await detail.ax.write("state", {
    mode: "full",
    surface: "active",
    maxChars: 4_000,
    timeoutMs: 5_000,
  });
  const author = baseline.refs().find((ref) => ref.role === "link" && ref.name === "Author");
  assert(author, `author ref missing from source observation: ${baseline.text}`);
  const cover = await browser.tabs.open(`${sourceOrigin}/cover`);
  await cover.activate();

  const hiddenProbe = await detail.dev.evaluate(async () => {
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

  await detail.dev.evaluate(() => {
    (globalThis as typeof globalThis & { __pointerStartedAt: number }).__pointerStartedAt = performance.now();
  });
  const started = performance.now();
  let action;
  try {
    action = await detail.ax.click(author.id, { timeoutMs: 5_000 });
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
      pointerEvents: await detail.dev.evaluate(
        () => (globalThis as typeof globalThis & {
          __pointerEvents: Array<{ type: string; elapsedMs: number; trusted: boolean }>;
        }).__pointerEvents,
      ),
      profileRequests,
    }, null, 2));
    throw error;
  }
  const actionMs = Math.round(performance.now() - started);
  const pointerEvents = await detail.dev.evaluate(
    () => (globalThis as typeof globalThis & {
      __pointerEvents: Array<{ type: string; elapsedMs: number; trusted: boolean }>;
    }).__pointerEvents,
  );

  console.log(JSON.stringify({ checkpoint: "background-action-returned", actionMs, action, pointerEvents }, null, 2));
  assert.match(action.dispatchMechanism, /^cdp\./);
  assert.equal(action.observationOutcome.status, "notRequested");
  assert.equal(action.targetChanges.opened.length, 1, "the action must report its ready child target");
  assert.deepEqual(action.targetChanges.closed, []);
  const opened = action.targetChanges.opened[0];
  assert.equal(opened.openerId, detail.id);
  assert.equal(opened.url, `${profileOrigin}/profile`);
  assert.equal(opened.ownership, "owned");
  const targetPresentation = presentations.find(
    (value) => value.kind === "action" && value.text.startsWith("AB_BROWSER_CHANGE "),
  );
  assert(targetPresentation, "the Agent Presenter must announce non-empty target changes");
  assert.match(targetPresentation.text, new RegExp(opened.targetId));
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
  const sourceStatus = await detail.playwright.getByRole("status").all();
  const status = await Promise.all(sourceStatus.map(async (item) => item.textContent()));
  assert.deepEqual(status, ["1", "true"], "the hidden source must receive one trusted activation");

  const profile = await browser.tabs.get(opened.targetId);
  await profile.playwright.waitForLoadState("load", { timeoutMs: 5_000 });
  const profileState = await profile.ax.write("state", {
    mode: "full",
    surface: "active",
    maxChars: 4_000,
    timeoutMs: 5_000,
  });
  assert.match(profileState.text, /heading "Background author profile"/);
  assert.equal(profileRequests, 1, "the hidden-tab click must navigate one popup exactly once");
  const closeAction = await profile.playwright
    .getByRole("button", { name: "Close profile", exact: true })
    .click({ timeoutMs: 5_000 });
  assert.deepEqual(closeAction.targetChanges.opened, []);
  assert.deepEqual(closeAction.targetChanges.closed, [{ targetId: profile.id }]);
  const closePresentation = presentations.find(
    (value) => value.kind === "action"
      && value.text.startsWith("AB_BROWSER_CHANGE ")
      && value.text.includes(`\"closed\":[{\"targetId\":\"${profile.id}\"}]`),
  );
  assert(closePresentation, "the Agent Presenter must announce the closed root target");

  console.log(JSON.stringify({
    scenario: "background-tab-popup-action",
    hiddenProbe,
    actionMs,
    pointerEvents,
    dispatchMechanism: action.dispatchMechanism,
    observationStatus: action.observationOutcome.status,
    childTabId: profile.id,
    targetChanges: action.targetChanges,
    targetPresentation: targetPresentation.text,
    closeTargetChanges: closeAction.targetChanges,
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
