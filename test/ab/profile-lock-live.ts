import assert from "node:assert/strict";
import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { connect, ABError } from "../../sdk/ts/src/index.ts";

const dataDirectory = requiredEnv("AB_DATA_DIR");
const runtimeDirectory = requiredEnv("AB_RUNTIME_DIR");
const profileDirectory = join(dataDirectory, "chrome-profile");
await mkdir(profileDirectory, { recursive: true });
await symlink("unmanaged-owner", join(profileDirectory, "SingletonLock"));

try {
  const startedAt = performance.now();
  const startupTimeoutMs = 5_000;
  let failure: unknown;
  try {
    await connect({ timeoutMs: startupTimeoutMs });
  } catch (error) {
    failure = error;
  }
  console.log(JSON.stringify({
    stage: "profile-lock-connect-failure",
    kind: failure instanceof ABError ? failure.kind : null,
    errorStage: failure instanceof ABError ? failure.stage : null,
    message: failure instanceof Error ? failure.message : String(failure),
    startupState: await Bun.file(join(runtimeDirectory, "startup.json")).json().catch(() => null),
  }));
  assert(failure instanceof ABError);
  assert.equal(failure.kind, "profile_in_use_unmanaged");
  assert.equal(failure.stage, "chrome.profile");
  const elapsedMs = performance.now() - startedAt;
  assert(elapsedMs < startupTimeoutMs, `structured startup failure took ${elapsedMs}ms`);

  console.log(JSON.stringify({
    error: {
      kind: failure.kind,
      stage: failure.stage,
      message: failure.message,
    },
    elapsedMs,
    profileDirectory,
  }, null, 2));
} finally {
  await stopDaemon(join(runtimeDirectory, "browser.sock"));
}

async function stopDaemon(socketPath: string): Promise<void> {
  const lsofProcess = Bun.spawn(["lsof", "-t", socketPath], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const output = await new Response(lsofProcess.stdout).text();
  await lsofProcess.exited;
  for (const value of output.trim().split(/\s+/).filter(Boolean)) {
    try {
      process.kill(Number(value), "SIGTERM");
    } catch {
      // The startup-error daemon normally exits after rejecting its clients.
    }
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  assert(value, `${name} is required`);
  return value;
}
