import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

type LiveCase = {
  name: string;
  file: string;
  timeoutMs?: number;
  default: boolean;
  headless?: boolean;
  requires?: readonly string[];
};

const root = resolve(import.meta.dirname, "../..");
const runtimeBinary = process.env.AB_RUNTIME_BINARY
  ? resolve(process.env.AB_RUNTIME_BINARY)
  : join(root, "sdk/native/darwin-arm64/bin/ab-runtime");
const skillClient = join(root, "skills/ab/scripts/ab-client.mjs");
const cases: LiveCase[] = [
  { name: "native-smoke", file: "batch1-smoke-live.mjs", default: true },
  { name: "multiprocess-persistence", file: "batch1-multiprocess-live.mjs", default: true },
  { name: "node-package", file: "node-package-live.mjs", default: true },
  { name: "profile-lock", file: "profile-lock-live.ts", default: true },
  {
    name: "oopif-registry-resources-cdp",
    file: "scenarios/oopif-session-registry/live.ts",
    timeoutMs: 90_000,
    default: true,
  },
  { name: "observation-actions", file: "observation-action-live.ts", default: true },
  {
    name: "scenario-large-document-local-mutation",
    file: "scenarios/large-document-local-mutation/live.ts",
    timeoutMs: 90_000,
    default: true,
  },
  {
    name: "scenario-active-surface-overlays",
    file: "scenarios/active-surface-overlays/live.ts",
    default: true,
  },
  {
    name: "scenario-icon-font-accessible-name",
    file: "scenarios/icon-font-accessible-name/live.ts",
    default: true,
  },
  { name: "locator-semantics", file: "locator-semantics-live.ts", default: true },
  { name: "resource-locator-cancel", file: "resources-locator-cancel-live.ts", default: true },
  { name: "request-cancellation", file: "request-cancellation-live.ts", default: true },
  { name: "scheduler-concurrency", file: "scheduler-concurrency-live.ts", default: true },
  { name: "multitab-har", file: "../benchmarks/multitab-har-live.ts", default: true },
  { name: "miniwob-official", file: "../benchmarks/miniwob-ab-live.ts", timeoutMs: 90_000, default: false },
  { name: "skill-client", file: "skill-client-live.mjs", default: true },
  {
    name: "dialog",
    file: "dialog-lifecycle-live.ts",
    timeoutMs: 15_000,
    default: false,
    headless: false,
  },
  {
    name: "version-handover",
    file: "version-handover-live.mjs",
    timeoutMs: 120_000,
    default: false,
    requires: ["AB_OLD_RUNTIME_BINARY", "AB_OLD_BUILD_ID"],
  },
];

const requested = requestedCases(process.argv.slice(2));
const selected = requested.length === 0
  ? cases.filter((entry) => entry.default)
  : requested.map((name) => {
    const entry = cases.find((candidate) => candidate.name === name);
    assert(entry, `unknown live case ${name}`);
    return entry;
  });

const results: Array<{ name: string; status: "passed" | "failed" | "timed_out"; ms: number }> = [];
for (const entry of selected) {
  for (const variable of entry.requires ?? []) {
    assert(process.env[variable], `${entry.name} requires ${variable}`);
  }
  const temporaryRoot = process.platform === "darwin" ? "/tmp" : tmpdir();
  const caseRoot = await mkdtemp(join(temporaryRoot, "ab-live."));
  const runtimeDirectory = join(caseRoot, "r");
  const dataDirectory = join(caseRoot, "d");
  await Promise.all([mkdir(runtimeDirectory), mkdir(dataDirectory)]);
  const started = performance.now();
  process.stdout.write(`\nAB_LIVE_CASE_START ${entry.name} ${basename(entry.file)}\n`);
  const child = Bun.spawn(["bun", join(import.meta.dirname, entry.file)], {
    cwd: root,
    env: {
      ...process.env,
      AB_RUNTIME_BINARY: runtimeBinary,
      AB_RUNTIME_DIR: runtimeDirectory,
      AB_DATA_DIR: dataDirectory,
      AB_HEADLESS: entry.headless === false ? "0" : "1",
      AB_SKILL_CLIENT: skillClient,
      AB_HANDOVER_IDLE_ROOT: join(caseRoot, "handover-idle"),
      AB_HANDOVER_ACTIVE_ROOT: join(caseRoot, "handover-active"),
      AB_HANDOVER_SIDE_EFFECT_ROOT: join(caseRoot, "handover-side-effect"),
    },
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, entry.timeoutMs ?? 60_000);
  const exitCode = await child.exited;
  clearTimeout(timer);
  await cleanupCaseProcesses(runtimeDirectory, dataDirectory);
  const ms = Math.round(performance.now() - started);
  const status = timedOut ? "timed_out" : exitCode === 0 ? "passed" : "failed";
  results.push({ name: entry.name, status, ms });
  process.stdout.write(`AB_LIVE_CASE_RESULT ${JSON.stringify({ name: entry.name, status, exitCode, ms, caseRoot })}\n`);
  if (status !== "passed") break;
}

async function cleanupCaseProcesses(runtimeDirectory: string, dataDirectory: string): Promise<void> {
  const socketPath = join(runtimeDirectory, "browser.sock");
  const lsof = Bun.spawn(["lsof", "-t", socketPath], { stdout: "pipe", stderr: "ignore" });
  const socketOwners = await new Response(lsof.stdout).text();
  await lsof.exited;
  for (const value of socketOwners.trim().split(/\s+/).filter(Boolean)) {
    stopProcess(Number(value));
  }

  const profileArgument = `--user-data-dir=${join(dataDirectory, "chrome-profile")}`;
  const ps = Bun.spawn(["ps", "-axo", "pid=,command="], { stdout: "pipe", stderr: "ignore" });
  const processes = await new Response(ps.stdout).text();
  await ps.exited;
  for (const line of processes.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!match) continue;
    const [, pid, command] = match;
    if (
      command.startsWith("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome ")
      && command.includes(profileArgument)
    ) {
      stopProcess(Number(pid));
    }
  }
}

function stopProcess(pid: number): void {
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

process.stdout.write(`AB_LIVE_SUITE_RESULT ${JSON.stringify(results, null, 2)}\n`);
if (results.some((result) => result.status !== "passed")) process.exitCode = 1;

function requestedCases(args: string[]): string[] {
  const names: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--case") {
      const name = args[index + 1];
      assert(name, "--case requires a case name");
      names.push(name);
      index += 1;
    }
  }
  return names;
}
