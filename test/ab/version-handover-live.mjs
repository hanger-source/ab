import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { Socket } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ABError, connect } from "../../sdk/ts/dist/index.js";

const oldBinary = requiredEnv("AB_OLD_RUNTIME_BINARY");
const currentBinary = requiredEnv("AB_RUNTIME_BINARY");
const oldBuildId = requiredEnv("AB_OLD_BUILD_ID");

async function verifyIdleHandover() {
  const root = requiredEnv("AB_HANDOVER_IDLE_ROOT");
  const runtimeDirectory = join(root, "runtime");
  const dataDirectory = join(root, "data");
  const socketPath = join(runtimeDirectory, "browser.sock");
  const oldDaemon = launchOldDaemon(runtimeDirectory, dataDirectory);
  let chromePid;
  let currentDaemonPid;
  try {
    const oldClient = await RawClient.connect(socketPath, oldBuildId);
    const oldIdentity = oldClient.ready;
    chromePid = oldIdentity.chrome.pid;
    const tab = await oldClient.request("tabs.open", { url: "about:blank" });
    await oldClient.close();

    process.env.AB_RUNTIME_DIR = runtimeDirectory;
    process.env.AB_DATA_DIR = dataDirectory;
    process.env.AB_RUNTIME_BINARY = currentBinary;
    const browser = await connect();
    currentDaemonPid = await listeningPid(socketPath);
    try {
      assert.notEqual(browser.identity.daemonId, oldIdentity.daemonId);
      assert.equal(browser.identity.browserGeneration, oldIdentity.browserGeneration);
      assert.equal(browser.identity.chrome.source, "reattached");
      assert.equal((await browser.tabs.get(tab.id)).id, tab.id);
      assert.equal(oldDaemon.exitCode, 0);
      console.log(JSON.stringify({
        stage: "idle-handover",
        oldDaemonId: oldIdentity.daemonId,
        newDaemonId: browser.identity.daemonId,
        browserGeneration: browser.identity.browserGeneration,
        targetId: tab.id,
      }));
    } finally {
      await browser.disconnect();
    }
  } finally {
    stopProcess(currentDaemonPid);
    stopProcess(oldDaemon.pid);
    stopProcess(chromePid);
  }
}

async function verifyActiveOwnerRejection() {
  const root = requiredEnv("AB_HANDOVER_ACTIVE_ROOT");
  const runtimeDirectory = join(root, "runtime");
  const dataDirectory = join(root, "data");
  const socketPath = join(runtimeDirectory, "browser.sock");
  const oldDaemon = launchOldDaemon(runtimeDirectory, dataDirectory);
  let oldClient;
  let chromePid;
  try {
    oldClient = await RawClient.connect(socketPath, oldBuildId);
    chromePid = oldClient.ready.chrome.pid;
    process.env.AB_RUNTIME_DIR = runtimeDirectory;
    process.env.AB_DATA_DIR = dataDirectory;
    process.env.AB_RUNTIME_BINARY = currentBinary;

    await assert.rejects(connect(), (error) => {
      assert(error instanceof ABError);
      assert.equal(error.kind, "daemon_version_in_use");
      assert.equal(error.details?.handoverAllowed, false);
      assert.equal(error.details?.activeClients, 1);
      return true;
    });
    assert.equal((await oldClient.request("tabs.list", {})).length >= 1, true);
    assert.equal(oldDaemon.exitCode, null);
    console.log(JSON.stringify({
      stage: "active-owner-rejected",
      daemonId: oldClient.ready.daemonId,
      browserGeneration: oldClient.ready.browserGeneration,
    }));
  } finally {
    await oldClient?.close();
    stopProcess(oldDaemon.pid);
    stopProcess(chromePid);
  }
}

async function verifyDetachedSideEffectRejection() {
  const root = requiredEnv("AB_HANDOVER_SIDE_EFFECT_ROOT");
  const runtimeDirectory = join(root, "runtime");
  const dataDirectory = join(root, "data");
  const socketPath = join(runtimeDirectory, "browser.sock");
  const oldDaemon = launchOldDaemon(runtimeDirectory, dataDirectory);
  let oldClient;
  let chromePid;
  try {
    oldClient = await RawClient.connect(socketPath, oldBuildId);
    chromePid = oldClient.ready.chrome.pid;
    const tab = await oldClient.request("tabs.open", { url: "about:blank" });
    const requestId = oldClient.startRequest(
      "tab.evaluate",
      {
        expression: "new Promise(resolve => setTimeout(() => resolve('done'), 3000))",
      },
      { tabId: tab.id },
      5_000,
    );
    await oldClient.waitFor((value) =>
      value.type === "stage" && value.requestId === requestId && value.name === "dispatched");
    await oldClient.close();
    oldClient = null;

    process.env.AB_RUNTIME_DIR = runtimeDirectory;
    process.env.AB_DATA_DIR = dataDirectory;
    process.env.AB_RUNTIME_BINARY = currentBinary;
    await assert.rejects(connect(), (error) => {
      assert(error instanceof ABError);
      assert.equal(error.kind, "daemon_version_in_use");
      assert.equal(error.details?.activeClients, 0);
      assert.equal(error.details?.activeSideEffects, 1);
      return true;
    });
    assert.equal(oldDaemon.exitCode, null);
    console.log(JSON.stringify({
      stage: "detached-side-effect-rejected",
      targetId: tab.id,
    }));
  } finally {
    await oldClient?.close();
    stopProcess(oldDaemon.pid);
    stopProcess(chromePid);
  }
}

function launchOldDaemon(runtimeDirectory, dataDirectory) {
  return spawn(oldBinary, [], {
    env: {
      ...process.env,
      AB_RUNTIME_DIR: runtimeDirectory,
      AB_DATA_DIR: dataDirectory,
    },
    stdio: "ignore",
  });
}

class RawClient {
  constructor(socket, ready) {
    this.socket = socket;
    this.ready = ready;
    this.buffer = Buffer.alloc(0);
    this.messages = [];
    this.waiters = [];
    socket.on("data", (chunk) => this.accept(chunk));
  }

  static async connect(socketPath, buildId) {
    const socket = await waitForSocket(socketPath);
    const peer = new RawClient(socket, null);
    peer.send({
      type: "client.hello",
      protocolVersion: 3,
      sdkVersion: "0.1.0",
      buildId,
    });
    const message = await peer.waitFor((value) =>
      value.type === "client.ready" || value.type === "client.rejected");
    if (message.type === "client.rejected") {
      throw new ABError(message.error);
    }
    peer.ready = message;
    return peer;
  }

  async request(method, params, target) {
    const id = this.startRequest(method, params, target);
    const response = await this.waitFor((value) => value.type === "response" && value.id === id);
    if (response.outcome.status === "error") throw new ABError(response.outcome.error);
    return response.outcome.result;
  }

  startRequest(method, params, target, timeoutMs = 30_000) {
    const id = randomUUID();
    this.send({
      type: "request",
      id,
      method,
      trace: { traceId: randomUUID() },
      ...(target ? { target } : {}),
      params,
      deadlineUnixMs: Date.now() + timeoutMs,
    });
    return id;
  }

  send(value) {
    const body = Buffer.from(JSON.stringify(value));
    const frame = Buffer.allocUnsafe(body.length + 4);
    frame.writeUInt32BE(body.length, 0);
    body.copy(frame, 4);
    this.socket.write(frame);
  }

  accept(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0);
      if (this.buffer.length < length + 4) return;
      const value = JSON.parse(this.buffer.subarray(4, length + 4).toString("utf8"));
      this.buffer = this.buffer.subarray(length + 4);
      const waiter = this.waiters.find((candidate) => candidate.predicate(value));
      if (waiter) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        clearTimeout(waiter.timer);
        waiter.resolve(value);
      } else {
        this.messages.push(value);
      }
    }
  }

  waitFor(predicate) {
    const index = this.messages.findIndex(predicate);
    if (index >= 0) return Promise.resolve(this.messages.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        timer: setTimeout(() => {
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          reject(new Error("raw AB client timed out"));
        }, 30_000),
      };
      this.waiters.push(waiter);
    });
  }

  async close() {
    if (this.socket.destroyed) return;
    await new Promise((resolve) => {
      this.socket.once("close", resolve);
      this.socket.end();
    });
  }
}

async function waitForSocket(path) {
  const deadline = Date.now() + 30_000;
  let lastError;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      try {
        return await openSocket(path);
      } catch (error) {
        lastError = error;
      }
    }
    await delay(50);
  }
  throw lastError ?? new Error(`daemon did not expose ${path}`);
}

function openSocket(path) {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
    socket.connect(path);
  });
}

async function listeningPid(path) {
  const child = spawn("lsof", ["-t", path], { stdio: ["ignore", "pipe", "ignore"] });
  const output = await new Response(child.stdout).text();
  await new Promise((resolve) => child.once("exit", resolve));
  const pids = [...new Set(output.trim().split(/\s+/).filter(Boolean).map(Number))];
  assert.equal(pids.length, 1, `expected one daemon for ${path}, received ${pids}`);
  return pids[0];
}

function stopProcess(pid) {
  if (typeof pid !== "number") return;
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function requiredEnv(name) {
  const value = process.env[name];
  assert(value, `${name} is required`);
  return value;
}

await verifyIdleHandover();
await verifyDetachedSideEffectRejection();
await verifyActiveOwnerRejection();
