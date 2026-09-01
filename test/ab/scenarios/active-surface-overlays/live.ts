import assert from "node:assert/strict";
import http from "node:http";
import { join } from "node:path";
import { connect } from "../../../../sdk/ts/src/index.ts";

const runtimeDirectory = requiredEnv("AB_RUNTIME_DIR");
const pages = new Map<string, string>([
  ["/empty-overlay", `<!doctype html><html><head><title>Empty overlay</title></head>
    <body>
      <button>Document action</button>
      <div style="position:fixed;inset:0;pointer-events:auto;background:transparent"></div>
    </body></html>`],
  ["/fixed-editor", `<!doctype html><html><head><title>Fixed editor</title></head>
    <body>
      <button>Covered action</button>
      <div style="position:fixed;inset:0;background:white">
        <button>Editor action</button>
      </div>
    </body></html>`],
  ["/absolute-overlay", `<!doctype html><html><head><title>Absolute overlay</title></head>
    <body style="margin:0;position:relative;min-height:100vh">
      <button>Covered document action</button>
      <div style="position:absolute;inset:0;z-index:1200;pointer-events:none;background:rgba(0,0,0,.35)">
        <section style="pointer-events:auto;background:white;width:420px;margin:120px auto;padding:24px">
          <h2>Custom announcement</h2>
          <button>Continue tutorial</button>
        </section>
      </div>
    </body></html>`],
  ["/surface-transitions", `<!doctype html><html><head><title>Surface transitions</title>
    <style>
      .surface { position:fixed;inset:0;background:white;padding:32px;z-index:10 }
      .login { z-index:20 }
      [hidden] { display:none }
    </style></head>
    <body>
      <button id="open-content">Open content</button>
      <p id="document-status">Document ready</p>
      <section id="content" class="surface" role="dialog" aria-modal="true" hidden>
        <h1>Content surface</h1>
        <p id="content-status">Content ready</p>
        <button id="mutate-content">Change content</button>
        <button id="open-login">Open login</button>
        <button id="close-content">Close content</button>
      </section>
      <section id="login" class="surface login" role="dialog" aria-modal="true" hidden>
        <h1>Login surface</h1>
        <label>Email <input></label>
        <button id="close-login">Close login</button>
      </section>
      <script>
        const content = document.querySelector('#content');
        const login = document.querySelector('#login');
        document.querySelector('#open-content').onclick = () => { content.hidden = false };
        document.querySelector('#mutate-content').onclick = () => {
          document.querySelector('#content-status').textContent = 'Content changed';
        };
        document.querySelector('#open-login').onclick = () => { login.hidden = false };
        document.querySelector('#close-login').onclick = () => { login.hidden = true };
        document.querySelector('#close-content').onclick = () => { content.hidden = true };
      </script>
    </body></html>`],
]);
const server = http.createServer((request, response) => {
  const page = pages.get(request.url ?? "");
  response.writeHead(page ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
  response.end(page ?? "not found");
});

await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

let chromePid: number | null = null;
try {
  const address = server.address();
  assert(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const browser = await connect();
  chromePid = browser.identity.chrome.pid;
  const tab = await browser.tabs.open(`${baseUrl}/empty-overlay`);

  const empty = await tab.ax.snapshot({ mode: "full", surface: "active" });
  assert.equal(empty.sources.surface, "document");
  assert(empty.text.includes("Document action"), empty.text);

  await tab.navigate(`${baseUrl}/fixed-editor`);
  const fixed = await tab.ax.snapshot({ mode: "full", surface: "active" });
  assert.equal(fixed.sources.surface, "active");
  assert(fixed.text.includes("Editor action"), fixed.text);
  assert(!fixed.text.includes("Covered action"), fixed.text);

  await tab.navigate(`${baseUrl}/absolute-overlay`);
  const absolute = await tab.ax.snapshot({ mode: "full", surface: "active" });
  assert.equal(absolute.sources.surface, "active");
  assert(absolute.text.includes("Custom announcement"), absolute.text);
  assert(absolute.text.includes("Continue tutorial"), absolute.text);
  assert(!absolute.text.includes("Covered document action"), absolute.text);

  await tab.navigate(`${baseUrl}/surface-transitions`);
  const documentState = await tab.ax.snapshot({ mode: "full", surface: "active" });
  assert.equal(documentState.sources.surface, "document");
  assert(documentState.text.includes("Document ready"), documentState.text);

  await tab.getByRole("button", { name: "Open content", exact: true }).click({ observe: "none" });
  const contentState = await tab.ax.snapshot({
    mode: "full",
    surface: "active",
    diffFrom: documentState,
  });
  assert.equal(contentState.sources.surface, "active");
  assert.equal(contentState.diff?.documentReplaced, false);
  assert.equal(contentState.diff?.surfaceReplaced, true);
  assert.equal(contentState.diff?.text, contentState.text);
  assert(contentState.text.includes("Content surface"), contentState.text);
  assert(!contentState.diff?.text.includes("--- before"), contentState.diff?.text);

  await tab.getByRole("button", { name: "Change content", exact: true }).click({ observe: "none" });
  const changedContentState = await tab.ax.snapshot({
    mode: "full",
    surface: "active",
    diffFrom: contentState,
  });
  assert.equal(changedContentState.diff?.surfaceReplaced, false);
  assert(changedContentState.diff?.text.includes("Content changed"), changedContentState.diff?.text);
  assert(changedContentState.diff?.text.includes("--- before"), changedContentState.diff?.text);

  await tab.getByRole("button", { name: "Open login", exact: true }).click({ observe: "none" });
  const loginState = await tab.ax.snapshot({
    mode: "full",
    surface: "active",
    diffFrom: changedContentState,
  });
  assert.equal(loginState.diff?.surfaceReplaced, true);
  assert(loginState.text.includes("Login surface"), loginState.text);
  assert(!loginState.text.includes("Content surface"), loginState.text);

  await tab.getByRole("button", { name: "Close login", exact: true }).click({ observe: "none" });
  const returnedContentState = await tab.ax.snapshot({
    mode: "full",
    surface: "active",
    diffFrom: loginState,
  });
  assert.equal(returnedContentState.diff?.surfaceReplaced, true);
  assert(returnedContentState.text.includes("Content changed"), returnedContentState.text);

  await tab.getByRole("button", { name: "Close content", exact: true }).click({ observe: "none" });
  const returnedDocumentState = await tab.ax.snapshot({
    mode: "full",
    surface: "active",
    diffFrom: returnedContentState,
  });
  assert.equal(returnedDocumentState.sources.surface, "document");
  assert.equal(returnedDocumentState.diff?.surfaceReplaced, true);
  assert(returnedDocumentState.text.includes("Document ready"), returnedDocumentState.text);

  console.log(JSON.stringify({
    scenario: "active-surface-overlays",
    surfaces: {
      emptyOverlay: empty.sources.surface,
      fixedEditor: fixed.sources.surface,
      absoluteOverlay: absolute.sources.surface,
      transitions: {
        documentToContent: contentState.diff?.surfaceReplaced,
        contentMutation: changedContentState.diff?.surfaceReplaced,
        contentToLogin: loginState.diff?.surfaceReplaced,
        loginToContent: returnedContentState.diff?.surfaceReplaced,
        contentToDocument: returnedDocumentState.diff?.surfaceReplaced,
      },
    },
  }, null, 2));

  await returnedDocumentState.dispose();
  await returnedContentState.dispose();
  await loginState.dispose();
  await changedContentState.dispose();
  await contentState.dispose();
  await documentState.dispose();
  await absolute.dispose();
  await fixed.dispose();
  await empty.dispose();
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
