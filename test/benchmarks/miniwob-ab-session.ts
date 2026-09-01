import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { connect } from "../../sdk/ts/src/index.ts";
import { ABHarRecorder } from "./har.ts";
import {
  miniWobTask,
  beginMiniWobEpisode,
  BROWSERGYM_MINIWOB_EPISODE_MAX_TIME_MS,
  readMiniWobResult,
  startMiniWobServer,
  type MiniWobEpisodeResult,
} from "./miniwob.ts";

const taskId = required(process.argv[2], "task id");
const outputRoot = required(process.argv[3], "output root");
const timeoutMs = Number(process.env.AB_MINIWOB_AGENT_TIMEOUT_MS ?? 120_000);
assert(Number.isFinite(timeoutMs) && timeoutMs > 0, "AB_MINIWOB_AGENT_TIMEOUT_MS must be positive");
const episodeSeed = Number(process.env.AB_MINIWOB_SEED ?? randomInt(1_000_000));
const episodeMaxTimeMs = Number(
  process.env.AB_MINIWOB_EPISODE_MAX_TIME_MS ?? BROWSERGYM_MINIWOB_EPISODE_MAX_TIME_MS,
);
assert(Number.isInteger(episodeSeed) && episodeSeed >= 0, "AB_MINIWOB_SEED must be a non-negative integer");
assert(
  Number.isFinite(episodeMaxTimeMs) && episodeMaxTimeMs > 0,
  "AB_MINIWOB_EPISODE_MAX_TIME_MS must be positive",
);

const task = await miniWobTask(taskId);
const directory = join(outputRoot, taskId);
const evaluationPath = join(directory, "evaluation.json");
const networkHarPath = join(directory, "network.har");
await mkdir(directory, { recursive: true });

const server = startMiniWobServer();
const browser = await connect();
const tab = await browser.tabs.open();
const recorder = await ABHarRecorder.start(tab);

try {
  const instruction = await beginMiniWobEpisode(tab, server.taskUrl(taskId), {
    seed: episodeSeed,
    episodeMaxTimeMs,
  });
  const deadlineUnixMs = Date.now() + timeoutMs;
  process.stdout.write(`AB_MINIWOB_SESSION_READY ${JSON.stringify({
    taskId,
    intent: instruction,
    episode: { seed: episodeSeed, maxTimeMs: episodeMaxTimeMs, harness: "browsergym-miniwob" },
    tab: { id: tab.id, url: tab.url },
    evaluator: task.evaluation,
    deadlineUnixMs,
    outputDirectory: directory,
  })}\n`);

  const result = await waitForResult(deadlineUnixMs);
  const har = await recorder.write(networkHarPath);
  const evaluation = {
    taskId,
    instruction,
    episode: { seed: episodeSeed, maxTimeMs: episodeMaxTimeMs, harness: "browsergym-miniwob" },
    tab: { id: tab.id, url: tab.url },
    result,
    har,
    evaluatedAtUnixMs: Date.now(),
  };
  await writeFile(evaluationPath, `${JSON.stringify(evaluation, null, 2)}\n`);
  process.stdout.write(`AB_MINIWOB_SESSION_RESULT ${JSON.stringify({
    ...evaluation,
    evaluationPath,
  })}\n`);
  process.exitCode = result.passed ? 0 : 1;
} finally {
  await recorder.dispose().catch(() => undefined);
  await tab.close().catch(() => undefined);
  await browser.disconnect().catch(() => undefined);
  server.stop();
}

async function waitForResult(deadlineUnixMs: number): Promise<MiniWobEpisodeResult> {
  while (Date.now() < deadlineUnixMs) {
    const result = await readMiniWobResult(tab);
    if (result.episodeId > 0 && result.done) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return readMiniWobResult(tab);
}

function required(value: string | undefined, name: string): string {
  assert(value, `${name} is required`);
  return value;
}
