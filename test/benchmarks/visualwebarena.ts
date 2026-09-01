import { homedir } from "node:os";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  benchmarkSources,
  endpointCheck,
  sourceCheck,
} from "./sources.ts";
import type { BenchmarkDoctorReport, BenchmarkTask, CommandResult } from "./types.ts";
import {
  dockerSystemCheck,
  ensureDockerNetwork,
  ensureDockerSystem,
  pullDockerImage,
  replaceDockerContainer,
  runCommand,
} from "./docker.ts";
import {
  materializeWebArenaUrl,
  startWebArenaSite,
  webArenaSiteUrl,
} from "./webarena-verified.ts";

export type VisualWebArenaSite = "classifieds" | "reddit" | "shopping" | "wikipedia";

type OfficialVisualTask = {
  task_id: number;
  intent: string;
  sites: string[];
  start_url: string;
  image?: string | string[] | null;
  eval: unknown;
  reasoning_difficulty?: string;
  visual_difficulty?: string;
  overall_difficulty?: string;
};

const CONFIGS = [
  ["classifieds", "test_classifieds.raw.json"],
  ["reddit", "test_reddit.raw.json"],
  ["shopping", "test_shopping.raw.json"],
] as const;

export type VisualWebArenaSiteStart = {
  site: VisualWebArenaSite;
  provisioner: "external" | "docker";
  url: string;
  containers: readonly string[];
  environment?: CommandResult;
};

export type VisualWebArenaOfficialEvaluation = {
  evaluator: "official-visualwebarena";
  evalTypes: readonly string[];
  score: number;
  targetId: string;
  finalUrl: string;
};

const CLASSIFIEDS = {
  network: "ab-vwa-classifieds",
  databaseName: "ab-vwa-classifieds-db",
  webName: "ab-vwa-classifieds-web",
  databaseImage: "ghcr.io/bgrins/vwa_classifieds_db:latest",
  webImage: "ghcr.io/bgrins/vwa_classifieds_web:latest",
  platform: "linux/arm64",
  url: "http://127.0.0.1:9980",
} as const;

export async function visualWebArenaDoctor(): Promise<BenchmarkDoctorReport> {
  const source = benchmarkSources().visualWebArena;
  const environmentChecks = await Promise.all([
    visualWebArenaEndpointCheck("classifieds", "/"),
    visualWebArenaEndpointCheck("reddit", "/login"),
    visualWebArenaEndpointCheck("shopping", "/customer/account/login"),
    visualWebArenaEndpointCheck("wikipedia", "/"),
    visualWebArenaConfiguredEndpointCheck(
      "VisualWebArena homepage environment",
      "AB_VISUALWEBARENA_HOMEPAGE_URL",
      "/",
    ),
  ]);
  const checks = [
    await sourceCheck("VisualWebArena source", source, "README.md"),
    dockerSystemCheck(),
    ...await Promise.all(CONFIGS.map(([, file]) => sourceCheck(
      `VisualWebArena ${file}`,
      source,
      join("config_files/vwa", file),
    ))),
    await visualWebArenaEvaluatorCheck(source),
    ...environmentChecks,
  ];
  return { ready: checks.every((check) => check.status === "ready"), checks };
}

export async function assertVisualWebArenaEvaluationReady(task: BenchmarkTask): Promise<void> {
  // Resolve the exact evaluator environment before an Agent is given a live
  // task. A missing variable must not be discovered only after the task state
  // has been produced.
  visualWebArenaEvaluatorEnvironment(task);
  const source = benchmarkSources().visualWebArena;
  const taskSites = [...new Set(task.sites)].filter(isVisualWebArenaSite);
  const checks = await Promise.all([
    visualWebArenaEvaluatorCheck(source),
    visualWebArenaConfiguredEndpointCheck(
      "VisualWebArena homepage environment",
      "AB_VISUALWEBARENA_HOMEPAGE_URL",
      "/",
    ),
    ...taskSites.map((site) => visualWebArenaEndpointCheck(site, visualWebArenaReadinessPath(site))),
  ]);
  const blocked = checks.filter((check) => check.status !== "ready");
  if (blocked.length > 0) {
    throw new Error(`VisualWebArena evaluation is not ready: ${blocked.map(
      (check) => `${check.name}: ${check.detail}`,
    ).join("; ")}`);
  }
}

export async function listVisualWebArenaTasks(): Promise<BenchmarkTask[]> {
  const source = benchmarkSources().visualWebArena;
  const groups = await Promise.all(CONFIGS.map(async ([site, file]) => {
    const path = join(source, "config_files/vwa", file);
    const tasks = JSON.parse(await readFile(path, "utf8")) as OfficialVisualTask[];
    return tasks.map((task) => ({
      suite: "visualwebarena" as const,
      id: `${site}:${task.task_id}`,
      intent: task.intent,
      sites: task.sites,
      startUrls: task.start_url.split(" |AND| "),
      sourceFile: path,
      inputImages: normalizeImages(task.image).map((image) => join(source, image)),
      difficulty: {
        ...(task.reasoning_difficulty ? { reasoning: task.reasoning_difficulty } : {}),
        ...(task.visual_difficulty ? { visual: task.visual_difficulty } : {}),
        ...(task.overall_difficulty ? { overall: task.overall_difficulty } : {}),
      },
      evaluation: task.eval,
    }));
  }));
  return groups.flat();
}

export async function visualWebArenaTask(taskId: string): Promise<BenchmarkTask> {
  const task = (await listVisualWebArenaTasks()).find((candidate) => candidate.id === taskId);
  if (!task) {
    throw new Error(`unknown VisualWebArena task: ${taskId}`);
  }
  return task;
}

export async function startVisualWebArenaSite(
  site: VisualWebArenaSite,
): Promise<VisualWebArenaSiteStart> {
  if (site === "reddit" || site === "shopping" || site === "wikipedia") {
    const started = await startWebArenaSite(site);
    return {
      site,
      provisioner: started.provisioner,
      url: started.url,
      containers: started.containerName ? [started.containerName] : [],
      environment: started.environment,
    };
  }

  const externalUrl = configuredVisualWebArenaUrl("classifieds");
  if (externalUrl) {
    await resetClassifieds(externalUrl);
    await waitForEndpoint(`${externalUrl}/`, 30_000);
    return {
      site,
      provisioner: "external",
      url: externalUrl,
      containers: [],
    };
  }

  const system = await ensureDockerSystem();
  if (system.exitCode !== 0) {
    throw new Error(`Colima Docker runtime failed to start: ${system.stderr || system.stdout}`);
  }
  await pullDockerImage(CLASSIFIEDS.databaseImage, CLASSIFIEDS.platform);
  await pullDockerImage(CLASSIFIEDS.webImage, CLASSIFIEDS.platform);
  await replaceDockerContainer(CLASSIFIEDS.webName);
  await replaceDockerContainer(CLASSIFIEDS.databaseName);
  await ensureDockerNetwork(CLASSIFIEDS.network);

  const database = await runCommand([
    "docker",
    "run",
    "--detach",
    "--name",
    CLASSIFIEDS.databaseName,
    "--network",
    CLASSIFIEDS.network,
    "--platform",
    CLASSIFIEDS.platform,
    "--memory",
    process.env.AB_VWA_CLASSIFIEDS_DB_MEMORY ?? "4g",
    "--cpus",
    process.env.AB_VWA_CLASSIFIEDS_DB_CPUS ?? "2",
    CLASSIFIEDS.databaseImage,
  ]);
  if (database.exitCode !== 0) {
    throw new Error(`failed to start Classifieds database: ${database.stderr || database.stdout}`);
  }
  await waitForClassifiedsDatabase();

  const web = await runCommand([
    "docker",
    "run",
    "--detach",
    "--name",
    CLASSIFIEDS.webName,
    "--network",
    CLASSIFIEDS.network,
    "--platform",
    CLASSIFIEDS.platform,
    "--memory",
    process.env.AB_VWA_CLASSIFIEDS_WEB_MEMORY ?? "6g",
    "--cpus",
    process.env.AB_VWA_CLASSIFIEDS_WEB_CPUS ?? "4",
    "--publish",
    "127.0.0.1:9980:9980",
    "--env",
    `CLASSIFIEDS=${CLASSIFIEDS.url}/`,
    "--env",
    "RESET_TOKEN=4b61655535e7ed388f0d40a93600254c",
    "--env",
    `DB_HOST=${CLASSIFIEDS.databaseName}`,
    "--env",
    "DB_USER=root",
    "--env",
    "DB_PASSWORD=password",
    "--env",
    "DB_NAME=osclass",
    "--env",
    "DB_TABLE_PREFIX=oc_",
    CLASSIFIEDS.webImage,
  ]);
  if (web.exitCode !== 0) {
    throw new Error(`failed to start Classifieds web: ${web.stderr || web.stdout}`);
  }
  await waitForEndpoint(`${CLASSIFIEDS.url}/`, 180_000);
  await resetClassifieds(CLASSIFIEDS.url);
  return {
    site,
    provisioner: "docker",
    url: CLASSIFIEDS.url,
    containers: [CLASSIFIEDS.databaseName, CLASSIFIEDS.webName],
  };
}

export function visualWebArenaSiteUrl(site: VisualWebArenaSite): string {
  if (site !== "wikipedia") {
    const configured = configuredVisualWebArenaUrl(site);
    if (configured) return configured;
  }
  switch (site) {
    case "classifieds": return CLASSIFIEDS.url;
    case "reddit": return webArenaSiteUrl("reddit");
    case "shopping": return webArenaSiteUrl("shopping");
    case "wikipedia": return webArenaSiteUrl("wikipedia");
  }
}

export function materializeVisualWebArenaUrl(value: string): string {
  const visualUrl = (["classifieds", "reddit", "shopping"] as const).reduce((url, site) => {
    const token = `__${site.toUpperCase()}__`;
    return url.includes(token) ? url.replaceAll(token, visualWebArenaSiteUrl(site)) : url;
  }, value);
  return materializeWebArenaUrl(visualUrl);
}

export async function evaluateVisualWebArenaOfficial(
  task: BenchmarkTask,
  targetId: string,
  answer: string,
  outputDirectory: string,
): Promise<VisualWebArenaOfficialEvaluation> {
  const source = benchmarkSources().visualWebArena;
  const configPath = join(outputDirectory, "official-task.json");
  const rawConfig = JSON.parse(await readFile(task.sourceFile, "utf8")) as OfficialVisualTask[];
  const officialTaskId = Number(task.id.split(":").at(-1));
  const config = rawConfig.find((candidate) => candidate.task_id === officialTaskId);
  if (!config) {
    throw new Error(`VisualWebArena source task ${task.id} is missing from ${task.sourceFile}`);
  }
  await writeFile(configPath, `${JSON.stringify(materializeVisualWebArenaValue(config), null, 2)}\n`);

  const bridge = join(import.meta.dirname, "visualwebarena_bridge.py");
  const child = Bun.spawn([
    visualWebArenaPython(source),
    bridge,
    "evaluate",
    "--source",
    source,
    "--config",
    configPath,
    "--cdp-endpoint",
    await abChromeCdpEndpoint(),
    "--target-id",
    targetId,
    "--answer",
    answer,
  ], {
    stdout: "pipe",
    stderr: "pipe",
    env: visualWebArenaEvaluatorEnvironment(task),
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`official VisualWebArena evaluator failed (${exitCode}): ${stderr || stdout}`);
  }
  const marker = "AB_VISUALWEBARENA_EVALUATION ";
  const line = stdout.split(/\r?\n/).reverse()
    .find((candidate: string) => candidate.startsWith(marker));
  if (!line) {
    throw new Error(`official VisualWebArena evaluator returned no result: ${stdout}`);
  }
  return JSON.parse(line.slice(marker.length)) as VisualWebArenaOfficialEvaluation;
}

async function waitForClassifiedsDatabase(): Promise<void> {
  const deadline = Date.now() + 120_000;
  let last: CommandResult | undefined;
  while (Date.now() < deadline) {
    last = await runCommand([
      "docker",
      "exec",
      CLASSIFIEDS.databaseName,
      "mysqladmin",
      "ping",
      "-h",
      "localhost",
    ]);
    if (last.exitCode === 0) return;
    await Bun.sleep(1_000);
  }
  throw new Error(`Classifieds database did not become ready: ${last?.stderr || last?.stdout || "no response"}`);
}

async function waitForEndpoint(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let detail = "no response";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
      detail = `HTTP ${response.status}`;
      if (response.status < 500) return;
    } catch (error) {
      detail = error instanceof Error ? error.message : String(error);
    }
    await Bun.sleep(1_000);
  }
  throw new Error(`VisualWebArena endpoint ${url} did not become ready: ${detail}`);
}

function normalizeImages(value: OfficialVisualTask["image"]): string[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

async function resetClassifieds(url: string): Promise<void> {
  const token = process.env.AB_VISUALWEBARENA_CLASSIFIEDS_RESET_TOKEN
    ?? "4b61655535e7ed388f0d40a93600254c";
  const response = await fetch(`${url}/index.php?page=reset`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }),
  });
  if (!response.ok) {
    throw new Error(`VisualWebArena Classifieds reset returned HTTP ${response.status}`);
  }
}

function configuredVisualWebArenaUrl(
  site: "classifieds" | "reddit" | "shopping",
): string | undefined {
  return process.env[`AB_VISUALWEBARENA_${site.toUpperCase()}_URL`]
    ?.replace(/\/+$/, "") || undefined;
}

function isVisualWebArenaSite(value: string): value is VisualWebArenaSite {
  return value === "classifieds"
    || value === "reddit"
    || value === "shopping"
    || value === "wikipedia";
}

function visualWebArenaReadinessPath(site: VisualWebArenaSite): string {
  if (site === "reddit") return "/login";
  if (site === "shopping") return "/customer/account/login";
  return "/";
}

async function visualWebArenaEndpointCheck(
  site: VisualWebArenaSite,
  path: string,
): Promise<BenchmarkDoctorReport["checks"][number]> {
  const name = `VisualWebArena ${site} environment`;
  try {
    return await endpointCheck(name, `${visualWebArenaSiteUrl(site)}${path}`);
  } catch (error) {
    return {
      name,
      status: "blocked",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

async function visualWebArenaEvaluatorCheck(
  source: string,
): Promise<BenchmarkDoctorReport["checks"][number]> {
  const name = "VisualWebArena official evaluator";
  try {
    const child = Bun.spawn([
      visualWebArenaPython(source),
      join(import.meta.dirname, "visualwebarena_bridge.py"),
      "doctor",
      "--source",
      source,
    ], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        DATASET: "visualwebarena",
        CLASSIFIEDS: "https://classifieds.invalid",
        REDDIT: "https://reddit.invalid",
        SHOPPING: "https://shopping.invalid",
        WIKIPEDIA: "https://wikipedia.invalid",
        HOMEPAGE: "https://homepage.invalid",
        CLASSIFIEDS_RESET_TOKEN: "doctor",
      },
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return {
      name,
      status: exitCode === 0 ? "ready" : "blocked",
      detail: exitCode === 0 ? stdout.trim() : stderr.trim() || stdout.trim(),
    };
  } catch (error) {
    return {
      name,
      status: "blocked",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function visualWebArenaPython(source: string): string {
  return process.env.AB_VISUALWEBARENA_PYTHON ?? join(source, ".venv/bin/python");
}

function visualWebArenaEvaluatorEnvironment(task: BenchmarkTask): Record<string, string | undefined> {
  const homepage = process.env.AB_VISUALWEBARENA_HOMEPAGE_URL;
  if (!homepage) {
    throw new Error("VisualWebArena evaluator requires AB_VISUALWEBARENA_HOMEPAGE_URL");
  }
  const taskSites = new Set(task.sites);
  const siteUrl = (site: VisualWebArenaSite): string => taskSites.has(site)
    ? visualWebArenaSiteUrl(site)
    : `https://${site}.invalid`;
  return {
    ...process.env,
    DATASET: "visualwebarena",
    CLASSIFIEDS: siteUrl("classifieds"),
    REDDIT: siteUrl("reddit"),
    SHOPPING: siteUrl("shopping"),
    WIKIPEDIA: siteUrl("wikipedia"),
    HOMEPAGE: homepage.replace(/\/+$/, ""),
    CLASSIFIEDS_RESET_TOKEN: process.env.AB_VISUALWEBARENA_CLASSIFIEDS_RESET_TOKEN
      ?? "4b61655535e7ed388f0d40a93600254c",
  };
}

async function visualWebArenaConfiguredEndpointCheck(
  name: string,
  environmentName: string,
  path: string,
): Promise<BenchmarkDoctorReport["checks"][number]> {
  const configured = process.env[environmentName]?.replace(/\/+$/, "");
  if (!configured) {
    return { name, status: "blocked", detail: `${environmentName} is not configured` };
  }
  return endpointCheck(name, `${configured}${path}`);
}

async function abChromeCdpEndpoint(): Promise<string> {
  const profile = process.env.AB_PROFILE_DIR
    ?? join(homedir(), "Library", "Application Support", "ab", "chrome-profile");
  const activePort = await readFile(join(profile, "DevToolsActivePort"), "utf8");
  const port = activePort.split(/\r?\n/, 1)[0];
  if (!port || !/^\d+$/.test(port)) {
    throw new Error(`invalid AB Chrome DevToolsActivePort in ${profile}`);
  }
  return `http://127.0.0.1:${port}`;
}

function materializeVisualWebArenaValue(value: unknown): unknown {
  if (typeof value === "string") return materializeVisualWebArenaUrl(value);
  if (Array.isArray(value)) return value.map(materializeVisualWebArenaValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [
      key,
      materializeVisualWebArenaValue(child),
    ]));
  }
  return value;
}
