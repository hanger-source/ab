export type DocumentationTopic = "core" | "api" | "bootstrap" | "lifecycle" | "safety" | "authentication" | "tabs" | "navigation" | "observation" | "actions" | "forms" | "screenshot" | "frames" | "evaluate" | "network" | "console-dialogs" | "downloads" | "init-scripts" | "resources" | "cdp" | "recovery" | "task-recipes" | "diagnostics";
export declare class DocumentationRegistry {
    #private;
    markRead(topic: DocumentationTopic): void;
    require(topic: DocumentationTopic, member: string): void;
}
export declare function readDocumentation(topic: DocumentationTopic): Promise<string>;
//# sourceMappingURL=documentation.d.ts.map