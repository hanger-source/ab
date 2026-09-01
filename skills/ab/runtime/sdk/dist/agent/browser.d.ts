import { inspect } from "node:util";
import { type BrowserIdentity, type NavigateOptions, type ScreenshotOptions } from "../browser/index.js";
import type { Screenshot } from "../artifacts/index.js";
import type { Diagnostics } from "../diagnostics/index.js";
import type { OperationOptions } from "../options.js";
import { AX } from "./ax.js";
import { CUA } from "./cua.js";
import { Dev } from "./dev.js";
import { type DocumentationTopic } from "./documentation.js";
import { Playwright } from "./playwright.js";
import { type Presenter } from "./presentation.js";
import { Resources } from "./resources.js";
export type ConnectOptions = {
    timeoutMs?: number;
    signal?: AbortSignal;
    presenter?: Presenter;
};
/** Explicit Agent-facing tab with capability namespaces instead of Core forwarding. */
export declare class Tab {
    #private;
    readonly ax: AX;
    readonly playwright: Playwright;
    readonly cua: CUA;
    readonly resources: Resources;
    readonly dev: Dev;
    private constructor();
    get id(): string;
    get title(): string;
    get openerId(): string | null;
    get url(): string;
    get active(): boolean;
    refresh(options?: OperationOptions): Promise<Tab>;
    goto(url: string, options?: NavigateOptions): Promise<void>;
    reload(options?: OperationOptions): Promise<void>;
    goBack(options?: OperationOptions): Promise<void>;
    goForward(options?: OperationOptions): Promise<void>;
    activate(options?: OperationOptions): Promise<void>;
    close(options?: OperationOptions): Promise<void>;
    screenshot(options?: ScreenshotOptions): Promise<Screenshot>;
    [inspect.custom](): string;
}
/** Agent tab discovery with a stable wrapper and presentation baseline per target. */
export declare class Tabs {
    #private;
    private constructor();
    list(options?: OperationOptions): Promise<Tab[]>;
    get(targetId: string, options?: OperationOptions): Promise<Tab>;
    open(url?: string, options?: NavigateOptions): Promise<Tab>;
}
export declare class Browser {
    #private;
    readonly identity: BrowserIdentity;
    readonly tabs: Tabs;
    readonly diagnostics: Diagnostics;
    private constructor();
    get connected(): boolean;
    documentation(topic?: DocumentationTopic): Promise<string>;
    disconnect(): Promise<void>;
    [inspect.custom](): string;
}
/** Connects the Agent facade to the Core SDK and version-matched Rust runtime. */
export declare function connect(options?: ConnectOptions): Promise<Browser>;
//# sourceMappingURL=browser.d.ts.map