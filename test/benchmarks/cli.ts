import { miniWobDoctor, listMiniWobTasks, miniWobTask, startMiniWobServer } from "./miniwob.ts";
import {
  createWebArenaRun,
  evaluateWebArenaRun,
  listWebArenaVerifiedHardTasks,
  startWebArenaSite,
  webArenaVerifiedDoctor,
  webArenaVerifiedTask,
} from "./webarena-verified.ts";
import {
  visualWebArenaDoctor,
  listVisualWebArenaTasks,
  startVisualWebArenaSite,
  visualWebArenaTask,
} from "./visualwebarena.ts";
import type { BenchmarkDoctorReport, BenchmarkSuite, BenchmarkTask } from "./types.ts";
import {
  assistantBenchDoctor,
  assistantBenchTask,
  evaluateAssistantBench,
  listAssistantBenchTasks,
} from "./assistantbench.ts";
import {
  miniWobCampaignDefinition,
  readMiniWobCampaignReport,
} from "./miniwob-campaign.ts";

const [command = "doctor", suite, id] = process.argv.slice(2);

switch (command) {
  case "doctor": {
    const suites: BenchmarkSuite[] = suite
      ? [requiredSuite(suite)]
      : ["miniwob++", "webarena-verified-hard", "visualwebarena"];
    const reports = Object.fromEntries(await Promise.all(
      suites.map(async (selected) => [selected, await doctor(selected)] as const),
    ));
    print(reports);
    process.exitCode = Object.values(reports).every((report) => report.ready) ? 0 : 2;
    break;
  }
  case "list": {
    const tasks = await listTasks(requiredSuite(suite));
    print({ suite, count: tasks.length, tasks });
    break;
  }
  case "task": {
    print(await getTask(requiredSuite(suite), required(id, "task id")));
    break;
  }
  case "serve": {
    if (requiredSuite(suite) !== "miniwob++") {
      throw new Error("only MiniWoB++ is a static benchmark; WebArena suites use their official environments");
    }
    const server = startMiniWobServer(Number(process.env.PORT ?? 0));
    print({ suite, origin: server.origin, pid: process.pid });
    await new Promise<void>((resolve) => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
    server.stop();
    break;
  }
  case "start": {
    const selected = requiredSuite(suite);
    if (selected === "webarena-verified-hard") {
      print(await startWebArenaSite(required(id, "site")));
    } else if (selected === "visualwebarena") {
      const site = required(id, "site");
      if (site !== "classifieds" && site !== "reddit" && site !== "shopping" && site !== "wikipedia") {
        throw new Error(`VisualWebArena site must be classifieds, reddit, shopping, or wikipedia; got ${site}`);
      }
      print(await startVisualWebArenaSite(site));
    } else {
      throw new Error("MiniWoB++ is served with the serve command");
    }
    break;
  }
  case "prepare": {
    if (requiredSuite(suite) !== "webarena-verified-hard") {
      throw new Error("prepare currently belongs to WebArena-Verified runs");
    }
    const outputRoot = required(process.argv[5], "output root");
    print(await createWebArenaRun(outputRoot, Number(required(id, "task id"))));
    break;
  }
  case "evaluate": {
    const selected = requiredSuite(suite);
    if (selected === "webarena-verified-hard") {
      const outputRoot = required(process.argv[5], "output root");
      const result = await evaluateWebArenaRun(outputRoot, Number(required(id, "task id")));
      print(result);
      process.exitCode = result.exitCode;
    } else if (selected === "assistantbench-validation") {
      const prediction = required(process.argv[5], "prediction");
      const result = await evaluateAssistantBench(required(id, "task id"), prediction);
      print(result);
      process.exitCode = result.score > 0 ? 0 : 1;
    } else {
      throw new Error("evaluate requires WebArena-Verified Hard or AssistantBench validation");
    }
    break;
  }
  case "campaign": {
    if (requiredSuite(suite) !== "miniwob++") {
      throw new Error("the forward Agent campaign currently belongs to MiniWoB++");
    }
    print(await miniWobCampaignDefinition());
    break;
  }
  case "campaign-report": {
    if (requiredSuite(suite) !== "miniwob++") {
      throw new Error("the forward Agent campaign report currently belongs to MiniWoB++");
    }
    print(await readMiniWobCampaignReport(required(id, "output root")));
    break;
  }
  default:
    throw new Error(`unknown benchmark command: ${command}`);
}

async function listTasks(suite: BenchmarkSuite): Promise<BenchmarkTask[]> {
  switch (suite) {
    case "miniwob++": return listMiniWobTasks();
    case "webarena-verified-hard": return listWebArenaVerifiedHardTasks();
    case "visualwebarena": return listVisualWebArenaTasks();
    case "assistantbench-validation": return listAssistantBenchTasks();
  }
}

async function doctor(suite: BenchmarkSuite): Promise<BenchmarkDoctorReport> {
  switch (suite) {
    case "miniwob++": return miniWobDoctor();
    case "webarena-verified-hard": return webArenaVerifiedDoctor();
    case "visualwebarena": return visualWebArenaDoctor();
    case "assistantbench-validation": return assistantBenchDoctor();
  }
}

async function getTask(suite: BenchmarkSuite, taskId: string): Promise<BenchmarkTask> {
  switch (suite) {
    case "miniwob++": return miniWobTask(taskId);
    case "webarena-verified-hard": return webArenaVerifiedTask(Number(taskId));
    case "visualwebarena": return visualWebArenaTask(taskId);
    case "assistantbench-validation": return assistantBenchTask(taskId);
  }
}

function requiredSuite(value: string | undefined): BenchmarkSuite {
  if (value === "miniwob++" || value === "webarena-verified-hard" || value === "visualwebarena" || value === "assistantbench-validation") {
    return value;
  }
  throw new Error(`suite must be miniwob++, webarena-verified-hard, visualwebarena, or assistantbench-validation; got ${value ?? "nothing"}`);
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function print(value: BenchmarkTask | BenchmarkTask[] | BenchmarkDoctorReport | object): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
