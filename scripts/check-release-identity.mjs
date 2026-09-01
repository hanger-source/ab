import { appendFile, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (!key?.startsWith("--") || value === undefined) {
    throw new Error(`expected --name value arguments, received ${process.argv.slice(2).join(" ")}`);
  }
  args.set(key, value);
}

const rootPackage = await readJson("package.json");
const sdkPackage = await readJson("sdk/ts/package.json");
const nativePackage = await readJson("sdk/native/darwin-arm64/package.json");
const version = rootPackage.version;
const parsed = parseReleaseVersion(version);
const expectedTag = `v${version}`;
const npmTag = parsed.channel ?? "latest";

assertEqual(rootPackage.name, "ab-workspace", "workspace package name");
assertEqual(sdkPackage.name, "@hanger-source/ab", "SDK package name");
assertEqual(nativePackage.name, "@hanger-source/ab-runtime-darwin-arm64", "native package name");
assertEqual(sdkPackage.version, version, "SDK version");
assertEqual(nativePackage.version, version, "native version");
assertEqual(
  sdkPackage.optionalDependencies?.[nativePackage.name],
  version,
  "SDK native optional dependency",
);
assertPublicPackage(sdkPackage, "SDK");
assertPublicPackage(nativePackage, "native");

const cargoToml = await readText("Cargo.toml");
const cargoVersion = cargoToml.match(/\[workspace\.package\][\s\S]*?\nversion = "([^"]+)"/)?.[1];
assertEqual(cargoVersion, version, "Cargo workspace version");

const cargoMetadata = run("cargo", ["metadata", "--no-deps", "--format-version", "1"]);
const workspacePackages = JSON.parse(cargoMetadata).packages
  .filter((candidate) => ["ab-protocol", "ab-runtime"].includes(candidate.name));
for (const candidate of workspacePackages) {
  assertEqual(candidate.version, version, `Cargo package ${candidate.name} version`);
}
assertEqual(workspacePackages.length, 2, "AB Cargo package count");

const skill = await readText("skills/ab/SKILL.md");
const skillVersion = skill.match(/^  version: "([^"]+)"$/m)?.[1];
assertEqual(skillVersion, version, "Skill metadata version");

const generated = await readText("sdk/ts/src/protocol/generated/protocol-v3.ts");
const generatedVersion = generated.match(/SDK_VERSION = "([^"]+)"/)?.[1];
const generatedBuildId = generated.match(/BUILD_ID = "([^"]+)"/)?.[1];
assertEqual(generatedVersion, version, "generated SDK version");
if (!generatedBuildId?.startsWith(`ab-runtime@${version}+`)) {
  throw new Error(`generated build id ${JSON.stringify(generatedBuildId)} does not belong to ${version}`);
}

const skillManifest = await readJson("skills/ab/runtime/manifest.json");
assertEqual(skillManifest.sdk?.name, sdkPackage.name, "Skill SDK name");
assertEqual(skillManifest.sdk?.version, version, "Skill SDK version");
assertEqual(skillManifest.native?.name, nativePackage.name, "Skill native name");
assertEqual(skillManifest.native?.version, version, "Skill native version");
assertEqual(skillManifest.buildId, generatedBuildId, "Skill build id");

const rootLicense = await readText("LICENSE");
assertEqual(await readText("sdk/ts/LICENSE"), rootLicense, "SDK license");
assertEqual(await readText("skills/ab/runtime/sdk/LICENSE"), rootLicense, "Skill SDK license");

for (const path of [
  "sdk/native/darwin-arm64/bin/ab-runtime",
  "skills/ab/runtime/native/darwin-arm64/bin/ab-runtime",
]) {
  const reportedBuildId = run(resolve(root, path), ["--build-id"]).trim();
  assertEqual(reportedBuildId, generatedBuildId, `${path} build id`);
}

const tag = args.get("--tag");
if (tag !== undefined) assertEqual(tag, expectedTag, "Git tag");

const githubPrerelease = args.get("--github-prerelease");
if (githubPrerelease !== undefined) {
  const expectedPrerelease = parsed.channel === undefined ? "false" : "true";
  assertEqual(githubPrerelease, expectedPrerelease, "GitHub prerelease flag");
}

const githubOutput = args.get("--github-output");
if (githubOutput !== undefined) {
  await appendFile(githubOutput, `version=${version}\nnpm_tag=${npmTag}\n`);
}

console.log(`release identity verified: ${expectedTag} -> npm dist-tag ${npmTag}`);

function parseReleaseVersion(value) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(alpha|beta|rc)\.(0|[1-9]\d*))?$/.exec(value);
  if (!match) {
    throw new Error(
      `unsupported release version ${JSON.stringify(value)}; use X.Y.Z or X.Y.Z-(alpha|beta|rc).N`,
    );
  }
  return { channel: match[4] };
}

function assertPublicPackage(value, label) {
  assertEqual(value.author, "hanger", `${label} author`);
  assertEqual(value.license, "Apache-2.0", `${label} license`);
  assertEqual(value.repository?.url, "git+https://github.com/hanger-source/ab.git", `${label} repository`);
  assertEqual(value.publishConfig?.access, "public", `${label} publish access`);
  assertEqual(value.publishConfig?.registry, "https://registry.npmjs.org/", `${label} registry`);
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label} mismatch: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}

async function readJson(path) {
  return JSON.parse(await readText(path));
}

async function readText(path) {
  return readFile(resolve(root, path), "utf8");
}

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${commandArgs.join(" ")} failed with exit ${result.status}: ${result.stderr.trim()}`,
    );
  }
  return result.stdout;
}
