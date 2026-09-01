import { connect } from "../../../../sdk/ts/src/index.ts";
import assert from "node:assert/strict";
import { join } from "node:path";

const runtimeDirectory = requiredEnv("AB_RUNTIME_DIR");

const child = Bun.serve({
  hostname: "0.0.0.0",
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/nested-same") {
      return new Response(
        `<!doctype html>
        <button id="nested-same" onclick="
          fetch('/nested-data')
            .then(response => response.json())
            .then(data => {
              console.log('nested-data-loaded', data.state);
              top.postMessage('nested-same-clicked', '*');
            })
        ">Nested same under OOPIF</button>`,
        { headers: { "content-type": "text/html" } },
      );
    }
    if (path === "/nested-data") {
      return Response.json({ state: "ready", source: "nested-same" });
    }
    if (path === "/cross-under-same") {
      return new Response(
        `<!doctype html><button id="nested-oopif" onclick="top.postMessage('nested-oopif-clicked', '*')">Nested OOPIF under same</button>`,
        { headers: { "content-type": "text/html" } },
      );
    }
    if (path === "/cross") {
      return new Response(
        `<!doctype html>
        <button id="cross" onclick="top.postMessage('cross-clicked', '*')">Cross click</button>
        <input type="file" aria-label="Cross upload">
        <iframe src="/nested-same"></iframe>`,
        { headers: { "content-type": "text/html" } },
      );
    }
    return new Response("not found", { status: 404 });
  },
});

const top = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/same") {
      return new Response(
        `<!doctype html>
        <button onclick="top.postMessage('same-clicked', '*')">Same click</button>
        <iframe src="http://localhost:${child.port}/cross-under-same"></iframe>`,
        { headers: { "content-type": "text/html" } },
      );
    }
    return new Response(
      `<!doctype html>
      <h1>AB registry OOPIF</h1>
      <iframe src="/same"></iframe>
      <iframe src="http://localhost:${child.port}/cross"></iframe>
      <script>
        globalThis.__events = [];
        addEventListener('message', event => globalThis.__events.push(event.data));
      </script>`,
      { headers: { "content-type": "text/html" } },
    );
  },
});

const browser = await connect();
const chromePid = browser.identity.chrome.pid;
let tab;
let observation;
let choosers;
let initScript;
let network;
let consoleObserver;
let frameCdp;
let cdpOwnerA;
let cdpOwnerB;
try {
  tab = await browser.tabs.open();
  console.log(`stage=tab.open id=${tab.id}`);
  choosers = await tab.watchFileChoosers();
  network = await tab.observeNetwork();
  consoleObserver = await tab.observeConsole();
  initScript = await tab.addInitScript({
    name: "oopif-bridge",
    world: "isolated",
    frames: "all",
    args: ["registry-oopif"],
    source: `
      ab.onCommand((name, value) => {
        if (name !== "identity") throw new Error("unknown command: " + name);
        return { href: location.href, marker: args[0], value };
      });
      ab.onCleanup(() => { globalThis.__AB_INIT_CLEANED__ = true; });
      ab.emit("boot", { href: location.href, marker: args[0] });
    `,
  });
  console.log("stage=dynamic-resources.open");
  await tab.navigate(`http://127.0.0.1:${top.port}/`, {
    waitUntil: "load",
    timeoutMs: 15_000,
  });
  console.log("stage=tab.navigate");

  const deadline = Date.now() + 10_000;
  let frames = await tab.frames();
  let realms = await tab.realms();
  while (
    Date.now() < deadline &&
    (frames.length < 5 || realms.filter((realm) => realm.targetId !== tab.id).length < 2)
  ) {
    await Bun.sleep(50);
    frames = await tab.frames();
    realms = await tab.realms();
  }

  if (frames.length < 5) {
    const cdp = await tab.cdp();
    const targets = await cdp.send("Target.getTargets");
    await cdp.dispose();
    throw new Error(
      `expected root plus four nested child frames, received ${frames.length}: ${JSON.stringify({ frames, realms, targets })}`,
    );
  }
  const crossFrame = frames.find((frame) => new URL(frame.url).pathname === "/cross");
  if (!crossFrame) {
    throw new Error(`cross-origin frame missing: ${JSON.stringify(frames)}`);
  }
  const oopifRealm = realms.find((realm) => realm.frameId === crossFrame.id);
  if (!oopifRealm) {
    throw new Error(`no OOPIF realm route found: ${JSON.stringify(realms)}`);
  }
  const mainFrame = await tab.mainFrame();
  assert.equal(mainFrame.parentId, null);
  assert.equal(mainFrame.id, frames.find((frame) => frame.parentId === null)?.id);
  assert.equal(await tab.getByRole("button", { name: "Cross click" }).count(), 0);
  assert.equal(await crossFrame.getByRole("button", { name: "Cross click" }).count(), 1);
  assert.equal(
    await tab.getByRole("button", { name: "Cross click" }).inFrame(crossFrame.id).count(),
    1,
  );
  const crossSubtree = await tab.ax.snapshot({
    mode: "interactive",
    frames: { root: crossFrame.id },
    maxChars: 8_000,
  });
  assert.equal(crossSubtree.frameId, crossFrame.id);
  assert.equal(crossSubtree.complete, true, JSON.stringify(crossSubtree.sources));
  assert.equal(crossSubtree.sources.frameCount, 2, JSON.stringify(crossSubtree.sources));
  assert.equal(crossSubtree.sources.capturedFrameCount, 2, JSON.stringify(crossSubtree.sources));
  assert(crossSubtree.refs().some((reference) => reference.name === "Cross click"));
  assert(crossSubtree.refs().some((reference) => reference.name === "Nested same under OOPIF"));
  assert(!crossSubtree.refs().some((reference) => reference.name === "Nested OOPIF under same"));
  await crossSubtree.dispose();
  assert.equal(
    await crossFrame.evaluate(() => document.querySelector("#cross")?.textContent),
    "Cross click",
  );
  assert.equal(
    await oopifRealm.evaluate(() => location.hostname),
    "localhost",
  );
  frameCdp = await crossFrame.cdp();
  const frameLocation = await frameCdp.send<{
    result?: { value?: { hostname?: string; frameId?: string } };
  }>("Runtime.evaluate", {
    expression: `({ hostname: location.hostname, frameId: ${JSON.stringify(crossFrame.id)} })`,
    returnByValue: true,
  });
  assert.deepEqual(frameLocation.result?.value, {
    hostname: "localhost",
    frameId: crossFrame.id,
  });

  cdpOwnerA = await tab.cdp();
  cdpOwnerB = await tab.cdp();
  await cdpOwnerA.send("Performance.enable");
  await cdpOwnerB.send("Performance.enable");
  await cdpOwnerA.dispose();
  cdpOwnerA = undefined;
  const metrics = await cdpOwnerB.send<{ metrics?: Array<{ name: string; value: number }> }>(
    "Performance.getMetrics",
  );
  assert(metrics.metrics && metrics.metrics.length > 0, JSON.stringify(metrics));
  await cdpOwnerB.send("Performance.disable");

  let instances = await initScript.instances();
  while (
    Date.now() < deadline
    && instances.filter((instance) => instance.state === "ready").length < 5
  ) {
    await Bun.sleep(50);
    instances = await initScript.instances();
  }
  const readyInstances = instances.filter((instance) => instance.state === "ready");
  assert.equal(readyInstances.length, 5, JSON.stringify(instances));
  assert.deepEqual(
    new Set(readyInstances.map((instance) => instance.frameId)),
    new Set(frames.map((frame) => frame.id)),
  );
  const crossInstance = readyInstances.find((instance) => instance.frameId === crossFrame.id);
  assert(crossInstance, JSON.stringify(readyInstances));
  assert.deepEqual(
    await initScript.send(crossInstance, "identity", { from: "host" }),
    {
      href: `http://localhost:${child.port}/cross`,
      marker: "registry-oopif",
      value: { from: "host" },
    },
  );
  const boot = await initScript.waitFor(
    (event) => event.method === "initScript.event"
      && event.params.event === "boot"
      && (event.params.instance as { frameId?: string } | undefined)?.frameId === crossFrame.id,
  );
  assert.deepEqual(boot.params.value, {
    href: `http://localhost:${child.port}/cross`,
    marker: "registry-oopif",
  });
  const initRealm = realms.find(
    (realm) => realm.frameId === crossFrame.id && realm.name.startsWith("ab-init-"),
  );
  assert(initRealm, JSON.stringify(realms));

  observation = await tab.ax.snapshot({ mode: "interactive", maxChars: 12_000 });
  assert.equal(observation.complete, true, JSON.stringify(observation.sources));
  assert.equal(observation.sources.frameCount, 5, JSON.stringify(observation.sources));
  assert.equal(observation.sources.capturedFrameCount, 5, JSON.stringify(observation.sources));
  assert.deepEqual(observation.sources.gaps, []);
  const crossButton = observation.refs().find(
    (reference) => reference.role === "button" && reference.name === "Cross click",
  );
  if (!crossButton) {
    throw new Error(`cross-origin AX ref missing:\n${observation.text}`);
  }
  const crossUpload = observation.refs().find(
    (reference) => reference.role === "button" && reference.name === "Cross upload",
  );
  if (!crossUpload) {
    throw new Error(`cross-origin file input AX ref missing:\n${observation.text}`);
  }
  const nestedSameButton = observation.refs().find(
    (reference) => reference.role === "button" && reference.name === "Nested same under OOPIF",
  );
  assert(nestedSameButton, observation.text);
  assert(nestedSameButton.bounds && nestedSameButton.bounds.width > 0, JSON.stringify(nestedSameButton));
  const nestedOopifButton = observation.refs().find(
    (reference) => reference.role === "button" && reference.name === "Nested OOPIF under same",
  );
  assert(nestedOopifButton, observation.text);
  assert(nestedOopifButton.bounds && nestedOopifButton.bounds.width > 0, JSON.stringify(nestedOopifButton));
  const chooserPromise = choosers.waitForChooser();
  await crossUpload.click({ observe: "none" });
  const chooser = await chooserPromise;
  assert.equal(chooser.sessionId, oopifRealm.sessionId);
  await crossButton.click({ observe: "none" });

  const responsePromise = network.waitForResponse(
    (event) => new URL(
      String((event.params.response as { url?: string } | undefined)?.url ?? "about:blank"),
    ).pathname === "/nested-data",
  );
  const consolePromise = consoleObserver.waitForMessage((event) => {
    const args = event.params.args as Array<{ value?: unknown }> | undefined;
    return args?.some((entry) => entry.value === "nested-data-loaded") ?? false;
  });
  await nestedSameButton.click({ observe: "none" });
  const responseEvent = await responsePromise;
  const consoleEvent = await consolePromise;
  assert.equal(responseEvent.sessionId, oopifRealm.sessionId);
  assert.equal(consoleEvent.sessionId, oopifRealm.sessionId);
  const responseBody = await network.responseBody(responseEvent);
  assert.equal(responseBody.base64Encoded, false);
  assert.deepEqual(JSON.parse(responseBody.body ?? "null"), {
    state: "ready",
    source: "nested-same",
  });
  await network.assertComplete();
  await consoleObserver.assertComplete();
  await nestedOopifButton.click({ observe: "none" });

  const cdp = await tab.cdp();
  const eventState = await cdp.send<{
    result?: { value?: string[] };
  }>("Runtime.evaluate", {
    expression: "globalThis.__events",
    returnByValue: true,
  });
  await cdp.dispose();
  assert.deepEqual(
    new Set(eventState.result?.value),
    new Set(["cross-clicked", "nested-same-clicked", "nested-oopif-clicked"]),
    JSON.stringify(eventState),
  );

  await initScript.dispose();
  assert.equal(await initRealm.evaluate(() => globalThis.__AB_INIT_CLEANED__), true);

  await tab.navigate("about:blank", { waitUntil: "load", timeoutMs: 10_000 });
  const detachDeadline = Date.now() + 5_000;
  while (Date.now() < detachDeadline && (await tab.frames()).length !== 1) {
    await Bun.sleep(50);
  }
  await assert.rejects(
    () => frameCdp.send("Runtime.evaluate", { expression: "location.href" }),
    (error: unknown) => (error as { kind?: string }).kind === "resource_not_found",
  );
  await assert.rejects(
    () => crossFrame.cdp(),
    (error: unknown) => (error as { kind?: string }).kind === "stale_frame",
  );
  frameCdp = undefined;

  console.log(
    JSON.stringify(
      {
        tabId: tab.id,
        frames: frames.map((frame) => ({
          id: frame.id,
          parentId: frame.parentId,
          url: frame.url,
          documentGeneration: frame.documentGeneration,
        })),
        realmCount: realms.length,
        oopifRealm: {
          id: oopifRealm.id,
          targetId: oopifRealm.targetId,
          frameId: oopifRealm.frameId,
        },
        frameCdp: frameLocation.result?.value,
        sharedCdpDomainLease: metrics.metrics?.length,
        detachedCdpResourceClosed: true,
        crossRef: {
          id: crossButton.id,
          frameId: crossButton.frameId,
        },
        nestedRefs: [nestedSameButton, nestedOopifButton].map((reference) => ({
          id: reference.id,
          frameId: reference.frameId,
          bounds: reference.bounds,
        })),
        events: eventState.result.value,
        fileChooserSessionId: chooser.sessionId,
        dynamicResources: {
          networkSessionId: responseEvent.sessionId,
          consoleSessionId: consoleEvent.sessionId,
          responseBody: JSON.parse(responseBody.body ?? "null"),
        },
        initScript: {
          instances: readyInstances.map((instance) => ({
            id: instance.id,
            frameId: instance.frameId,
            documentGeneration: instance.documentGeneration,
          })),
          command: "identity",
          cleanup: true,
        },
      },
      null,
      2,
    ),
  );
} finally {
  await cdpOwnerB?.dispose().catch(() => {});
  await cdpOwnerA?.dispose().catch(() => {});
  await frameCdp?.dispose().catch(() => {});
  await initScript?.dispose().catch(() => {});
  await consoleObserver?.dispose().catch(() => {});
  await network?.dispose().catch(() => {});
  await choosers?.dispose().catch(() => {});
  await observation?.dispose().catch(() => {});
  await tab?.close().catch(() => {});
  await browser.disconnect().catch(() => {});
  top.stop(true);
  child.stop(true);
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
