import { access, chmod, copyFile, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { BUILD_ID } from "../sdk/ts/src/protocol/generated/protocol-v3.ts";

const root = resolve(import.meta.dirname, "..");
const configuredTarget = process.env.CARGO_TARGET_DIR;
const targetDirectory = configuredTarget
  ? (isAbsolute(configuredTarget) ? configuredTarget : resolve(root, configuredTarget))
  : resolve(root, "target");
const source = resolve(targetDirectory, "release/ab-runtime");
const destinationDirectory = resolve(root, "sdk/native/darwin-arm64/bin");
const destination = resolve(destinationDirectory, "ab-runtime");
const packageDirectory = resolve(root, "sdk/native/darwin-arm64");
const upstreamLicense = resolve(root, "server/rust/agent-browser/LICENSE");

await access(source, constants.X_OK);
await mkdir(destinationDirectory, { recursive: true, mode: 0o755 });
await copyFile(source, destination);
await chmod(destination, 0o755);
await copyFile(upstreamLicense, resolve(packageDirectory, "LICENSE"));

const identityProbe = Bun.spawn([destination, "--build-id"], {
  stdin: "ignore",
  stdout: "pipe",
  stderr: "pipe",
});
const [reportedBuildId, probeError, probeExitCode] = await Promise.all([
  new Response(identityProbe.stdout).text(),
  new Response(identityProbe.stderr).text(),
  identityProbe.exited,
]);
if (probeExitCode !== 0 || reportedBuildId.trim() !== BUILD_ID) {
  throw new Error(
    `packaged AB runtime identity probe failed: expected ${BUILD_ID}, received ${JSON.stringify(reportedBuildId.trim())}, exit=${probeExitCode}, stderr=${JSON.stringify(probeError.trim())}`,
  );
}

console.log(destination);
