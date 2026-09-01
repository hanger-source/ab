import assert from "node:assert/strict";
import http from "node:http";
import { join } from "node:path";
import { ABError, connect } from "../../sdk/ts/src/index.ts";

const runtimeDirectory = requiredEnv("AB_RUNTIME_DIR");
const server = http.createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  if (request.url === "/replacement") {
    response.end(`<!doctype html><html><head><title>Replacement</title></head>
      <body><button>Replacement action</button></body></html>`);
    return;
  }
  response.end(`<!doctype html><html><head><title>AB Observation</title></head>
    <body>
      <main>
        <h1>Agent browser engine</h1>
        <button id="increment" onclick="this.textContent='Incremented'; this.setAttribute('aria-label','Incremented'); window.clickCount=(window.clickCount||0)+1">Increment</button>
        <button id="cua" onclick="window.cuaCount=(window.cuaCount||0)+1">CUA target</button>
        <label>Name <input id="name" aria-label="Name" /></label>
        <a href="#details">Details</a>
        <button hidden>Hidden action</button>
      </main>
    </body></html>`);
});

await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

let chromePid: number | null = null;
try {
  const address = server.address();
  assert(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const browser = await connect();
  chromePid = browser.identity.chrome.pid;
  const tab = await browser.tabs.open(`${baseUrl}/page`);
  const opened = (await browser.tabs.list()).find((candidate) => candidate.id === tab.id);
  assert(opened, "opened tab is missing from Rust target registry");
  assert.equal(opened.active, true, "opened tab is not the visible selected Chrome target");

  const view = await tab.observe({
    ax: { mode: "interactive" },
    screenshot: true,
    scale: "css",
  });
  assert(view.state, "atomic observation did not return AX state");
  assert(view.screenshot, "atomic observation did not return screenshot");
  const first = view.state;
  const shot = view.screenshot;
  assert.deepEqual(
    {
      ax: first.sources.ax,
      dom: first.sources.dom,
      layout: first.sources.layout,
      piercedDom: first.sources.piercedDom,
      refsCovered: first.sources.refsCovered,
    },
    {
      ax: true,
      dom: true,
      layout: true,
      piercedDom: true,
      refsCovered: true,
    },
  );
  assert(first.sources.sessionCount >= 1, JSON.stringify(first.sources));
  assert(first.sources.backendNodeCount > 0, JSON.stringify(first.sources));
  assert(
    shot.viewportId.includes(first.documentGeneration),
    "AX state and screenshot do not share document identity",
  );
  assert.equal(shot.scale, "css");
  assert.equal(shot.width, shot.cssViewport.width);
  assert.equal(shot.height, shot.cssViewport.height);
  assert(shot.cssViewport.deviceScaleFactor >= 1);
  const screenshotBytes = await shot.read();
  assert.equal(screenshotBytes.byteLength, shot.bytes);
  assert(first.text.includes("Increment"), first.text);
  assert(first.text.includes("Name"), first.text);
  assert(!first.text.includes("Hidden action"), first.text);
  const increment = first.refs().find(
    (ref) => ref.role.toLowerCase() === "button" && ref.name === "Increment",
  );
  assert(increment, first.text);
  assert(increment.bounds && increment.bounds.width > 0);
  const cuaTarget = first.refs().find(
    (ref) => ref.role.toLowerCase() === "button" && ref.name === "CUA target",
  );
  assert(cuaTarget?.bounds);
  let shapeMismatch: unknown;
  try {
    await tab.getByRole("button", { name: "Increment", exact: true }).click({
      observe: "diff",
      baseline: first,
      observation: { mode: "full" },
    });
  } catch (error) {
    shapeMismatch = error;
  }
  assert(shapeMismatch instanceof ABError);
  assert.equal(shapeMismatch.kind, "observation_shape_mismatch");
  assert.equal(shapeMismatch.stage, "action.observation.shape");
  const geometryCdp = await tab.cdp();
  const cuaGeometry = await geometryCdp.send<any>("Runtime.evaluate", {
    expression: `(() => { const r = document.querySelector('#cua').getBoundingClientRect(); return { x:r.x,y:r.y,width:r.width,height:r.height }; })()`,
    returnByValue: true,
  });
  await geometryCdp.dispose();
  console.log(JSON.stringify({ stage: "cua.geometry", ref: cuaTarget.bounds, dom: cuaGeometry.result.value, viewport: shot.cssViewport, screenshot: { width: shot.width, height: shot.height, scale: shot.scale } }));
  const cuaAction = await tab.cua.click({
    x: cuaTarget.bounds.x + cuaTarget.bounds.width / 2,
    y: cuaTarget.bounds.y + cuaTarget.bounds.height / 2,
    viewportId: shot.viewportId,
    observe: "diff",
    baseline: first,
  });
  assert.equal(cuaAction.target.source, "cua");
  assert.equal(cuaAction.target.backendNodeId, undefined);
  assert.deepEqual(cuaAction.target.coordinate, {
    viewportId: shot.viewportId,
    x: cuaTarget.bounds.x + cuaTarget.bounds.width / 2,
    y: cuaTarget.bounds.y + cuaTarget.bounds.height / 2,
  });
  assert.equal(cuaAction.dispatchMechanism, "cdp.pointer");
  assert(cuaAction.observation?.diff);

  const clicked = await increment.click({ observe: "diff" });
  assert(clicked.observation);
  assert.equal(clicked.observation.documentGeneration, first.documentGeneration);
  assert(clicked.observation.text.includes("Incremented"));
  assert(clicked.observation.diff);
  assert(clicked.observation.diff.changedRefs.length > 0);
  const name = clicked.observation.refs().find(
    (ref) => ref.role.toLowerCase() === "textbox" && ref.name === "Name",
  );
  assert(name, clicked.observation.text);
  const filled = await name.fill("Hang", { observe: "diff" });
  assert(filled.observation);
  const cdp = await tab.cdp();
  const pageState = await cdp.send<any>("Runtime.evaluate", {
    expression: `({ clickCount: window.clickCount, cuaCount: window.cuaCount, name: document.querySelector('#name').value })`,
    returnByValue: true,
  });
  assert.deepEqual(pageState.result.value, { clickCount: 1, cuaCount: 1, name: "Hang" });

  await tab.navigate(`${baseUrl}/replacement`);
  let staleFailure: unknown;
  try {
    await increment.click({ observe: "none" });
  } catch (error) {
    staleFailure = error;
  }
  assert(staleFailure instanceof ABError);
  assert.equal(staleFailure.kind, "stale_document");
  let staleViewportFailure: unknown;
  try {
    await tab.cua.click({ x: 1, y: 1, viewportId: shot.viewportId });
  } catch (error) {
    staleViewportFailure = error;
  }
  assert(staleViewportFailure instanceof ABError);
  assert.equal(staleViewportFailure.kind, "stale_viewport");

  console.log(JSON.stringify({
    engine: "agent-browser@fbd046c23a2c1156891bda294aaaee715c23b3f1",
    first: {
      observationId: first.id,
      revision: first.revision,
      refs: first.refs().length,
      documentGeneration: first.documentGeneration,
      screenshotArtifact: shot.artifact.id,
    },
    click: {
      changedRefs: clicked.observation.diff.changedRefs,
      revision: clicked.observation.revision,
    },
    pageState: pageState.result.value,
    stale: {
      kind: staleFailure.kind,
      stage: staleFailure.stage,
    },
    shapeMismatch: {
      kind: shapeMismatch.kind,
      stage: shapeMismatch.stage,
    },
    cua: {
      viewportId: shot.viewportId,
      count: pageState.result.value.cuaCount,
      staleKind: staleViewportFailure.kind,
    },
  }, null, 2));

  await filled.observation.dispose();
  await clicked.observation.dispose();
  await cuaAction.observation?.dispose();
  await first.dispose();
  await browser.disconnect();
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await stopDaemon(join(runtimeDirectory, "browser.sock"));
  if (chromePid !== null) {
    stopProcess(chromePid);
  }
}

async function stopDaemon(socketPath: string): Promise<void> {
  const lsof = Bun.spawn(["lsof", "-t", socketPath], {
    stdout: "pipe",
    stderr: "ignore",
  });
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
