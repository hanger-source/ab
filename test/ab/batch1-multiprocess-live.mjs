import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import http from "node:http";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const execFileAsync = promisify(execFile);
const directory = dirname(fileURLToPath(import.meta.url));
const workerPath = join(directory, "batch1-worker.mjs");
const socketPath = join(requiredEnv("AB_RUNTIME_DIR"), "browser.sock");
const runtimeBinary = requiredEnv("AB_RUNTIME_BINARY");

const server = http.createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><html><head><title>AB Process Persistence</title></head>
    <body><button id="action">Persistent page</button></body></html>`);
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

let chromePid;
try {
  const address = server.address();
  assert(address && typeof address === "object");
  const testUrl = `http://127.0.0.1:${address.port}/state`;
  const baseEnvironment = {
    ...process.env,
    AB_RUNTIME_BINARY: runtimeBinary,
    AB_RUNTIME_DIR: requiredEnv("AB_RUNTIME_DIR"),
    AB_DATA_DIR: requiredEnv("AB_DATA_DIR"),
    AB_TEST_URL: testUrl,
  };

  const [concurrentA, concurrentB] = await Promise.all([
    runWorker("identity", baseEnvironment),
    runWorker("identity", baseEnvironment),
  ]);
  assert.notEqual(concurrentA.identity.clientId, concurrentB.identity.clientId);
  assert.equal(concurrentA.identity.daemonId, concurrentB.identity.daemonId);
  assert.equal(
    concurrentA.identity.browserGeneration,
    concurrentB.identity.browserGeneration,
  );

  const created = await runWorker("create", baseEnvironment);
  chromePid = created.identity.chrome.pid;
  assert.equal(created.evaluated.title, "AB Process Persistence");
  assert.equal(created.evaluated.value, "persisted-across-processes");
  assert(created.screenshot.bytes > 100);

  const daemonPid = await listeningPid(socketPath);
  process.kill(daemonPid, "SIGTERM");
  await waitForExit(daemonPid);

  const verified = await runWorker("verify", {
    ...baseEnvironment,
    AB_TEST_TAB_ID: created.tab.id,
  });
  assert.notEqual(verified.identity.daemonId, created.identity.daemonId);
  assert.equal(
    verified.identity.browserGeneration,
    created.identity.browserGeneration,
  );
  assert.equal(verified.identity.chrome.source, "reattached");
  assert.equal(verified.tab.id, created.tab.id);
  assert.deepEqual(verified.evaluated, {
    title: "AB Process Persistence",
    value: "persisted-across-processes",
  });

  console.log(JSON.stringify({
    concurrentClients: [concurrentA.identity, concurrentB.identity],
    created,
    daemonCrash: { pid: daemonPid },
    reattached: verified,
  }, null, 2));
} finally {
  await new Promise((resolve) => server.close(resolve));
  await stopListeningDaemon(socketPath);
  if (typeof chromePid === "number") {
    stopProcess(chromePid);
  }
}

async function runWorker(mode, environment) {
  const { stdout, stderr } = await execFileAsync(process.execPath, [workerPath, mode], {
    env: environment,
    maxBuffer: 1024 * 1024,
  });
  if (stderr.trim()) {
    process.stderr.write(stderr);
  }
  return JSON.parse(stdout);
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
    // The daemon may already have exited after a startup failure.
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

async function waitForExit(pid) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === "ESRCH") {
        return;
      }
      throw error;
    }
    await delay(50);
  }
  throw new Error(`process ${pid} did not exit`);
}

function requiredEnv(name) {
  const value = process.env[name];
  assert(value, `${name} is required`);
  return value;
}
