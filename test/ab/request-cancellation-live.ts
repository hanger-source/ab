import assert from "node:assert/strict";
import http from "node:http";
import { join } from "node:path";
import { ABError, connect } from "../../sdk/ts/src/index.ts";

const runtimeDirectory = requiredEnv("AB_RUNTIME_DIR");
const socketPath = join(runtimeDirectory, "browser.sock");
const server = http.createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  if (_request.url === "/slow") {
    setTimeout(() => {
      response.end("<!doctype html><title>AB slow navigation</title><main><h1>slow-ready</h1></main>");
    }, 600);
    return;
  }
  response.end("<!doctype html><title>AB cancellation</title><main>ready</main>");
});

await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

let chromePid: number | null = null;
let browser;
let tab;
try {
  const address = server.address();
  assert(address && typeof address === "object");
  browser = await connect();
  chromePid = browser.identity.chrome.pid;
  tab = await browser.tabs.open(`http://127.0.0.1:${address.port}/`);

  await tab.evaluate(() => {
    const querySelector = document.querySelector.bind(document);
    globalThis.__AB_QUERY_COUNT__ = 0;
    document.querySelector = ((...args: Parameters<typeof document.querySelector>) => {
      globalThis.__AB_QUERY_COUNT__ += 1;
      return querySelector(...args);
    }) as typeof document.querySelector;
  });

  const controller = new AbortController();
  const streamedTraceEvents: Array<{ traceId: string; name: string }> = [];
  const unsubscribeTrace = browser.diagnostics.onTrace((event) => {
    streamedTraceEvents.push({ traceId: event.traceId, name: event.name });
  });
  const startedAt = performance.now();
  const waiting = tab.waitFor({
    selector: "#never-appears",
    timeoutMs: 20_000,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 120);
  let cancellationError: ABError | undefined;
  await assert.rejects(waiting, (error: unknown) => {
    assert(error instanceof ABError);
    cancellationError = error;
    assert.equal(error.kind, "cancelled");
    assert.equal(error.stage, "request.cancel");
    assert.equal(error.retryable, true);
    assert.equal(error.context?.method, "tab.waitFor");
    assert.equal(error.context?.target?.tabId, tab.id);
    assert.match(error.context?.requestId ?? "", /^[0-9a-f-]{36}$/);
    assert.match(error.context?.traceId ?? "", /^[0-9a-f-]{36}$/);
    return true;
  });
  unsubscribeTrace();
  assert(cancellationError);
  const traceId = cancellationError.context?.traceId;
  assert(traceId);
  const trace = browser.diagnostics.snapshot({ traceId });
  assert.equal(trace.complete, true);
  assert.equal(trace.dropped, 0);
  assert.deepEqual(trace.events.map((event) => event.name), ["dispatched", "settled"]);
  assert(trace.events.every((event) => event.traceId === traceId));
  assert(trace.events.every((event) => event.requestId === cancellationError?.context?.requestId));
  assert(trace.events.every((event) => event.method === "tab.waitFor"));
  assert(trace.events.every((event) => event.target?.tabId === tab.id));
  assert(trace.events.every((event) => event.timestampUnixMs > 0));
  assert.deepEqual(trace.events[1]?.detail, {
    status: "error",
    kind: "cancelled",
    stage: "request.cancel",
    retryable: true,
  });
  assert.deepEqual(
    streamedTraceEvents.filter((event) => event.traceId === traceId).map((event) => event.name),
    ["dispatched", "settled"],
  );
  const settledMs = performance.now() - startedAt;
  assert(settledMs < 1_000, `cancelled request settled after ${settledMs}ms`);

  const countAfterCancel = await tab.evaluate(() => globalThis.__AB_QUERY_COUNT__);
  await Bun.sleep(300);
  const countAfterQuietPeriod = await tab.evaluate(() => globalThis.__AB_QUERY_COUNT__);
  assert.equal(
    countAfterQuietPeriod,
    countAfterCancel,
    "the cancelled waitFor operation continued polling in the background",
  );

  assert.equal(await tab.evaluate(() => document.title), "AB cancellation");

  const sideEffectController = new AbortController();
  let resolveOperationSettled!: () => void;
  const operationSettled = new Promise<void>((resolve) => {
    resolveOperationSettled = resolve;
  });
  let sideEffectTraceId: string | undefined;
  const unsubscribeSideEffectTrace = browser.diagnostics.onTrace((event) => {
    if (event.traceId === sideEffectTraceId && event.name === "operation.settled") {
      resolveOperationSettled();
    }
  });
  const navigationStartedAt = performance.now();
  const navigation = tab.navigate(`http://127.0.0.1:${address.port}/slow`, {
    waitUntil: "load",
    timeoutMs: 5_000,
    signal: sideEffectController.signal,
  });
  setTimeout(() => sideEffectController.abort(), 100);
  let unknownError: ABError | undefined;
  await assert.rejects(navigation, (error: unknown) => {
    assert(error instanceof ABError);
    unknownError = error;
    sideEffectTraceId = error.context?.traceId;
    assert.equal(error.kind, "outcome_unknown");
    assert.equal(error.stage, "request.cancel");
    assert.equal(error.retryable, false);
    return true;
  });
  const callerSettledMs = performance.now() - navigationStartedAt;
  assert(callerSettledMs < 1_000, `side-effect caller settled after ${callerSettledMs}ms`);

  const postCancelSnapshotStartedAt = performance.now();
  const postCancelSnapshot = tab.ax.snapshot({ mode: "full" });
  await Promise.race([
    operationSettled,
    Bun.sleep(2_000).then(() => {
      throw new Error("underlying navigation did not report its terminal state");
    }),
  ]);
  const slowState = await postCancelSnapshot;
  const laneHeldMs = performance.now() - postCancelSnapshotStartedAt;
  assert(slowState.text.includes("slow-ready"), slowState.text);
  assert(laneHeldMs >= 300, `target lane was released after only ${laneHeldMs}ms`);
  assert(sideEffectTraceId);
  const sideEffectTrace = browser.diagnostics.snapshot({ traceId: sideEffectTraceId });
  assert.deepEqual(
    sideEffectTrace.events.map((event) => event.name),
    ["dispatched", "settled", "operation.settled"],
  );
  assert.deepEqual(sideEffectTrace.events[2]?.detail, {
    callerOutcome: "outcome_unknown",
    terminal: { status: "success" },
  });
  unsubscribeSideEffectTrace();
  await slowState.dispose();

  console.log(JSON.stringify({
    settledMs,
    countAfterCancel,
    countAfterQuietPeriod,
    error: {
      kind: cancellationError.kind,
      stage: cancellationError.stage,
      retryable: cancellationError.retryable,
      context: cancellationError.context,
    },
    trace,
    sideEffect: {
      callerSettledMs,
      laneHeldMs,
      error: {
        kind: unknownError?.kind,
        stage: unknownError?.stage,
        retryable: unknownError?.retryable,
      },
      trace: sideEffectTrace,
    },
  }, null, 2));
} finally {
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
