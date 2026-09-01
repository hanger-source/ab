import assert from "node:assert/strict";
import http from "node:http";
import { join } from "node:path";
import { ABError, connect } from "../../sdk/ts/src/index.ts";

const runtimeDirectory = requiredEnv("AB_RUNTIME_DIR");
const socketPath = join(runtimeDirectory, "browser.sock");
const server = http.createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(`<!doctype html>
    <title>AB Dialog</title>
    <button onclick="globalThis.dialogResult=confirm('Proceed?')">Open dialog</button>
    <button>Other action</button>`);
});

await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

let chromePid: number | null = null;
let browser;
let tab;
let dialogs;
try {
  const address = server.address();
  assert(address && typeof address === "object");
  browser = await connect();
  chromePid = browser.identity.chrome.pid;
  tab = await browser.tabs.open(`http://127.0.0.1:${address.port}/`);

  console.log("stage=first-dialog.click.start");
  await tab.getByText("Open dialog", { exact: true }).click({ observe: "none" });
  console.log("stage=first-dialog.click.returned");
  await assert.rejects(
    tab.getByRole("button", { name: "Other action", exact: true }).click({ observe: "none" }),
    (error: unknown) => {
      assert(error instanceof ABError);
      assert.equal(error.kind, "dialog_blocked");
      return true;
    },
  );

  dialogs = await tab.watchDialogs();
  console.log("stage=first-dialog.watcher.open");
  const first = await dialogs.waitForDialog();
  console.log("stage=first-dialog.watcher.received");
  assert.equal(first.message, "Proceed?");
  assert.equal(first.rootTargetId, tab.id);
  assert.equal(first.closed, false);
  const firstClosed = dialogs.waitFor(
    (event) => event.method === "Page.javascriptDialogClosed" && event.params.dialogId === first.id,
  );
  await first.accept();
  await firstClosed;
  assert.equal(first.closed, true);
  assert.equal(first.accepted, true);
  assert.equal(await tab.evaluate(() => globalThis.dialogResult), true);

  const secondPromise = dialogs.waitForDialog();
  await tab.getByText("Open dialog", { exact: true }).click({ observe: "none" });
  const second = await secondPromise;
  await assert.rejects(first.accept(), (error: unknown) => {
    assert(error instanceof ABError);
    assert.equal(error.kind, "stale_dialog");
    return true;
  });
  const secondClosed = dialogs.waitFor(
    (event) => event.method === "Page.javascriptDialogClosed" && event.params.dialogId === second.id,
  );
  await second.dismiss();
  await secondClosed;
  assert.equal(second.closed, true);
  assert.equal(second.accepted, false);
  assert.equal(await tab.evaluate(() => globalThis.dialogResult), false);

  console.log(JSON.stringify({ first: "accepted", second: "dismissed" }, null, 2));
} finally {
  await dialogs?.dispose().catch(() => {});
  await tab?.close().catch(() => {});
  await browser?.disconnect().catch(() => {});
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await stopDaemon(socketPath);
  if (chromePid !== null) stopProcess(chromePid);
}

async function stopDaemon(path: string): Promise<void> {
  const lsof = Bun.spawn(["lsof", "-t", path], { stdout: "pipe", stderr: "ignore" });
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
