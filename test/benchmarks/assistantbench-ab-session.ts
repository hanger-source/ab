import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { connect } from "../../sdk/ts/src/index.ts";
import { ABHarRecorder } from "./har.ts";
import { assistantBenchTask, evaluateAssistantBench } from "./assistantbench.ts";

const taskId = required(process.argv[2], "task id");
const outputRoot = required(process.argv[3], "output root");
const task = await assistantBenchTask(taskId);
const directory = join(outputRoot, taskId.replaceAll(".", "_"));
const responsePath = join(directory, "agent_response.json");
const evaluationPath = join(directory, "evaluation.json");
const networkHarPath = join(directory, "network.har");
await mkdir(directory, { recursive: true });

const browser = await connect();
const tab = await browser.tabs.open(required(task.startUrls[0], "start URL"));
const recorder = await ABHarRecorder.start(tab);

try {
  process.stdout.write(`AB_ASSISTANTBENCH_SESSION_READY ${JSON.stringify({
    taskId,
    intent: task.intent,
    startUrl: task.startUrls[0],
    tabId: tab.id,
    outputDirectory: directory,
  })}\n`);

  const answer = await readAnswer();
  await writeFile(responsePath, `${JSON.stringify({ answer }, null, 2)}\n`);
  const evaluation = await evaluateAssistantBench(taskId, answer);
  const har = await recorder.write(networkHarPath);
  await writeFile(evaluationPath, `${JSON.stringify(evaluation, null, 2)}\n`);
  process.stdout.write(`AB_ASSISTANTBENCH_SESSION_RESULT ${JSON.stringify({
    taskId,
    answer,
    evaluation,
    har,
    responsePath,
    evaluationPath,
  })}\n`);
  process.exitCode = evaluation.score > 0 ? 0 : 1;
} finally {
  await recorder.dispose().catch(() => undefined);
  await tab.close().catch(() => undefined);
  await browser.disconnect().catch(() => undefined);
}

async function readAnswer(): Promise<string> {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  try {
    for await (const line of input) {
      if (!line.trim()) continue;
      const value = JSON.parse(line) as { answer?: unknown };
      assert(typeof value.answer === "string", "Agent result requires an answer string");
      return value.answer;
    }
  } finally {
    input.close();
  }
  throw new Error("stdin closed before the Agent supplied an answer");
}

function required(value: string | undefined, name: string): string {
  assert(value, `${name} is required`);
  return value;
}
