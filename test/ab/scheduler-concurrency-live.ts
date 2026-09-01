import assert from "node:assert/strict";
import http from "node:http";
import { join } from "node:path";
import { connect } from "../../sdk/ts/src/index.ts";

const socketPath = join(requiredEnv("AB_RUNTIME_DIR"), "browser.sock");
const server = http.createServer((request, response) => {
  if (request.url?.startsWith("/delay/")) {
    const value = request.url.slice("/delay/".length);
    setTimeout(() => {
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end(value);
    }, 800);
    return;
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end("<!doctype html><title>AB scheduler</title><main>scheduler</main>");
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
  try {
    const [left, right] = await Promise.all([
      browser.tabs.open(`http://127.0.0.1:${address.port}/left`),
      browser.tabs.open(`http://127.0.0.1:${address.port}/right`),
    ]);
    const [leftCdp, rightCdp] = await Promise.all([left.cdp(), right.cdp()]);
    const startedAt = performance.now();
    const [leftResult, rightResult] = await Promise.all([
      evaluateAfter(leftCdp, "left"),
      evaluateAfter(rightCdp, "right"),
    ]);
    const elapsedMs = performance.now() - startedAt;
    assert.equal(leftResult, "left");
    assert.equal(rightResult, "right");
    assert(
      elapsedMs < 1_450,
      `independent tab lanes took ${elapsedMs}ms; requests appear globally serialized`,
    );
    console.log(JSON.stringify({ elapsedMs, leftResult, rightResult }, null, 2));
  } finally {
    await browser.disconnect();
  }
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await stopDaemon(socketPath);
  if (chromePid !== null) {
    stopProcess(chromePid);
  }
}

async function evaluateAfter(
  cdp: { send<T>(method: string, params: unknown): Promise<T> },
  value: string,
): Promise<string> {
  const result = await cdp.send<{ result: { value: string } }>("Runtime.evaluate", {
    expression: `fetch(${JSON.stringify(`/delay/${value}`)}).then(response => response.text())`,
    awaitPromise: true,
    returnByValue: true,
  });
  return result.result.value;
}

async function stopDaemon(path: string): Promise<void> {
  const lsof = Bun.spawn(["lsof", "-t", path], { stdout: "pipe", stderr: "ignore" });
  const output = await new Response(lsof.stdout).text();
  await lsof.exited;
  for (const value of output.trim().split(/\s+/).filter(Boolean)) {
    stopProcess(Number(value));
  }
}

function stopProcess(pid: number): void {
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      throw error;
    }
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  assert(value, `${name} is required`);
  return value;
}
