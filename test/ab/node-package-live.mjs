import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { connect } from "@hanger-source/ab/agent";

const execFileAsync = promisify(execFile);
const runtimeDirectory = requiredEnv("AB_RUNTIME_DIR");
const socketPath = join(runtimeDirectory, "browser.sock");
const presented = { text: [], images: [] };
let chromePid;

try {
  const agent = await connect({
    presenter: {
      presentText(value) {
        presented.text.push(value);
      },
      async presentImage(value) {
        assert.equal((await value.screenshot.read()).byteLength, value.screenshot.bytes);
        presented.images.push(value);
        await value.screenshot.dispose();
      },
    },
  });
  chromePid = agent.identity.chrome.pid;
  try {
    const observationDocumentation = await agent.documentation("observation");
    assert.equal(typeof observationDocumentation, "string");
    assert(observationDocumentation.length > 0);
    const tab = await agent.tabs.open();
    await tab.navigate(
      "data:text/html,<title>AB Node ESM</title><button>Node package action</button>",
      { waitUntil: "load" },
    );

    await assert.rejects(
      tab.ax.write("both", { mode: "interactive" }),
      (error) => error?.kind === "documentation_required"
        && error?.stage === "agent.documentation"
        && error?.details?.topic === "screenshot",
    );
    const screenshotDocumentation = await agent.documentation("screenshot");
    assert.match(screenshotDocumentation, /viewportId/);
    await tab.ax.write("both", { mode: "interactive" });

    const documentationPresentations = presented.text.filter(value => value.kind === "documentation");
    const statePresentation = presented.text.find(value => value.kind === "ax");
    assert.equal(documentationPresentations.length, 2);
    assert(statePresentation);
    assert.equal(presented.text.length, 3);
    assert.equal(presented.images.length, 1);
    assert.equal(presented.images[0].screenshot.scale, "css");
    assert.equal(
      presented.images[0].screenshot.width,
      presented.images[0].screenshot.cssViewport.width,
    );
    assert.equal(
      presented.images[0].screenshot.height,
      presented.images[0].screenshot.cssViewport.height,
    );
    assert(documentationPresentations.every(value => value.untrusted === false));
    assert.deepEqual(
      documentationPresentations.map(value => value.origin),
      ["ab:observation", "ab:screenshot"],
    );
    assert.equal(statePresentation.untrusted, true);
    assert.match(statePresentation.text, /Node package action/);
    assert.match(statePresentation.origin, /^data:text\/html/);
    assert.equal(presented.images[0].origin, statePresentation.origin);

    console.log(JSON.stringify({
      runtime: agent.identity.runtimeVersion,
      browserGeneration: agent.identity.browserGeneration,
      documentationChars: observationDocumentation.length,
      observationId: statePresentation.observationId,
      screenshot: {
        bytes: presented.images[0].screenshot.bytes,
        viewportId: presented.images[0].screenshot.viewportId,
        scale: presented.images[0].screenshot.scale,
        cssViewport: presented.images[0].screenshot.cssViewport,
      },
    }, null, 2));
  } finally {
    await agent.disconnect();
  }
} finally {
  await stopListeningDaemon(socketPath);
  if (typeof chromePid === "number") stopProcess(chromePid);
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
    if (error?.code !== "ESRCH") throw error;
  }
}

function requiredEnv(name) {
  const value = process.env[name];
  assert(value, `${name} is required`);
  return value;
}
