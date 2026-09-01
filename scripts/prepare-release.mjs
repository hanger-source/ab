import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const version = process.argv[2];
if (!version) {
  throw new Error("usage: bun run release:prepare -- X.Y.Z[-(alpha|beta|rc).N]");
}
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:alpha|beta|rc)\.(?:0|[1-9]\d*))?$/.test(version)) {
  throw new Error(`unsupported release version ${JSON.stringify(version)}`);
}
if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error(`AB release preparation requires darwin-arm64, received ${process.platform}-${process.arch}`);
}

const rootPackage = await readJson("package.json");
const sdkPackage = await readJson("sdk/ts/package.json");
const nativePackage = await readJson("sdk/native/darwin-arm64/package.json");

rootPackage.version = version;
sdkPackage.version = version;
nativePackage.version = version;
sdkPackage.optionalDependencies = {
  "@hanger-source/ab-runtime-darwin-arm64": version,
};

await writeJson("package.json", rootPackage);
await writeJson("sdk/ts/package.json", sdkPackage);
await writeJson("sdk/native/darwin-arm64/package.json", nativePackage);

const cargoToml = await readText("Cargo.toml");
const cargoVersionPattern = /(\[workspace\.package\][\s\S]*?\nversion = ")[^"]+("\n)/;
if (!cargoVersionPattern.test(cargoToml)) {
  throw new Error("Cargo workspace version field was not found");
}
const nextCargoToml = cargoToml.replace(
  cargoVersionPattern,
  (_match, prefix, suffix) => `${prefix}${version}${suffix}`,
);
await writeFile(resolve(root, "Cargo.toml"), nextCargoToml);

const skill = await readText("skills/ab/SKILL.md");
if (!/^  version: "[^"]+"$/m.test(skill)) {
  throw new Error("Skill metadata version field was not found");
}
const nextSkill = skill.replace(/^  version: "[^"]+"$/m, `  version: "${version}"`);
await writeFile(resolve(root, "skills/ab/SKILL.md"), nextSkill);

run("bun", ["install"]);
run("cargo", ["metadata", "--no-deps", "--format-version", "1"]);
run("bun", ["run", "protocol:generate"]);
run("bun", ["run", "verify:ci"]);

console.log(`release ${version} is built, verified, and ready to commit`);

async function readJson(path) {
  return JSON.parse(await readText(path));
}

async function readText(path) {
  return readFile(resolve(root, path), "utf8");
}

async function writeJson(path, value) {
  await writeFile(resolve(root, path), `${JSON.stringify(value, null, 2)}\n`);
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit ${result.status}`);
  }
}
