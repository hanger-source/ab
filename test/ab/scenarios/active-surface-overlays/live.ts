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

  console.log(JSON.stringify({
    scenario: "active-surface-overlays",
    surfaces: {
      emptyOverlay: empty.sources.surface,
      fixedEditor: fixed.sources.surface,
      absoluteOverlay: absolute.sources.surface,
    },
  }, null, 2));

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
