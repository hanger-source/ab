import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import http from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";
import { connect } from "../../sdk/ts/src/index.ts";

const execFileAsync = promisify(execFile);
const socketPath = join(requiredEnv("AB_RUNTIME_DIR"), "browser.sock");

const server = http.createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(`<!doctype html>
    <html>
      <head><title>AB Batch 1</title></head>
      <body><main><h1>AB native spine</h1><p>${request.url}</p></main></body>
    </html>`);
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

let chromePid;
try {
  const address = server.address();
  assert(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}/first`;

  const first = await connect();
  const tab = await first.tabs.open();
  await tab.navigate(url, { waitUntil: "load" });
  const cdp = await tab.cdp();
  const evaluated = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      localStorage.setItem("ab-batch-1", "persisted");
      return { title: document.title, value: localStorage.getItem("ab-batch-1") };
    })()`,
    returnByValue: true,
  });
  assert.deepEqual(evaluated.result.value, {
    title: "AB Batch 1",
    value: "persisted",
  });
  const screenshot = await tab.screenshot();
  assert(screenshot.bytes > 100);
  assert.equal((await screenshot.read()).byteLength, screenshot.bytes);

  const firstIdentity = first.identity;
  chromePid = firstIdentity.chrome.pid;
  await first.disconnect();

  const second = await connect();
  assert.notEqual(second.identity.clientId, firstIdentity.clientId);
  assert.equal(second.identity.daemonId, firstIdentity.daemonId);
  assert.equal(
    second.identity.browserGeneration,
    firstIdentity.browserGeneration,
  );
  const sameTab = await second.tabs.acquire(tab.id);
  const secondCdp = await sameTab.cdp();
  const persisted = await secondCdp.send("Runtime.evaluate", {
    expression: `({ title: document.title, value: localStorage.getItem("ab-batch-1") })`,
    returnByValue: true,
  });
  assert.deepEqual(persisted.result.value, {
    title: "AB Batch 1",
    value: "persisted",
  });
  await second.disconnect();

  console.log(JSON.stringify({
    firstIdentity,
    secondIdentity: second.identity,
    tab: { id: sameTab.id, url: sameTab.url, title: sameTab.title },
    screenshot: {
      bytes: screenshot.bytes,
      viewportId: screenshot.viewportId,
      width: screenshot.width,
      height: screenshot.height,
    },
    persisted: persisted.result.value,
  }, null, 2));
} finally {
  await new Promise((resolve) => server.close(resolve));
  await stopListeningDaemon(socketPath);
  if (typeof chromePid === "number") {
    stopProcess(chromePid);
  }
}

async function listeningPid(path) {
  const { stdout } = await execFileAsync("lsof", ["-t", path]);
  const pids = [...new Set(stdout.trim().split(/\s+/).filter(Boolean).map(Number))];
  assert.equal(pids.length, 1, `expected one daemon for ${path}, received ${pids}`);
  return pids[0];
}

async function stopListeningDaemon(path) {
  try {
    stopProcess(await listeningPid(path));
  } catch {
    // The isolated daemon may already have exited after a startup failure.
  }
}

function stopProcess(pid) {
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") {
      throw error;
    }
  }
}

function requiredEnv(name) {
  const value = process.env[name];
  assert(value, `${name} is required`);
  return value;
}
