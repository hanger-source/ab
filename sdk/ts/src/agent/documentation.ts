import { readFile } from "node:fs/promises";
import { ABError } from "../errors/index.js";

export type DocumentationTopic =
  | "core"
  | "api"
  | "bootstrap"
  | "lifecycle"
  | "safety"
  | "authentication"
  | "tabs"
  | "navigation"
  | "observation"
  | "actions"
  | "forms"
  | "screenshot"
  | "frames"
  | "evaluate"
  | "network"
  | "console-dialogs"
  | "downloads"
  | "init-scripts"
  | "resources"
  | "cdp"
  | "recovery"
  | "task-recipes"
  | "diagnostics";

const DOCUMENTATION_FILES: Record<DocumentationTopic, string> = {
  core: "core.md",
  api: "api.md",
  bootstrap: "bootstrap.md",
  lifecycle: "lifecycle.md",
  safety: "safety.md",
  authentication: "authentication.md",
  tabs: "tabs.md",
  navigation: "navigation.md",
  observation: "observation.md",
  actions: "actions.md",
  forms: "forms.md",
  screenshot: "screenshot.md",
  frames: "frames.md",
  evaluate: "evaluate.md",
  network: "network.md",
  "console-dialogs": "console-dialogs.md",
  downloads: "downloads.md",
  "init-scripts": "init-scripts.md",
  resources: "resources.md",
  cdp: "cdp.md",
  recovery: "recovery.md",
  "task-recipes": "task-recipes.md",
  diagnostics: "diagnostics.md",
};

export class DocumentationRegistry {
  readonly #read = new Set<DocumentationTopic>();

  markRead(topic: DocumentationTopic): void {
    this.#read.add(topic);
  }

  require(topic: DocumentationTopic, member: string): void {
    if (this.#read.has(topic)) return;
    throw new ABError({
      kind: "documentation_required",
      stage: "agent.documentation",
      message: `${member} requires await browser.documentation(${JSON.stringify(topic)}) before use`,
      details: { topic, member },
    });
  }
}

export async function readDocumentation(topic: DocumentationTopic): Promise<string> {
  const path = new URL(`../../docs/${DOCUMENTATION_FILES[topic]}`, import.meta.url);
  return readFile(path, "utf8");
}
