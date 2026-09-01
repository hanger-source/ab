import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const nodeProcess = globalThis.process
  ?? createRequire(import.meta.url)("node:process");
if (globalThis.process === undefined) {
  Object.defineProperty(globalThis, "process", {
    value: nodeProcess,
    configurable: true,
  });
}
const process = nodeProcess;

const platform = `${process.platform}-${process.arch}`;
if (platform !== "darwin-arm64") {
  throw new Error(`AB Skill runtime does not contain a native build for ${platform}`);
}

const binaryUrl = new URL("../runtime/native/darwin-arm64/bin/ab-runtime", import.meta.url);
const binaryPath = fileURLToPath(binaryUrl);
await access(binaryPath, constants.X_OK).catch((cause) => {
  throw new Error(
    `AB Skill installation is incomplete: native runtime is missing or not executable at ${binaryPath}`,
    { cause },
  );
});

process.env.AB_RUNTIME_BINARY = binaryPath;
const uid = process.geteuid?.();
if (uid === undefined) {
  throw new Error("AB Skill runtime requires a Unix user identity");
}
const dataDirectory = join(homedir(), "Library", "Application Support", "ab");
process.env.AB_RUNTIME_DIR = join(tmpdir(), `ab-${uid}`);
process.env.AB_DATA_DIR = dataDirectory;
process.env.AB_PROFILE_DIR = join(dataDirectory, "chrome-profile");
delete process.env.AB_CHROME_PATH;

const agentApi = await import("../runtime/sdk/dist/agent/index.js");

export const connect = agentApi.connect;
export const nodeReplPresenter = agentApi.nodeReplPresenter;
export const terminalPresenter = agentApi.terminalPresenter;
