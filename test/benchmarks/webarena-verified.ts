import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  benchmarkSources,
  endpointCheck,
  executableCheck,
  sourceCheck,
} from "./sources.ts";
import type {
  BenchmarkDoctorCheck,
  BenchmarkDoctorReport,
  BenchmarkTask,
  CommandResult,
} from "./types.ts";
import {
  dockerContainerHttpCheck,
  dockerSystemCheck,
  ensureDockerSystem,
  ensureRosettaSupervisorService,
  pullDockerImage,
} from "./docker.ts";

type OfficialTask = {
  task_id: number;
  intent: string;
  sites: string[];
  start_urls: string[];
  eval: unknown;
  revision: number;
};

type HardSubset = {
  checksum: string;
  description: string;
  task_ids: number[];
};

export type WebArenaAgentResponse = {
  task_type: "RETRIEVE" | "MUTATE" | "NAVIGATE";
  status:
    | "SUCCESS"
    | "ACTION_NOT_ALLOWED_ERROR"
    | "PERMISSION_DENIED_ERROR"
    | "NOT_FOUND_ERROR"
    | "DATA_VALIDATION_ERROR"
    | "UNKNOWN_ERROR";
  retrieved_data: Array<string | number | boolean | Record<string, unknown> | null> | null;
  error_details: string | null;
};

export type WebArenaRun = {
  directory: string;
  agentResponsePath: string;
  networkHarPath: string;
  evalResultPath: string;
  evalConfigPath: string;
};

type DockerSiteConfig = {
  image: string;
  hostPort: number;
  hostEnvControlPort: number;
  platform: "linux/amd64" | "linux/arm64";
  healthPath: string;
};

export type WebArenaSiteStart = {
  site: string;
  provisioner: "external" | "docker";
  containerName: string | null;
  url: string;
  envControlUrl: string;
  container: CommandResult | null;
  environment: CommandResult;
};

const DOCKER_SITES: Record<string, DockerSiteConfig> = {
  shopping: {
    image: "docker.io/am1n3e/webarena-verified-shopping:latest",
    hostPort: 7770,
    hostEnvControlPort: 7771,
    platform: "linux/amd64",
    healthPath: "/customer/account/login",
  },
  shopping_admin: {
    image: "docker.io/am1n3e/webarena-verified-shopping_admin:latest",
    hostPort: 7780,
    hostEnvControlPort: 7781,
    platform: "linux/amd64",
    healthPath: "/",
  },
  reddit: {
    image: "docker.io/am1n3e/webarena-verified-reddit:latest",
    hostPort: 9999,
    hostEnvControlPort: 9998,
    platform: "linux/amd64",
    healthPath: "/login",
  },
  gitlab: {
    image: "docker.io/am1n3e/webarena-verified-gitlab:latest",
    hostPort: 8023,
    hostEnvControlPort: 8024,
    platform: "linux/amd64",
    healthPath: "/users/sign_in",
  },
};

const OFFICIAL_SITES = [
  "shopping",
  "shopping_admin",
  "reddit",
  "gitlab",
  "wikipedia",
  "map",
] as const;

const SITE_HEALTH_PATH: Record<string, string> = {
  shopping: "/customer/account/login",
  shopping_admin: "/",
  reddit: "/login",
  gitlab: "/users/sign_in",
  wikipedia: "/",
  map: "/",
};

function datasetPaths() {
  const source = benchmarkSources().webarenaVerified;
  return {
    source,
    dataset: join(source, "assets/dataset/webarena-verified.json"),
    hard: join(source, "assets/dataset/subsets/webarena-verified-hard.json"),
  };
}

export async function webArenaVerifiedDoctor(): Promise<BenchmarkDoctorReport> {
  const paths = datasetPaths();
  const environmentChecks = await Promise.all(OFFICIAL_SITES.map(async (site) => {
    try {
      return await endpointCheck(
        `WebArena-Verified ${site} environment`,
        `${webArenaSiteUrl(site)}${SITE_HEALTH_PATH[site]}`,
        { timeoutMs: 15_000 },
      );
    } catch (error) {
      return {
        name: `WebArena-Verified ${site} environment`,
        status: "blocked" as const,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }));
  const checks = [
    await sourceCheck("WebArena-Verified source", paths.source, "pyproject.toml"),
    await sourceCheck(
      "WebArena-Verified dataset",
      paths.source,
      "assets/dataset/webarena-verified.json",
    ),
    await sourceCheck(
      "WebArena-Verified hard subset",
      paths.source,
      "assets/dataset/subsets/webarena-verified-hard.json",
    ),
    executableCheck("WebArena-Verified runner", "uvx"),
    dockerSystemCheck(),
    shoppingAdminSearchCheck(),
    ...environmentChecks,
  ];
  return { ready: checks.every((check) => check.status === "ready"), checks };
}

export async function listWebArenaVerifiedHardTasks(): Promise<BenchmarkTask[]> {
  const paths = datasetPaths();
  const [tasks, subset] = await Promise.all([
    readJson<OfficialTask[]>(paths.dataset),
    readJson<HardSubset>(paths.hard),
  ]);
  const hardIds = new Set(subset.task_ids);
  return tasks
    .filter((task) => hardIds.has(task.task_id))
    .map((task) => ({
      suite: "webarena-verified-hard",
      id: String(task.task_id),
      intent: task.intent,
      sites: task.sites,
      startUrls: task.start_urls,
      sourceFile: paths.dataset,
      inputImages: [],
      difficulty: { overall: "hard-subset" },
      evaluation: task.eval,
    }));
}

export async function webArenaVerifiedTask(taskId: number): Promise<BenchmarkTask> {
  const task = (await listWebArenaVerifiedHardTasks())
    .find((candidate) => candidate.id === String(taskId));
  if (!task) {
    throw new Error(`task ${taskId} is not in WebArena-Verified Hard`);
  }
  return task;
}

export async function createWebArenaRun(outputRoot: string, taskId: number): Promise<WebArenaRun> {
  const task = await webArenaVerifiedTask(taskId);
  const directory = join(outputRoot, String(taskId));
  await mkdir(directory, { recursive: true });
  const evalConfigPath = join(directory, "eval-config.json");
  await writeFile(evalConfigPath, `${JSON.stringify(evaluationConfig(task.sites), null, 2)}\n`);
  return {
    directory,
    agentResponsePath: join(directory, "agent_response.json"),
    networkHarPath: join(directory, "network.har"),
    evalResultPath: join(directory, "eval_result.json"),
    evalConfigPath,
  };
}

export async function writeWebArenaAgentResponse(
  run: WebArenaRun,
  response: WebArenaAgentResponse,
): Promise<void> {
  await writeFile(run.agentResponsePath, `${JSON.stringify(response, null, 2)}\n`);
}

export async function startWebArenaSite(
  site: string,
  options: { port?: number; envControlPort?: number; timeoutSeconds?: number } = {},
): Promise<WebArenaSiteStart> {
  const externalUrl = configuredWebArenaUrl(site);
  const externalEnvControlUrl = configuredWebArenaEnvControlUrl(site);
  if (externalUrl || externalEnvControlUrl) {
    if (!externalUrl || !externalEnvControlUrl) {
      throw new Error(
        `${site} requires both ${siteEnvironmentName(site, "URL")} and ${siteEnvironmentName(site, "ENV_CONTROL_URL")}`,
      );
    }
    const environment = await runOfficialWebArenaCommand([
      "env",
      "start",
      "--url",
      externalEnvControlUrl,
      "--timeout",
      String(options.timeoutSeconds ?? 300),
    ], { visible: true });
    if (environment.exitCode !== 0) {
      throw new Error(`official env-control failed for ${site}: ${environment.stderr || environment.stdout}`);
    }
    await waitForWebArenaEndpoint(
      `${externalUrl}${SITE_HEALTH_PATH[site] ?? "/"}`,
      60_000,
    );
    return {
      site,
      provisioner: "external",
      containerName: null,
      url: externalUrl,
      envControlUrl: externalEnvControlUrl,
      container: null,
      environment,
    };
  }
  const config = DOCKER_SITES[site];
  if (!config) {
    throw new Error(
      `local Docker start supports shopping, shopping_admin, reddit, and gitlab; ${site} requires the official data-volume setup adapter`,
    );
  }
  const system = await ensureDockerSystem();
  if (system.exitCode !== 0) {
    throw new Error(`Colima Docker runtime failed to start: ${system.stderr || system.stdout}`);
  }
  const containerName = `webarena_verified_${site}`;
  const hostPort = options.port ?? config.hostPort;
  const hostEnvControlPort = options.envControlPort ?? config.hostEnvControlPort;
  const url = `http://127.0.0.1:${hostPort}`;
  const envControlUrl = `http://127.0.0.1:${hostEnvControlPort}`;
  await pullDockerImage(config.image, config.platform);
  const environment = await runOfficialWebArenaCommand([
    "env",
    "start",
    "--site",
    site,
    "--port",
    String(hostPort),
    "--env-ctrl-port",
    String(hostEnvControlPort),
    "--timeout",
    String(options.timeoutSeconds ?? 300),
  ], { visible: true });
  if (environment.exitCode !== 0) {
    throw new Error(`official env-control failed for ${site}: ${environment.stderr || environment.stdout}`);
  }
  if (site === "shopping_admin") {
    const search = await ensureRosettaSupervisorService(
      containerName,
      "elasticsearch",
      "http://127.0.0.1:9200/",
    );
    if (search.exitCode !== 0) {
      throw new Error(`shopping_admin Elasticsearch failed to become ready: ${search.stderr || search.stdout}`);
    }
    await waitForWebArenaEndpoint(`${url}${config.healthPath}`, 60_000);
  }
  return {
    site,
    provisioner: "docker",
    containerName,
    url,
    envControlUrl,
    container: null,
    environment,
  };
}

export function webArenaSiteUrl(site: string): string {
  const configured = configuredWebArenaUrl(site);
  if (configured) return configured;
  const config = DOCKER_SITES[site];
  if (!config) {
    throw new Error(
      `WebArena site ${site} requires ${siteEnvironmentName(site, "URL")}; the official local backend requires Docker`,
    );
  }
  return `http://127.0.0.1:${config.hostPort}`;
}

export function materializeWebArenaUrl(value: string): string {
  return OFFICIAL_SITES.reduce(
    (url, site) => {
      const token = `__${site.toUpperCase()}__`;
      if (!url.includes(token)) return url;
      const siteUrl = site === "shopping_admin"
        ? shoppingAdminUrl(webArenaSiteUrl(site))
        : webArenaSiteUrl(site);
      return url.replaceAll(token, siteUrl);
    },
    value,
  );
}

export async function evaluateWebArenaRun(outputRoot: string, taskId: number): Promise<CommandResult> {
  const run = await createWebArenaRun(outputRoot, taskId);
  return runOfficialWebArenaCommand([
    "eval-tasks",
    "--task-ids",
    String(taskId),
    "--output-dir",
    outputRoot,
    "--config",
    run.evalConfigPath,
  ]);
}

function evaluationConfig(sites: readonly string[]): object {
  return {
    environments: Object.fromEntries(sites.map((site) => [
      `__${site.toUpperCase()}__`,
      {
        urls: evaluationUrls(site),
        active_url_idx: 0,
      },
    ])),
  };
}

function evaluationUrls(site: string): string[] {
  const siteUrl = webArenaSiteUrl(site);
  const base = site === "shopping_admin" ? shoppingAdminUrl(siteUrl) : siteUrl;
  const parsed = new URL(base);
  if (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") return [base];
  const canonical = new URL(base);
  canonical.hostname = "localhost";
  const loopback = new URL(base);
  loopback.hostname = "127.0.0.1";
  return [canonical.toString().replace(/\/$/, ""), loopback.toString().replace(/\/$/, "")];
}

function shoppingAdminUrl(siteUrl: string): string {
  const parsed = new URL(siteUrl);
  return parsed.pathname.replace(/\/+$/, "").endsWith("/admin")
    ? siteUrl
    : `${siteUrl}/admin`;
}

function shoppingAdminSearchCheck(): BenchmarkDoctorCheck {
  if (configuredWebArenaUrl("shopping_admin")) {
    return {
      name: "WebArena-Verified shopping_admin search",
      status: "ready",
      detail: "external environment selected; local Colima service check is not applicable",
    };
  }
  return dockerContainerHttpCheck(
    "WebArena-Verified shopping_admin search",
    "webarena_verified_shopping_admin",
    "http://127.0.0.1:9200/",
  );
}

async function runOfficialWebArenaCommand(
  args: string[],
  options: { visible?: boolean } = {},
): Promise<CommandResult> {
  const source = benchmarkSources().webarenaVerified;
  const command = ["uvx", "--from", source, "webarena-verified", ...args];
  if (options.visible) {
    const process = Bun.spawn(command, { stdout: "inherit", stderr: "inherit" });
    const exitCode = await process.exited;
    return { command, exitCode, stdout: "", stderr: "" };
  }
  const process = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { command, exitCode, stdout, stderr };
}

async function waitForWebArenaEndpoint(url: string, timeoutMs: number): Promise<void> {
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
  throw new Error(`WebArena endpoint ${url} did not become ready: ${detail}`);
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

function configuredWebArenaUrl(site: string): string | undefined {
  return normalizedUrl(process.env[siteEnvironmentName(site, "URL")]);
}

function configuredWebArenaEnvControlUrl(site: string): string | undefined {
  return normalizedUrl(process.env[siteEnvironmentName(site, "ENV_CONTROL_URL")]);
}

function siteEnvironmentName(site: string, suffix: "URL" | "ENV_CONTROL_URL"): string {
  return `AB_WEBARENA_${site.toUpperCase()}_${suffix}`;
}

function normalizedUrl(value: string | undefined): string | undefined {
  return value?.replace(/\/+$/, "") || undefined;
}
