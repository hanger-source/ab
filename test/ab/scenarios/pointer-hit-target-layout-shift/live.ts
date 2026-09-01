import assert from "node:assert/strict";
import http from "node:http";
import { join } from "node:path";
import { connect } from "../../../../sdk/ts/src/index.ts";

const runtimeDirectory = requiredEnv("AB_RUNTIME_DIR");
const page = `<!doctype html>
<html>
  <head><title>Pointer hit target layout shift</title></head>
  <body>
    <table>
      <tbody>
        <tr>
          <td id="action-cell" style="width:420px;height:48px">
            <a id="edit-link" href="/review/349">Edit review</a>
          </td>
        </tr>
      </tbody>
    </table>
    <output id="activations">0</output>
    <script>
      const cell = document.querySelector('#action-cell');
      const link = document.querySelector('#edit-link');
      const activations = document.querySelector('#activations');
      cell.addEventListener('mousemove', () => {
        link.style.transform = 'translateX(240px)';
        link.style.display = 'inline-block';
      }, { once: true });
      link.addEventListener('click', event => {
        event.preventDefault();
        activations.value = String(Number(activations.value) + 1);
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

  const action = await tab
    .getByRole("link", { name: "Edit review", exact: true })
    .click();

  assert.match(action.dispatchMechanism, /^cdp\./);
  assert.equal(
    await tab.getByRole("status").textContent(),
    "1",
    "one semantic click must produce exactly one trusted anchor activation",
  );

  console.log(JSON.stringify({
    scenario: "pointer-hit-target-layout-shift",
    durationMs: action.timing.durationMs,
    dispatchMechanism: action.dispatchMechanism,
  }, null, 2));

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
