import { cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const skillRuntime = resolve(root, "skills/ab/runtime");
const sdkSource = resolve(root, "sdk/ts");
const sdkDestination = resolve(skillRuntime, "sdk");
const nativeSource = resolve(root, "sdk/native/darwin-arm64");
const nativeDestination = resolve(skillRuntime, "native/darwin-arm64");

await requirePath(resolve(sdkSource, "dist/agent/index.js"), "SDK build");
await requirePath(resolve(sdkSource, "docs/core.md"), "Agent documentation build");
await requirePath(resolve(nativeSource, "bin/ab-runtime"), "native runtime package");

await mkdir(sdkDestination, { recursive: true });
await mkdir(nativeDestination, { recursive: true });
await cp(resolve(sdkSource, "dist"), resolve(sdkDestination, "dist"), {
  recursive: true,
  force: true,
});
await cp(resolve(sdkSource, "docs"), resolve(sdkDestination, "docs"), {
  recursive: true,
  force: true,
});
for (const name of ["package.json", "README.md", "LICENSE"]) {
  await cp(resolve(sdkSource, name), resolve(sdkDestination, name), { force: true });
}
for (const name of ["bin", "package.json", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md"]) {
  await cp(resolve(nativeSource, name), resolve(nativeDestination, name), {
    recursive: true,
    force: true,
  });
}

const sdkPackage = JSON.parse(await readFile(resolve(sdkSource, "package.json"), "utf8"));
const nativePackage = JSON.parse(await readFile(resolve(nativeSource, "package.json"), "utf8"));
const generatedProtocol = await import(
  new URL("../sdk/ts/dist/protocol/generated/protocol-v3.js", import.meta.url)
);
const nativeBinary = resolve(nativeSource, "bin/ab-runtime");
const nativeBytes = await readFile(nativeBinary);
const embeddedBuildIds = [...new Set(
  nativeBytes
    .toString("latin1")
    .match(/ab-runtime@[0-9]+\.[0-9]+\.[0-9]+(?:-(?:alpha|beta|rc)\.[0-9]+)?\+[0-9a-f]{16}/g) ?? [],
)];
if (embeddedBuildIds.length !== 1 || embeddedBuildIds[0] !== generatedProtocol.BUILD_ID) {
  throw new Error(
    `AB package identity mismatch: native=${JSON.stringify(embeddedBuildIds)} sdk=${JSON.stringify(generatedProtocol.BUILD_ID)}`,
  );
}
if (nativePackage.version !== generatedProtocol.SDK_VERSION || sdkPackage.version !== generatedProtocol.SDK_VERSION) {
  throw new Error(
    `AB package version mismatch: native=${nativePackage.version} sdk=${sdkPackage.version} protocol=${generatedProtocol.SDK_VERSION}`,
  );
}
await writeFile(resolve(skillRuntime, "manifest.json"), `${JSON.stringify({
  format: 1,
  protocolVersion: generatedProtocol.PROTOCOL_VERSION,
  buildId: generatedProtocol.BUILD_ID,
  sdk: { name: sdkPackage.name, version: sdkPackage.version },
  native: {
    name: nativePackage.name,
    version: nativePackage.version,
    platform: "darwin-arm64",
  },
}, null, 2)}\n`);

console.log(`packaged self-contained AB Skill runtime at ${skillRuntime}`);

async function requirePath(path, label) {
  await stat(path).catch((cause) => {
    throw new Error(`${label} is missing at ${path}`, { cause });
  });
}
