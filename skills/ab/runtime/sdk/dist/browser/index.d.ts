import { inspect } from "node:util";
import { CUA } from "../actions/cua.js";
import { Screenshot, type ScreenshotScale } from "../artifacts/index.js";
import { Diagnostics } from "../diagnostics/index.js";
import { Locator } from "../locators/index.js";
import { AX, AXState, type SnapshotOptions } from "../ax/index.js";
import type { OperationOptions } from "../options.js";
import { ConsoleObserver, DialogWatcher, DownloadWatcher, FileChooserWatcher, InitScriptRegistration, type InitScriptDefinition, NetworkObserver, type NetworkObserverOptions, PopupWatcher } from "../resources/index.js";
import { ProtocolClient } from "../transport/index.js";
export type BrowserIdentity = {
    clientId: string;
    daemonId: string;
    browserGeneration: string;
    chrome: {
        source: "launched" | "reattached" | "external";
        pid: number | null;
    };
};
export type TabInfo = {
    id: string;
    openerId: string | null;
    title: string;
    url: string;
    kind: string;
    active: boolean;
    ownership: "available" | "owned" | "other";
    engineId: string;
    label: string | null;
};
export type NavigateOptions = OperationOptions & {
    waitUntil?: "none" | "domcontentloaded" | "load";
    timeoutMs?: number;
};
export type LoadState = "domcontentloaded" | "load";
export type ScreenshotOptions = OperationOptions & {
    fullPage?: boolean;
    scale?: ScreenshotScale;
};
export type FrameInfo = {
    id: string;
    targetId: string;
    sessionId: string;
    parentId: string | null;
    url: string;
    name: string | null;
    documentGeneration: string;
};
export type RealmInfo = {
    id: string;
    executionContextId: number;
    rootTargetId: string;
    targetId: string;
    sessionId: string;
    frameId: string | null;
    origin: string;
    name: string;
    kind: string;
    isDefault: boolean;
};
export type ObserveOptions = OperationOptions & {
    ax?: Omit<SnapshotOptions, "timeoutMs" | "signal"> | boolean;
    screenshot?: boolean;
    fullPage?: boolean;
    scale?: ScreenshotScale;
};
export type PageObservation = {
    state?: AXState;
    screenshot?: Screenshot;
};
/** Explicit low-level CDP access for diagnostics and unsupported primitives. */
export declare class CDPSession {
    #private;
    constructor(client: ProtocolClient, tabId: string, resourceId: string);
    /** Sends one CDP method to the tab's root session. */
    send<T = unknown>(method: string, params?: unknown, options?: OperationOptions): Promise<T>;
    dispose(options?: OperationOptions): Promise<void>;
}
/** A frame identity captured from the Rust SessionManager registry. */
export declare class Frame {
    #private;
    readonly id: string;
    readonly targetId: string;
    readonly parentId: string | null;
    readonly url: string;
    readonly name: string | null;
    readonly documentGeneration: string;
    readonly sessionId: string;
    constructor(client: ProtocolClient, value: FrameInfo);
    cdp(): Promise<CDPSession>;
    /** Creates a CSS Locator explicitly scoped to this frame. */
    locator(selector: string): Locator;
    getByRole(role: string, options?: {
        name?: string;
        exact?: boolean;
    }): Locator;
    getByText(text: string, options?: {
        exact?: boolean;
    }): Locator;
    getByLabel(label: string, options?: {
        exact?: boolean;
    }): Locator;
    getByPlaceholder(placeholder: string, options?: {
        exact?: boolean;
    }): Locator;
    getByAltText(text: string, options?: {
        exact?: boolean;
    }): Locator;
    getByTitle(title: string, options?: {
        exact?: boolean;
    }): Locator;
    getByTestId(testId: string): Locator;
    /** Evaluates a function in this frame's current default realm. */
    evaluate<T, Args extends unknown[]>(pageFunction: (...args: Args) => T | Promise<T>, ...args: Args): Promise<Awaited<T>>;
    [inspect.custom](): string;
}
/** A concrete JavaScript execution realm owned by one CDP session. */
export declare class Realm {
    #private;
    readonly id: string;
    readonly executionContextId: number;
    readonly rootTargetId: string;
    readonly targetId: string;
    readonly frameId: string | null;
    readonly origin: string;
    readonly name: string;
    readonly kind: string;
    readonly isDefault: boolean;
    readonly sessionId: string;
    constructor(client: ProtocolClient, value: RealmInfo);
    /** Evaluates a function in this exact execution context. */
    evaluate<T, Args extends unknown[]>(pageFunction: (...args: Args) => T | Promise<T>, ...args: Args): Promise<Awaited<T>>;
    [inspect.custom](): string;
}
/** A Chrome page target with typed observation, action, and resource surfaces. */
export declare class Tab {
    #private;
    readonly id: string;
    readonly ax: AX;
    readonly cua: CUA;
    constructor(client: ProtocolClient, info: TabInfo);
    get title(): string;
    get openerId(): string | null;
    get url(): string;
    get active(): boolean;
    /** Mutable-target ownership relative to this SDK client. */
    get ownership(): TabInfo["ownership"];
    refresh(options?: OperationOptions): Promise<Tab>;
    /** Acquires this existing target for mutation by the current SDK client. */
    acquire(options?: OperationOptions): Promise<Tab>;
    /** Navigates this tab and waits for the requested mechanical lifecycle state. */
    navigate(url: string, options?: NavigateOptions): Promise<void>;
    /** Captures pixels and returns a local artifact plus viewport identity. */
    screenshot(options?: ScreenshotOptions): Promise<Screenshot>;
    /** Returns the current frame registry, including dynamically attached OOPIFs. */
    frames(options?: OperationOptions): Promise<Frame[]>;
    /** Returns the root frame for this tab's current document topology. */
    mainFrame(options?: OperationOptions): Promise<Frame>;
    /** Returns the current JavaScript realm registry for this tab. */
    realms(options?: OperationOptions): Promise<Realm[]>;
    cdp(): Promise<CDPSession>;
    observeNetwork(options?: NetworkObserverOptions): Promise<NetworkObserver>;
    observeConsole(options?: OperationOptions): Promise<ConsoleObserver>;
    watchDialogs(options?: OperationOptions): Promise<DialogWatcher>;
    watchPopups(options?: OperationOptions): Promise<PopupWatcher>;
    watchDownloads(options?: OperationOptions): Promise<DownloadWatcher>;
    watchFileChoosers(options?: OperationOptions): Promise<FileChooserWatcher>;
    addInitScript(definition: InitScriptDefinition, options?: OperationOptions): Promise<InitScriptRegistration>;
    locator(selector: string): Locator;
    getByRole(role: string, options?: {
        name?: string;
        exact?: boolean;
    }): Locator;
    getByText(text: string, options?: {
        exact?: boolean;
    }): Locator;
    getByLabel(label: string, options?: {
        exact?: boolean;
    }): Locator;
    getByPlaceholder(placeholder: string, options?: {
        exact?: boolean;
    }): Locator;
    getByAltText(text: string, options?: {
        exact?: boolean;
    }): Locator;
    getByTitle(title: string, options?: {
        exact?: boolean;
    }): Locator;
    getByTestId(testId: string): Locator;
    /** Evaluates a function in the root frame's current default realm. */
    evaluate<T, Args extends unknown[]>(pageFunction: (...args: Args) => T | Promise<T>, ...args: Args): Promise<Awaited<T>>;
    activate(options?: OperationOptions): Promise<void>;
    reload(options?: OperationOptions): Promise<void>;
    goBack(options?: OperationOptions): Promise<void>;
    goForward(options?: OperationOptions): Promise<void>;
    waitFor(options: OperationOptions & {
        selector?: string;
        text?: string;
        state?: "attached" | "detached" | "visible" | "hidden";
    }): Promise<void>;
    /** Waits until the target URL contains a literal pattern or matches a `*` wildcard pattern. */
    waitForURL(url: string, options?: OperationOptions): Promise<void>;
    /**
     * Waits for readiness of the document current when this request reaches the Runtime.
     * This does not anticipate a future navigation or imply network/application readiness.
     */
    waitForLoadState(state?: LoadState, options?: OperationOptions): Promise<void>;
    /**
     * Atomically captures the requested AX state and screenshot.
     *
     * When both are requested, Rust validates one document, frame topology,
     * viewport, scroll position, and DPR transaction before returning either.
     */
    observe(options: ObserveOptions): Promise<PageObservation>;
    close(options?: OperationOptions): Promise<void>;
    [inspect.custom](): string;
}
/** Browser target discovery and creation. */
export declare class Tabs {
    #private;
    constructor(client: ProtocolClient);
    list(options?: OperationOptions): Promise<Tab[]>;
    get(targetId: string, options?: OperationOptions): Promise<Tab>;
    /** Gets and atomically acquires an existing target for this client. */
    acquire(targetId: string, options?: OperationOptions): Promise<Tab>;
    open(url?: string, options?: NavigateOptions): Promise<Tab>;
}
/** One SDK client attached to the persistent AB daemon and Chrome instance. */
export declare class Browser {
    #private;
    readonly identity: BrowserIdentity;
    readonly tabs: Tabs;
    readonly diagnostics: Diagnostics;
    constructor(client: ProtocolClient, onDisconnect: () => void);
    get connected(): boolean;
    /** Releases this client's server-owned resources without closing Chrome. */
    disconnect(): Promise<void>;
    [inspect.custom](): string;
}
//# sourceMappingURL=index.d.ts.map