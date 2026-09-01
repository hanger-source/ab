import type { ABErrorData } from "../errors/index.js";
export type RuntimeStartupState = {
    startupId: string;
    state: "starting" | "ready" | "failed";
    startedAtUnixMs: number;
    updatedAtUnixMs: number;
    daemonId?: string;
    error?: ABErrorData;
};
export declare function resolveRuntimeBinary(): Promise<string>;
export declare function launchRuntime(binaryPath: string): void;
export declare function readRuntimeStartupState(): Promise<RuntimeStartupState | null>;
//# sourceMappingURL=native.d.ts.map