import assert from "node:assert/strict";
import http from "node:http";
import { join } from "node:path";
import { connect } from "../../../../sdk/ts/src/index.ts";

const runtimeDirectory = requiredEnv("AB_RUNTIME_DIR");
const page = `<!doctype html>
<html>
  <head>
    <title>Animated surface dismissal</title>
    <style>
      body { font: 16px system-ui; margin: 32px }
      .backdrop { position: fixed; inset: 0; display: grid; place-items: center; background: rgb(0 0 0 / 35%); z-index: 10 }
      .dialog { width: 420px; padding: 24px; background: white; border-radius: 12px }
      .backdrop.closing { animation: dismiss 280ms ease-out forwards }
      @keyframes dismiss { from { opacity: 1 } to { opacity: 0 } }
    </style>
  </head>
  <body>
    <button id="open">Open editor</button>
    <p id="status">Document ready</p>
    <script>
      const open = document.querySelector('#open');
      const status = document.querySelector('#status');
      open.addEventListener('click', () => {
        const backdrop = document.createElement('div');
        backdrop.className = 'backdrop';
        backdrop.innerHTML = '<section class="dialog" role="dialog" aria-modal="true" aria-labelledby="title"><h1 id="title">Animated editor</h1><label>Name <input value="draft"></label><button id="cancel">Cancel editor</button></section>';
        document.body.append(backdrop);
        backdrop.querySelector('#cancel').addEventListener('click', () => {
          backdrop.classList.add('closing');
          backdrop.addEventListener('animationend', () => {
            backdrop.remove();
            status.textContent = 'Editor closed';
            open.focus();
          }, { once: true });
        });
      });
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
  const documentState = await tab.ax.snapshot({ mode: "full", surface: "active" });

  const openAction = await tab.getByRole("button", { name: "Open editor", exact: true }).click({
    observe: "state",
    observation: { mode: "full", surface: "active" },
  });
  const dialogState = openAction.observation;
  assert(dialogState, "open action must return its post-action observation");
  assert.equal(dialogState.sources.surface, "active");
  assert(dialogState.text.includes("Animated editor"), dialogState.text);

  const closeAction = await tab.getByRole("button", { name: "Cancel editor", exact: true }).click({
    observe: "diff",
    baseline: dialogState,
  });
  const returnedDocument = closeAction.observation;
  assert(returnedDocument, "close action must return its post-action observation");
  assert.equal(closeAction.observationOutcome.status, "completed");
  assert.equal(returnedDocument.sources.surface, "document");
  assert.equal(returnedDocument.diff?.surfaceReplaced, true);
  assert(returnedDocument.text.includes("Editor closed"), returnedDocument.text);
  assert(!returnedDocument.text.includes("Animated editor"), returnedDocument.text);
  assert.equal(await tab.getByRole("dialog").count(), 0);

  const fresh = await tab.ax.snapshot({ mode: "full", surface: "active" });
  assert(fresh.text.includes("Editor closed"), fresh.text);
  assert.equal(fresh.sources.surface, returnedDocument.sources.surface);

  console.log(JSON.stringify({
    scenario: "animated-surface-dismissal",
    closeAction: {
      status: closeAction.observationOutcome.status,
      lastStage: closeAction.lastStage,
      durationMs: closeAction.timing.durationMs,
      surfaceReplaced: returnedDocument.diff?.surfaceReplaced,
      surface: returnedDocument.sources.surface,
    },
  }, null, 2));

  await fresh.dispose();
  await returnedDocument.dispose();
  await dialogState.dispose();
  await documentState.dispose();
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
