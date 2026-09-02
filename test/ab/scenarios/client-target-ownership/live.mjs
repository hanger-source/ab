import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import http from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const worker = join(import.meta.dirname, "worker.mjs");
const { connect } = await import(requiredEnv("AB_SKILL_CLIENT"));
const server = http.createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(request.url === "/child"
    ? "<!doctype html><title>Owned child</title><h1>Owned child</h1>"
    : '<!doctype html><title>Owned source</title><a href="/child" target="_blank">Open child</a>');
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

let browser;
let source;
let popup;
try {
  const address = server.address();
  assert(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  browser = await connect();
  await browser.documentation("tabs");
  source = await browser.tabs.open(origin);
  assert.equal(source.ownership, "owned");

  const conflict = await runWorker("conflict", source.id);
  assert.equal(conflict.error.kind, "target_in_use");

  popup = await source.expectPopup(
    () => source.playwright.getByRole("link", { name: "Open child", exact: true }).click(),
    { timeoutMs: 5_000 },
  );
  assert.equal(popup.openerId, source.id);
  assert.equal(popup.ownership, "owned");
  assert.equal(new URL(popup.url).pathname, "/child");
  await popup.close();
  popup = null;

  const sourceId = source.id;
  await browser.disconnect();
  browser = null;
  const takeover = await runWorker("takeover", sourceId);
  assert.equal(takeover.ownership, "owned");
  assert.equal(takeover.closed, true);
  source = null;

  console.log(JSON.stringify({
    scenario: "client-target-ownership",
    conflict,
    popup: { inherited: true, path: "/child" },
    takeover,
  }, null, 2));
} finally {
  if (popup) await popup.close().catch(() => undefined);
  if (source && browser) await source.close().catch(() => undefined);
  if (browser) await browser.disconnect().catch(() => undefined);
  await new Promise((resolve) => server.close(resolve));
}

async function runWorker(mode, targetId) {
  const { stdout, stderr } = await execFileAsync("bun", [worker, mode], {
    env: { ...process.env, AB_TEST_TAB_ID: targetId },
    maxBuffer: 1024 * 1024,
  });
  if (stderr.trim()) process.stderr.write(stderr);
  return JSON.parse(stdout);
}

function requiredEnv(name) {
  const value = process.env[name];
  assert(value, `${name} is required`);
  return value;
}
