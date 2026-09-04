import type { ABErrorData } from "../errors/index.js";
import type { BrowserProvider } from "../options.js";
export type RuntimeStartupState = {
    startupId: string;
    state: "starting" | "ready" | "failed";
    startedAtUnixMs: number;
    updatedAtUnixMs: number;
    daemonId?: string;
    error?: ABErrorData;
};
export declare function resolveRuntimeBinary(): Promise<string>;
export declare function launchRuntime(binaryPath: string, provider: BrowserProvider): void;
export declare function readRuntimeStartupState(provider: BrowserProvider): Promise<RuntimeStartupState | null>;
//# sourceMappingURL=native.d.ts.map