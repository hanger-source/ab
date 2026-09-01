import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { closeSync, constants, mkdirSync, openSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { dataDirectory, startupPath } from "./paths.js";
const require = createRequire(import.meta.url);
export async function resolveRuntimeBinary() {
    const configured = process.env.AB_RUNTIME_BINARY;
    if (configured) {
        await assertExecutable(configured);
        return configured;
    }
    if (process.platform !== "darwin" || process.arch !== "arm64") {
        throw new Error(`ab does not provide a runtime for ${process.platform}-${process.arch}`);
    }
    let packageJson;
    try {
        packageJson = require.resolve("@hanger-source/ab-runtime-darwin-arm64/package.json");
    }
    catch (cause) {
        throw new Error("AB native runtime package @hanger-source/ab-runtime-darwin-arm64 is not installed", { cause });
    }
    const binary = join(dirname(packageJson), "bin", "ab-runtime");
    await assertExecutable(binary);
    return binary;
}
export function launchRuntime(binaryPath) {
    const logsDirectory = join(dataDirectory(), "logs");
    mkdirSync(logsDirectory, { recursive: true, mode: 0o700 });
    const output = openSync(join(logsDirectory, "runtime.stderr.log"), "a", 0o600);
    try {
        const child = spawn(binaryPath, [], {
            detached: true,
            stdio: ["ignore", output, output],
            env: process.env,
        });
        child.unref();
    }
    finally {
        closeSync(output);
    }
}
export async function readRuntimeStartupState() {
    try {
        const value = JSON.parse(await readFile(startupPath(), "utf8"));
        if (typeof value.startupId !== "string" || typeof value.state !== "string") {
            throw new Error("AB runtime startup state is malformed");
        }
        return value;
    }
    catch (error) {
        if (error.code === "ENOENT")
            return null;
        throw error;
    }
}
async function assertExecutable(path) {
    await access(path, constants.X_OK);
}
//# sourceMappingURL=native.js.map