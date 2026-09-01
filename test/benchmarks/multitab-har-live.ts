import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type Tab } from "../../sdk/ts/src/index.ts";
import { ABHarRecorder } from "./har.ts";
import { BenchmarkTaskTabs } from "./task-tabs.ts";

const runtimeDirectory = requiredEnv("AB_RUNTIME_DIR");
const largePayload = "AB-HAR-LARGE\n".repeat(80_000);
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/a" || path === "/b" || path === "/c" || path === "/d") {
      const name = path.slice(1);
      if (name === "c") {
        return new Response(`<!doctype html><title>c</title>
          <button id="load" onclick="fetch('/api/c').then(response => response.json()).then(value => { document.body.dataset.result = value.name; })">Load C</button>`,
        { headers: { "content-type": "text/html" } });
      }
      return new Response(`<!doctype html><title>${name}</title>
        ${name === "a" ? '<button id="open" onclick="document.body.dataset.openClicked = \'yes\'; const child = window.open(\'about:blank\'); setTimeout(() => { child.location = \'/c\'; }, 500)">Open C</button>' : ""}
        <script>
        fetch('${name === "a" ? "/redirect/a" : `/api/${name}`}').then(response => response.json()).then(value => {
          document.body.dataset.result = value.name;
        });
      </script>`,
      { headers: { "content-type": "text/html" } });
    }
    if (path === "/redirect/a") {
      return Response.redirect(new URL("/api/a", request.url), 302);
    }
    if (path === "/api/a" || path === "/api/b" || path === "/api/c" || path === "/api/d") {
      return Response.json({ name: path.slice(-1), payload: largePayload });
    }
    return new Response("not found", { status: 404 });
  },
});

const browser = await connect();
const chromePid = browser.identity.chrome.pid;
const taskTabs = await BenchmarkTaskTabs.create(browser);
const otherTaskTabs = await BenchmarkTaskTabs.create(browser);
let tabs: Tab[] = [];
let otherTabs: Tab[] = [];
let recorder: ABHarRecorder | undefined;
try {
  tabs = await taskTabs.open(2);
  otherTabs = await otherTaskTabs.open(1);
  recorder = await ABHarRecorder.start(tabs);
  taskTabs.followNetwork(recorder);
  await Promise.all(tabs.map((tab, index) => tab.navigate(
    `http://127.0.0.1:${server.port}/${index === 0 ? "a" : "b"}`,
    { waitUntil: "load", timeoutMs: 10_000 },
  )));
  await Promise.all(tabs.map((tab, index) => waitForResult(tab, index === 0 ? "a" : "b")));
  await otherTabs[0]!.navigate(`http://127.0.0.1:${server.port}/d`, {
    waitUntil: "load",
    timeoutMs: 10_000,
  });
  await waitForResult(otherTabs[0]!, "d");
  assert.deepEqual((await taskTabs.current()).map((tab) => tab.id).sort(), tabs.map((tab) => tab.id).sort());
  assert.deepEqual((await otherTaskTabs.current()).map((tab) => tab.id), [otherTabs[0]!.id]);

  await tabs[0]!.activate();
  const openAction = await tabs[0]!.locator("#open").click({ observe: "none" });
  const clickReachedPage = await tabs[0]!.evaluate(() => document.body.dataset.openClicked ?? null);
  assert.equal(clickReachedPage, "yes", `open trigger click did not reach the page: ${JSON.stringify(openAction)}`);
  const lateTab = await waitForTaskChildTab(taskTabs, new Set(tabs.map((tab) => tab.id)));
  await waitForPath(lateTab, "/c");
  await lateTab.locator("#load").click({ observe: "none" });
  await waitForResult(lateTab, "c");

  const directory = await mkdtemp(join(tmpdir(), "ab-multitab-har."));
  const path = join(directory, "network.har");
  const result = await recorder.write(path);
  const har = JSON.parse(await readFile(path, "utf8")) as {
    log: { entries: Array<{
      request: { url: string };
      response: { content: { text?: string; encoding?: string } };
      _ab?: { sessionId?: string };
    }> };
  };
  const paths = new Set(har.log.entries.map((entry) => new URL(entry.request.url).pathname));
  for (const required of ["/a", "/redirect/a", "/api/a", "/b", "/api/b", "/api/c"]) {
    assert(paths.has(required), `HAR is missing ${required}: ${JSON.stringify([...paths])}`);
  }
  assert(!paths.has("/d") && !paths.has("/api/d"), `HAR crossed task ownership: ${JSON.stringify([...paths])}`);
  for (const required of ["/api/a", "/api/b", "/api/c"]) {
    const entry = har.log.entries.find((candidate) => new URL(candidate.request.url).pathname === required);
    assert(entry?.response.content.text, `HAR is missing body for ${required}`);
    assert.equal(entry.response.content.encoding, undefined);
    const body = JSON.parse(entry.response.content.text) as { name: string; payload: string };
    assert.equal(body.name, required.slice(-1));
    assert.equal(body.payload, largePayload);
  }
  const sessions = new Set(har.log.entries
    .map((entry) => entry._ab?.sessionId)
    .filter((value): value is string => typeof value === "string"));
  assert.equal(sessions.size, 3, JSON.stringify([...sessions]));
  assert.equal(result.complete, true, JSON.stringify(result));
  assert.deepEqual(result.attachmentFailures, []);
  assert.deepEqual(result.lateAttachedTargets, []);
  assert.equal(result.targets.length, 3);
  assert(result.entries >= 5, JSON.stringify(result));
  await taskTabs.close();
  assert((await browser.tabs.list()).some((tab) => tab.id === otherTabs[0]!.id), "closing one task removed another task's tab");
  process.stdout.write(`${JSON.stringify({
    tabs: result.targets,
    lateAttachedTargets: result.lateAttachedTargets,
    entries: result.entries,
    sessions: sessions.size,
    paths: [...paths].sort(),
    har: path,
  }, null, 2)}\n`);
} finally {
  await taskTabs.stopFollowing().catch(() => undefined);
  await recorder?.dispose().catch(() => undefined);
  await taskTabs.close().catch(() => undefined);
  await otherTaskTabs.close().catch(() => undefined);
  await browser.disconnect().catch(() => undefined);
  server.stop(true);
  await stopDaemon(join(runtimeDirectory, "browser.sock"));
  if (chromePid !== null) stopProcess(chromePid);
}

async function waitForTaskChildTab(taskTabs: BenchmarkTaskTabs, existing: ReadonlySet<string>): Promise<Tab> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const tabs = await taskTabs.current();
    const match = tabs.find((tab) => !existing.has(tab.id));
    if (match) return match;
    await Bun.sleep(25);
  }
  const live = await browser.tabs.list();
  throw new Error(`task child tab did not appear: ${JSON.stringify({
    tabs: live.map((tab) => ({ id: tab.id, openerId: tab.openerId, url: tab.url })),
  })}`);
}

async function waitForResult(tab: Tab, expected: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await tab.evaluate(() => document.body.dataset.result) === expected) return;
    await Bun.sleep(25);
  }
  throw new Error(`tab ${tab.id} did not load ${expected}`);
}

async function waitForPath(tab: Tab, expected: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await tab.evaluate(() => location.pathname).catch(() => null) === expected) return;
    await Bun.sleep(25);
  }
  throw new Error(`tab ${tab.id} did not navigate to ${expected}`);
}

async function stopDaemon(socketPath: string): Promise<void> {
  const process = Bun.spawn(["lsof", "-t", socketPath], { stdout: "pipe", stderr: "ignore" });
  const output = await new Response(process.stdout).text();
  await process.exited;
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
