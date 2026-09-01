import assert from "node:assert/strict";
import { createInterface } from "node:readline";
import { connect } from "../../sdk/ts/src/index.ts";
import { ABHarRecorder } from "./har.ts";
import { BenchmarkTaskTabs } from "./task-tabs.ts";
import {
  createWebArenaRun,
  evaluateWebArenaRun,
  materializeWebArenaUrl,
  webArenaVerifiedTask,
  writeWebArenaAgentResponse,
  type WebArenaAgentResponse,
} from "./webarena-verified.ts";

const taskId = Number(required(process.argv[2], "task id"));
const outputRoot = required(process.argv[3], "output root");
const task = await webArenaVerifiedTask(taskId);
assert(task.sites.length > 0, `task ${taskId} has no sites`);
const startUrls = task.startUrls.map((url) => materializeWebArenaUrl(url));
assert(startUrls.length > 0, `task ${taskId} has no start URLs`);
const run = await createWebArenaRun(outputRoot, taskId);
const browser = await connect();
const taskTabs = await BenchmarkTaskTabs.create(browser);
const tabs = await taskTabs.open(startUrls.length);
const authSessions = await Promise.all(tabs.map((tab, index) => prepareSiteAuthentication(
  tab,
  required(task.startUrls[index], `raw start URL ${index}`),
)));
const recorder = await ABHarRecorder.start(tabs);
taskTabs.followNetwork(recorder);

try {
  await Promise.all(tabs.map((tab, index) => tab.navigate(
    required(startUrls[index], `start URL ${index}`),
    { waitUntil: "domcontentloaded", timeoutMs: 120_000 },
  )));
  await tabs[0]!.activate();
  process.stdout.write(`AB_WEBARENA_SESSION_READY ${JSON.stringify({
    taskId,
    intent: task.intent,
    sites: task.sites,
    startUrls,
    tabs: tabs.map((tab) => ({ id: tab.id, url: tab.url })),
    outputDirectory: run.directory,
  })}\n`);

  const response = await readAgentResponse();
  await writeWebArenaAgentResponse(run, response);
  await taskTabs.synchronize();
  const har = await recorder.write(run.networkHarPath);
  const evaluation = await evaluateWebArenaRun(outputRoot, taskId);
  process.stdout.write(`AB_WEBARENA_SESSION_RESULT ${JSON.stringify({
    taskId,
    response,
    har,
    evaluation,
  })}\n`);
  process.exitCode = evaluation.exitCode;
} finally {
  await taskTabs.stopFollowing().catch(() => undefined);
  await recorder.dispose().catch(() => undefined);
  await Promise.all(authSessions.map((session) => session?.dispose().catch(() => undefined)));
  await taskTabs.close().catch(() => undefined);
  await browser.disconnect().catch(() => undefined);
}

async function prepareSiteAuthentication(
  tab: typeof tabs[number],
  rawStartUrl: string,
) {
  const headers = siteAuthenticationHeaders(rawStartUrl);
  if (Object.keys(headers).length === 0) return null;
  const session = await tab.cdp();
  try {
    await session.send("Network.enable");
    await session.send("Network.setExtraHTTPHeaders", { headers });
    return session;
  } catch (error) {
    await session.dispose().catch(() => undefined);
    throw error;
  }
}

function siteAuthenticationHeaders(rawStartUrl: string): Record<string, string> {
  if (rawStartUrl.includes("__SHOPPING_ADMIN__")) {
    return {
      "X-M2-Admin-Auto-Login": process.env.AB_WEBARENA_SHOPPING_ADMIN_AUTH ?? "admin:admin1234",
    };
  }
  if (rawStartUrl.includes("__SHOPPING__")) {
    return {
      "X-M2-Customer-Auto-Login": process.env.AB_WEBARENA_SHOPPING_AUTH
        ?? "emma.lopez@gmail.com:Password.123",
    };
  }
  if (rawStartUrl.includes("__REDDIT__")) {
    return {
      "X-Postmill-Auto-Login": process.env.AB_WEBARENA_REDDIT_AUTH ?? "MarvelsGrantMan136:test1234",
    };
  }
  return {};
}

async function readAgentResponse(): Promise<WebArenaAgentResponse> {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  try {
    for await (const line of input) {
      if (!line.trim()) continue;
      const value = JSON.parse(line) as WebArenaAgentResponse;
      assert(typeof value.task_type === "string", "agent response requires task_type");
      assert(typeof value.status === "string", "agent response requires status");
      assert(value.retrieved_data === null || Array.isArray(value.retrieved_data));
      assert(value.error_details === null || typeof value.error_details === "string");
      return value;
    }
  } finally {
    input.close();
  }
  throw new Error("stdin closed before the Agent supplied a response");
}

function required(value: string | undefined, name: string): string {
  assert(value, `${name} is required`);
  return value;
}
