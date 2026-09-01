import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { connect } from "../../sdk/ts/src/index.ts";
import { ABHarRecorder } from "./har.ts";
import { BenchmarkTaskTabs } from "./task-tabs.ts";
import {
  assertVisualWebArenaEvaluationReady,
  evaluateVisualWebArenaOfficial,
  materializeVisualWebArenaUrl,
  visualWebArenaTask,
} from "./visualwebarena.ts";

const taskId = required(process.argv[2], "task id");
const outputRoot = required(process.argv[3], "output root");
const task = await visualWebArenaTask(taskId);
assert(task.sites.length > 0, `task ${taskId} has no sites`);
await assertVisualWebArenaEvaluationReady(task);
const startUrls = task.startUrls.map((url, index) =>
  materializeVisualWebArenaUrl(required(url, `start URL ${index}`))
);
assert(startUrls.length > 0, `task ${taskId} has no start URLs`);
const directory = join(outputRoot, taskId.replaceAll(":", "_"));
const networkHarPath = join(directory, "network.har");
const evaluationPath = join(directory, "evaluation.json");
await mkdir(directory, { recursive: true });

const browser = await connect();
const taskTabs = await BenchmarkTaskTabs.create(browser);
const tabs = await taskTabs.open(startUrls.length);
const recorder = await ABHarRecorder.start(tabs);
taskTabs.followNetwork(recorder);
let evaluationCompleted = false;

try {
  await Promise.all(tabs.map((tab, index) => tab.navigate(
    required(startUrls[index], `start URL ${index}`),
    { waitUntil: "load", timeoutMs: 60_000 },
  )));
  await requiredValue(tabs[0], "first task tab").activate();
  process.stdout.write(`AB_VISUALWEBARENA_SESSION_READY ${JSON.stringify({
    taskId,
    intent: task.intent,
    sites: task.sites,
    startUrls,
    inputImages: task.inputImages,
    tabs: tabs.map((tab) => ({ id: tab.id, url: tab.url })),
    outputDirectory: directory,
  })}\n`);

  const agentResult = await readAgentResult();
  const currentTabs = await taskTabs.current();
  const activeTabs = currentTabs.filter((tab) => tab.active);
  assert.equal(
    activeTabs.length,
    1,
    `VisualWebArena evaluation requires exactly one active task tab; found ${activeTabs.length}`,
  );
  const activeTab = requiredValue(activeTabs[0], "active task tab");
  const har = await recorder.write(networkHarPath);
  await recorder.dispose();
  const evaluation = await evaluateVisualWebArenaOfficial(
    task,
    activeTab.id,
    agentResult.answer,
    directory,
  );
  evaluationCompleted = true;
  await writeFile(evaluationPath, `${JSON.stringify({
    agentResult,
    activeTab: { id: activeTab.id, url: activeTab.url },
    evaluation,
  }, null, 2)}\n`);
  process.stdout.write(`AB_VISUALWEBARENA_SESSION_RESULT ${JSON.stringify({
    taskId,
    agentResult,
    activeTab: { id: activeTab.id, url: activeTab.url },
    evaluation,
    har,
    evaluationPath,
  })}\n`);
  process.exitCode = evaluation.score === 1 ? 0 : 1;
} finally {
  await taskTabs.stopFollowing().catch(() => undefined);
  await recorder.dispose().catch(() => undefined);
  if (evaluationCompleted) {
    await taskTabs.close().catch(() => undefined);
  } else {
    process.stderr.write("AB_VISUALWEBARENA_SESSION_PRESERVED evaluator did not complete; task tabs remain open\n");
  }
  await browser.disconnect().catch(() => undefined);
}

async function readAgentResult(): Promise<{ answer: string }> {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  try {
    for await (const line of input) {
      if (!line.trim()) continue;
      const value = JSON.parse(line) as { answer?: unknown };
      assert(typeof value.answer === "string", "Agent result requires an answer string");
      return { answer: value.answer };
    }
  } finally {
    input.close();
  }
  throw new Error("stdin closed before the Agent completed the task");
}

function required(value: string | undefined, name: string): string {
  assert(value, `${name} is required`);
  return value;
}

function requiredValue<T>(value: T | undefined, name: string): T {
  assert(value !== undefined, `${name} is required`);
  return value;
}
