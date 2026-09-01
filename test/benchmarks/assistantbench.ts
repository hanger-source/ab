import { access } from "node:fs/promises";
import { join } from "node:path";
import { benchmarkSources, sourceCheck } from "./sources.ts";
import type { BenchmarkDoctorCheck, BenchmarkDoctorReport, BenchmarkTask } from "./types.ts";

type OfficialAssistantBenchTask = {
  id: string;
  benchmarkId: string;
  intent: string;
  startUrl: string;
};

export type AssistantBenchEvaluation = OfficialAssistantBenchTask & {
  score: number;
  hasAnswer: boolean;
  evaluator: string;
};

const bridge = join(import.meta.dirname, "assistantbench_bridge.py");

export async function assistantBenchDoctor(): Promise<BenchmarkDoctorReport> {
  const source = benchmarkSources().browserGym;
  const checks: BenchmarkDoctorCheck[] = [
    await sourceCheck(
      "BrowserGym AssistantBench source",
      source,
      "browsergym/assistantbench/src/browsergym/assistantbench/evaluation/evaluator.py",
    ),
    await pythonCheck(),
  ];
  const runtime = checks.every((check) => check.status === "ready")
    ? await runBridge(["doctor"]).then(
      (value) => ({
        name: "Official AssistantBench validation dataset and evaluator",
        status: "ready" as const,
        detail: JSON.stringify(value),
      }),
      (error) => ({
        name: "Official AssistantBench validation dataset and evaluator",
        status: "blocked" as const,
        detail: error instanceof Error ? error.message : String(error),
      }),
    )
    : null;
  if (runtime) checks.push(runtime);
  return { ready: checks.every((check) => check.status === "ready"), checks };
}

export async function listAssistantBenchTasks(): Promise<BenchmarkTask[]> {
  const tasks = await runBridge<OfficialAssistantBenchTask[]>(["list"]);
  return tasks.map(toBenchmarkTask);
}

export async function assistantBenchTask(taskId: string): Promise<BenchmarkTask> {
  return toBenchmarkTask(await runBridge<OfficialAssistantBenchTask>(["task", taskId]));
}

export function evaluateAssistantBench(
  taskId: string,
  prediction: string,
): Promise<AssistantBenchEvaluation> {
  return runBridge<AssistantBenchEvaluation>(["evaluate", taskId, prediction]);
}

function toBenchmarkTask(task: OfficialAssistantBenchTask): BenchmarkTask {
  return {
    suite: "assistantbench-validation",
    id: task.id,
    intent: task.intent,
    sites: ["open-web"],
    startUrls: [task.startUrl],
    sourceFile: join(
      benchmarkSources().browserGym,
      "browsergym/assistantbench/src/browsergym/assistantbench/task.py",
    ),
    inputImages: [],
    difficulty: { overall: "official-validation" },
    evaluation: {
      benchmarkId: task.benchmarkId,
      evaluator: "browsergym.assistantbench.evaluation.evaluator.question_scorer",
    },
  };
}

async function pythonCheck(): Promise<BenchmarkDoctorCheck> {
  const python = benchmarkPython();
  try {
    await access(python);
    return { name: "AssistantBench Python", status: "ready", detail: python };
  } catch {
    return { name: "AssistantBench Python", status: "blocked", detail: `missing ${python}` };
  }
}

function benchmarkPython(): string {
  return process.env.AB_BENCHMARK_PYTHON ?? join(process.cwd(), ".venv/bin/python");
}

async function runBridge<T>(args: string[]): Promise<T> {
  const command = [benchmarkPython(), bridge, ...args];
  const process = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`AssistantBench bridge failed (${exitCode}): ${stderr || stdout}`);
  }
  return JSON.parse(stdout) as T;
}
