import { readFile } from "node:fs/promises";
import { ABError } from "../errors/index.js";
const DOCUMENTATION_FILES = {
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
    #read = new Set();
    markRead(topic) {
        this.#read.add(topic);
    }
    require(topic, member) {
        if (this.#read.has(topic))
            return;
        throw new ABError({
            kind: "documentation_required",
            stage: "agent.documentation",
            message: `${member} requires await browser.documentation(${JSON.stringify(topic)}) before use`,
            details: { topic, member },
        });
    }
}
export async function readDocumentation(topic) {
    const path = new URL(`../../docs/${DOCUMENTATION_FILES[topic]}`, import.meta.url);
    return readFile(path, "utf8");
}
//# sourceMappingURL=documentation.js.map