import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BenchmarkDoctorCheck } from "./types.ts";

export type BenchmarkSources = {
  miniwob: string;
  webarenaVerified: string;
  visualWebArena: string;
  browserGym: string;
};

export function benchmarkSources(environment: NodeJS.ProcessEnv = process.env): BenchmarkSources {
  const root = environment.AB_BENCHMARK_SOURCES ?? join(homedir(), "third-party");
  return {
    miniwob: environment.AB_MINIWOB_SOURCE ?? join(root, "miniwob-plusplus"),
    webarenaVerified:
      environment.AB_WEBARENA_VERIFIED_SOURCE ?? join(root, "webarena-verified"),
    visualWebArena:
      environment.AB_VISUALWEBARENA_SOURCE ?? join(root, "visualwebarena"),
    browserGym: environment.AB_BROWSERGYM_SOURCE ?? join(root, "BrowserGym"),
  };
}

export async function sourceCheck(
  name: string,
  root: string,
  marker: string,
): Promise<BenchmarkDoctorCheck> {
  const path = join(root, marker);
  try {
    await access(path);
    return { name, status: "ready", detail: path };
  } catch {
    return {
      name,
      status: "blocked",
      detail: `missing official source marker: ${path}`,
    };
  }
}

export function executableCheck(name: string, executable: string): BenchmarkDoctorCheck {
  const result = Bun.spawnSync(["which", executable], { stdout: "pipe", stderr: "pipe" });
  return result.exitCode === 0
    ? { name, status: "ready", detail: result.stdout.toString().trim() }
    : { name, status: "blocked", detail: `${executable} is not installed` };
}

export async function endpointCheck(
  name: string,
  url: string,
  options: { timeoutMs?: number } = {},
): Promise<BenchmarkDoctorCheck> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(options.timeoutMs ?? 2_000) });
    return response.status < 500
      ? { name, status: "ready", detail: `${url} -> HTTP ${response.status}` }
      : { name, status: "blocked", detail: `${url} -> HTTP ${response.status}` };
  } catch (error) {
    return {
      name,
      status: "blocked",
      detail: `${url} -> ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
