import assert from "node:assert/strict";
import http from "node:http";
import { join } from "node:path";
import { ABError, connect } from "../../sdk/ts/src/index.ts";

const runtimeDirectory = requiredEnv("AB_RUNTIME_DIR");
const largeBody = "AB-LARGE-BODY\n".repeat(80_000);
const server = http.createServer((request, response) => {
  if (request.url?.startsWith("/api/orders")) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ orders: [{ id: 7, state: "ready" }] }));
    return;
  }
  if (request.url === "/file") {
    response.writeHead(200, {
      "content-type": "text/plain",
      "content-disposition": "attachment; filename=ab-resource.txt",
    });
    response.end("AB download body");
    return;
  }
  if (request.url === "/api/large") {
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.end(largeBody);
    return;
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(`<!doctype html>
    <html><head><title>AB Resources</title></head><body>
      <button id="load" onclick="fetch('/api/orders').then(r => r.json()).then(v => { globalThis.orders=v.orders; console.log('orders-loaded', v.orders.length); })">Load orders</button>
      <button id="large" onclick="fetch('/api/large').then(r => r.text()).then(v => { globalThis.largeBodyBytes=v.length; })">Load large response</button>
      <button id="dialog" onclick="globalThis.dialogResult=confirm('Proceed?')">Open dialog</button>
      <a id="download" href="/file" download="ab-resource.txt">Download report</a>
      <label>Upload <input id="file" type="file"></label>
    </body></html>`);
});

await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

let chromePid: number | null = null;
let browser;
let tab;
const resources: Array<{ dispose(): Promise<void> }> = [];
try {
  const address = server.address();
  assert(address && typeof address === "object");
  const pageUrl = `http://127.0.0.1:${address.port}/page`;
  browser = await connect();
  chromePid = browser.identity.chrome.pid;
  tab = await browser.tabs.open(pageUrl);
  console.log("stage=tabs.open");

  await assert.rejects(
    tab.addInitScript({ name: "invalid-source", source: "if (" }),
    (error: unknown) => {
      assert(error instanceof ABError);
      assert.equal(error.kind, "init_script_syntax_error");
      return true;
    },
  );

  const initScript = await tab.addInitScript({
    name: "resource-lifecycle",
    world: "main",
    frames: "top",
    args: [1],
    source: `
      globalThis.__AB_INIT_COUNT__ = (globalThis.__AB_INIT_COUNT__ || 0) + Number(args[0]);
      ab.onCommand((name, value) => {
        if (name !== "add") throw new Error("unknown command: " + name);
        globalThis.__AB_INIT_COUNT__ += Number(value);
        return globalThis.__AB_INIT_COUNT__;
      });
      ab.onCleanup(() => { globalThis.__AB_INIT_CLEANED__ = true; });
      ab.emit("installed", { count: globalThis.__AB_INIT_COUNT__ });
    `,
  });
  resources.push(initScript);
  console.log("stage=initScript.open");
  const currentInstance = await initScript.waitForInstance();
  const installed = await initScript.waitFor(
    (event) => event.method === "initScript.event" && event.params.event === "installed",
  );
  assert.deepEqual(installed.params.value, { count: 1 });
  assert.equal(await tab.evaluate(() => globalThis.__AB_INIT_COUNT__), 1);
  assert.equal(await initScript.send(currentInstance, "add", 2), 3);
  assert.equal(await tab.evaluate(() => globalThis.__AB_INIT_COUNT__), 3);
  await tab.navigate(pageUrl);
  assert.equal(await tab.evaluate(() => globalThis.__AB_INIT_COUNT__), 1);
  const currentDocument = (await tab.frames()).find((frame) => frame.parentId === null);
  assert(currentDocument);
  const instances = await initScript.instances();
  assert(instances.some(
    (instance) => instance.documentGeneration === currentDocument.documentGeneration
      && instance.state === "ready",
  ));
  assert(instances.some(
    (instance) => instance.id === currentInstance.id && instance.state === "disposed",
  ));
  console.log("stage=initScript.verified");

  const network = await tab.observeNetwork();
  const artifactNetwork = await tab.observeNetwork({
    bodyRetentionBytes: 8 * 1024 * 1024,
    bodyMemoryBytes: 1024,
    maxBodyBytes: 4 * 1024 * 1024,
    cdpBufferBytes: 8 * 1024 * 1024,
    bodyStorage: "artifact",
  });
  const consoleObserver = await tab.observeConsole();
  resources.push(network, artifactNetwork, consoleObserver);
  assert.equal(network.ownerId, browser.identity.clientId);
  assert.deepEqual(network.scope, { type: "target", targetId: tab.id });
  assert.equal(network.state, "open");
  assert.equal(network.closeReason, null);
  assert(network.createdAtUnixMs > 0);
  console.log("stage=observers.open");
  const responsePromise = network.waitForResponse(
    (event) => String((event.params.response as { url?: string } | undefined)?.url ?? "").includes("/api/orders"),
  );
  const artifactResponsePromise = artifactNetwork.waitForResponse(
    (event) => String((event.params.response as { url?: string } | undefined)?.url ?? "").includes("/api/orders"),
  );
  const consolePromise = consoleObserver.waitForMessage((event) => {
    const args = event.params.args as Array<{ value?: unknown }> | undefined;
    return args?.some((entry) => entry.value === "orders-loaded") ?? false;
  });
  const loadOrdersBaseline = await tab.ax.snapshot({ mode: "full" });
  const loadOrdersAction = await tab.getByRole("button", { name: "Load orders", exact: true }).click({
    observe: "diff",
    baseline: loadOrdersBaseline,
  });
  await loadOrdersAction.observation?.dispose();
  await loadOrdersBaseline.dispose();
  const responseEvent = await responsePromise;
  const artifactResponseEvent = await artifactResponsePromise;
  const consoleEvent = await consolePromise;
  const body = await network.responseBody(responseEvent) as { body?: string; base64Encoded?: boolean };
  assert.equal(body.base64Encoded, false);
  assert.deepEqual(JSON.parse(body.body ?? "null"), { orders: [{ id: 7, state: "ready" }] });
  const artifactBody = await artifactNetwork.responseBody(artifactResponseEvent);
  assert.equal(artifactBody.body, null);
  assert(artifactBody.artifact);
  assert.deepEqual(
    JSON.parse(new TextDecoder().decode(await artifactBody.artifact.read())),
    { orders: [{ id: 7, state: "ready" }] },
  );
  await artifactBody.artifact.dispose();
  await network.assertComplete();
  await artifactNetwork.assertComplete();
  await consoleObserver.assertComplete();
  const networkState = await network.refresh();
  assert(networkState.sequence >= responseEvent.sequence);
  assert.equal(networkState.state, "open");
  assert.equal(networkState.complete, true);
  assert.equal(networkState.gap, false);

  const largeResponsePromise = network.waitForResponse(
    (event) => String((event.params.response as { url?: string } | undefined)?.url ?? "").endsWith("/api/large"),
  );
  await tab.getByRole("button", { name: "Load large response", exact: true }).click({ observe: "none" });
  const largeResponse = await largeResponsePromise;
  await network.waitFor(
    (event) => event.method === "Network.loadingFinished"
      && event.sessionId === largeResponse.sessionId
      && event.params.requestId === largeResponse.params.requestId,
  );
  const capturedLargeBody = await network.responseBody(largeResponse);
  assert.equal(capturedLargeBody.body, null);
  assert.equal(capturedLargeBody.base64Encoded, false);
  assert(capturedLargeBody.artifact);
  assert.equal(capturedLargeBody.artifact.bytes, Buffer.byteLength(largeBody));
  assert.equal(new TextDecoder().decode(await capturedLargeBody.artifact.read()), largeBody);
  await capturedLargeBody.artifact.dispose();
  await assert.rejects(capturedLargeBody.artifact.read(), (error: unknown) => {
    assert(error instanceof ABError);
    assert.equal(error.kind, "resource_disposed");
    return true;
  });
  console.log("stage=network-console.verified");

  const downloads = await tab.watchDownloads();
  resources.push(downloads);
  console.log("stage=download.open");
  const downloadPromise = downloads.waitForDownload();
  await tab.getByRole("link", { name: "Download report" }).click({ observe: "none" });
  const download = await downloadPromise;
  assert.match(download.url, /\/file$/);
  await download.waitForCompleted();
  assert.equal(download.state, "completed");
  assert.equal(download.reason, null);
  assert(download.path);
  assert(download.artifact);
  assert.equal(download.suggestedFilename, "ab-resource.txt");
  assert.equal(download.receivedBytes, Buffer.byteLength("AB download body"));
  assert.equal(download.totalBytes, Buffer.byteLength("AB download body"));
  assert.equal(new TextDecoder().decode(await download.artifact.read()), "AB download body");
  assert.equal((await downloads.downloads()).some((entry) => entry.guid === download.guid), true);
  await download.artifact.dispose();
  console.log("stage=download.verified");

  const choosers = await tab.watchFileChoosers();
  const remainingChooser = await tab.watchFileChoosers();
  resources.push(choosers, remainingChooser);
  console.log("stage=fileChooser.open");
  await choosers.dispose();
  resources.splice(resources.indexOf(choosers), 1);
  const chooserPromise = remainingChooser.waitForChooser();
  await tab.locator("#file").click({ observe: "none" });
  const chooser = await chooserPromise;
  assert.equal(typeof chooser.params.backendNodeId, "number");
  console.log("stage=fileChooser.verified");

  const controller = new AbortController();
  const cancelled = tab.waitFor({ text: "never-appears", timeoutMs: 10_000, signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(cancelled, (error: unknown) => {
    assert(error instanceof ABError);
    assert.equal(error.kind, "cancelled");
    return true;
  });
  console.log("stage=cancel.verified");

  await initScript.dispose();
  resources.splice(resources.indexOf(initScript), 1);
  assert.equal(await tab.evaluate(() => globalThis.__AB_INIT_CLEANED__), true);
  await tab.navigate(pageUrl);
  assert.equal(await tab.evaluate(() => globalThis.__AB_INIT_COUNT__), undefined);

  const lifecycleTab = await browser.tabs.open(pageUrl);
  const lifecycleResource = await lifecycleTab.observeConsole();
  await lifecycleTab.close();
  await waitUntil(() => lifecycleResource.closed, 5_000);
  assert.equal(lifecycleResource.state, "closed");
  assert.equal(lifecycleResource.closeReason, "target_closed");
  assert(lifecycleResource.closedAtUnixMs);
  console.log("stage=target-resource-close.verified");

  console.log(JSON.stringify({
    network: { method: responseEvent.method, body: JSON.parse(body.body ?? "null") },
    console: { method: consoleEvent.method, sequence: consoleEvent.sequence },
    download: {
      guid: download.guid,
      url: download.url,
      state: download.state,
      artifact: download.artifact,
    },
    fileChooser: { method: chooser.method, backendNodeId: chooser.params.backendNodeId },
    cancellation: "cancelled",
    initScriptRemoved: true,
    targetResourceClose: lifecycleResource.closeReason,
  }, null, 2));
} finally {
  for (const resource of resources.reverse()) {
    await resource.dispose().catch(() => {});
  }
  await tab?.close().catch(() => {});
  await browser?.disconnect().catch(() => {});
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

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    assert(Date.now() < deadline, `condition was not true within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
