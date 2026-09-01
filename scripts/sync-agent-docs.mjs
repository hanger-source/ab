import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const references = resolve(root, "skills/ab/references");
const output = resolve(root, "sdk/ts/docs");
const check = process.argv.includes("--check");
const topics = {
  "actions.md": "actions.md",
  "api.md": "api.md",
  "authentication.md": "authentication.md",
  "bootstrap.md": "bootstrap.md",
  "cdp.md": "cdp.md",
  "console-dialogs.md": "console-dialogs.md",
  "core.md": "core.md",
  "diagnostics.md": "diagnostics.md",
  "downloads.md": "downloads-uploads.md",
  "evaluate.md": "evaluate.md",
  "forms.md": "forms.md",
  "frames.md": "frames-realms.md",
  "init-scripts.md": "init-scripts.md",
  "lifecycle.md": "lifecycle.md",
  "navigation.md": "navigation-waits.md",
  "network.md": "network.md",
  "observation.md": "observation.md",
  "recovery.md": "recovery.md",
  "resources.md": "resources.md",
  "safety.md": "safety.md",
  "screenshot.md": "screenshot-cua.md",
  "task-recipes.md": "task-recipes.md",
  "tabs.md": "tabs.md",
};

await mkdir(output, { recursive: true });
const stale = [];
for (const [outputName, referenceName] of Object.entries(topics)) {
  const expected = await readFile(resolve(references, referenceName), "utf8");
  const destination = resolve(output, outputName);
  if (check) {
    const actual = await readFile(destination, "utf8").catch(() => null);
    if (actual !== expected) stale.push(outputName);
  } else {
    await writeFile(destination, expected);
  }
}

if (stale.length > 0) {
  throw new Error(`generated Agent documentation is stale: ${stale.join(", ")}`);
}

console.log(`${check ? "checked" : "synchronized"} ${Object.keys(topics).length} Agent documentation topics`);
