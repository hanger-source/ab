import { Browser, type BrowserIdentity, type NavigateOptions, type PageObservation, Tab } from "../browser/index.js";
import type { Screenshot, ScreenshotScale } from "../artifacts/index.js";
import type { ElementHandle, ElementInspection, ElementInspectionOptions } from "../elements/index.js";
import { type ActionResult, type AXState, type ClickOptions, type RefActionOptions, type SnapshotOptions, type TypeOptions } from "../ax/index.js";
import type { TextInputActionData } from "../actions/result.js";
import { CUA, type CuaActionData, type CuaClickOptions, type CuaDragOptions, type CuaPoint, type CuaWheelOptions } from "../actions/cua.js";
import type { OperationOptions } from "../options.js";
import type { Diagnostics } from "../diagnostics/index.js";
import { Locator, type LocatorActionOptions, type LocatorClickOptions, type LocatorFilter, type LocatorResult, type SuggestionCommitOptions, type SuggestionCommitResult, type LocatorWaitOptions } from "../locators/index.js";
export type AgentAXContent = "state" | "screenshot" | "both";
export type AgentTextPresentation = {
    kind: "ax" | "action" | "documentation";
    origin: string;
    observationId: string | null;
    text: string;
    untrusted: boolean;
};
export type AgentImagePresentation = {
    kind: "screenshot";
    origin: string;
    screenshot: Screenshot;
};
export interface AgentPresenter {
    presentText(value: AgentTextPresentation): void | Promise<void>;
    presentImage(value: AgentImagePresentation): void | Promise<void>;
}
export interface NodeReplContentHost {
    write(value: unknown): void;
    emitImage(image: Uint8Array | {
        bytes: Uint8Array;
        mimeType: string;
    }): void | Promise<void>;
}
export type AgentConnectOptions = {
    timeoutMs?: number;
    signal?: AbortSignal;
    presenter?: AgentPresenter;
};
export type AgentWriteOptions = SnapshotOptions & {
    fullPage?: boolean;
    scale?: ScreenshotScale;
};
export type AgentActionWrite = "diff" | "state" | "none";
type AgentOwnedActionOptions<T> = Omit<T, "observe" | "baseline">;
export type AgentRefActionOptions = AgentOwnedActionOptions<RefActionOptions> & {
    write?: AgentActionWrite;
};
export type AgentClickOptions = AgentOwnedActionOptions<ClickOptions> & {
    write?: AgentActionWrite;
};
export type AgentTypeOptions = AgentOwnedActionOptions<TypeOptions> & {
    write?: AgentActionWrite;
};
export type AgentLocatorActionOptions = AgentOwnedActionOptions<LocatorActionOptions> & {
    write?: AgentActionWrite;
};
export type AgentLocatorClickOptions = AgentOwnedActionOptions<LocatorClickOptions> & {
    write?: AgentActionWrite;
};
export type AgentLocatorTypeOptions = AgentLocatorActionOptions & {
    clear?: boolean;
    delayMs?: number;
};
export type AgentSuggestionCommitOptions = AgentOwnedActionOptions<SuggestionCommitOptions> & {
    write?: AgentActionWrite;
};
export type AgentLocatorWaitOptions = LocatorWaitOptions & {
    /** Present a fresh full state after the semantic wait succeeds. */
    write?: "state" | "none";
    /** Shape and deadline for the post-wait state capture. */
    observation?: AgentWriteOptions;
};
export type AgentLocatorFilter = Omit<LocatorFilter, "has"> & {
    has?: AgentLocator;
};
export type AgentDocumentationTopic = "core" | "api" | "bootstrap" | "lifecycle" | "safety" | "authentication" | "tabs" | "navigation" | "observation" | "actions" | "forms" | "screenshot" | "frames" | "evaluate" | "network" | "console-dialogs" | "downloads" | "init-scripts" | "resources" | "cdp" | "recovery" | "task-recipes" | "diagnostics";
declare class AgentDocumentationRegistry {
    #private;
    markRead(topic: AgentDocumentationTopic): void;
    require(topic: AgentDocumentationTopic, member: string): void;
}
/** Presentation for ordinary Node.js processes. */
export declare function terminalPresenter(): AgentPresenter;
/** Presentation through the public content channel of a managed Node REPL. */
export declare function nodeReplPresenter(host: NodeReplContentHost): AgentPresenter;
export declare class AgentAX {
    #private;
    constructor(tab: Tab, presenter: AgentPresenter, documentation: AgentDocumentationRegistry);
    get(content: "state", options?: AgentWriteOptions): Promise<AXState>;
    get(content: "screenshot", options?: AgentWriteOptions): Promise<Screenshot>;
    get(content: "both", options?: AgentWriteOptions): Promise<PageObservation>;
    write(content: AgentAXContent, options?: AgentWriteOptions): Promise<void>;
    write(state: AXState): Promise<void>;
    click(refId: string, options?: AgentClickOptions): Promise<ActionResult>;
    doubleClick(refId: string, options?: AgentRefActionOptions): Promise<ActionResult>;
    hover(refId: string, options?: AgentRefActionOptions): Promise<ActionResult>;
    wheel(refId: string, deltaX: number, deltaY: number, options?: AgentRefActionOptions): Promise<ActionResult>;
    fill(refId: string, value: string, options?: AgentRefActionOptions): Promise<ActionResult<TextInputActionData>>;
    type(refId: string, text: string, options?: AgentTypeOptions): Promise<ActionResult<TextInputActionData>>;
    press(refId: string, key: string, options?: AgentRefActionOptions): Promise<ActionResult>;
    focus(refId: string, options?: AgentRefActionOptions): Promise<ActionResult>;
    clear(refId: string, options?: AgentRefActionOptions): Promise<ActionResult>;
    check(refId: string, options?: AgentRefActionOptions): Promise<ActionResult>;
    uncheck(refId: string, options?: AgentRefActionOptions): Promise<ActionResult>;
    selectOption(refId: string, values: string | string[], options?: AgentRefActionOptions): Promise<ActionResult>;
    setFiles(refId: string, files: string | string[], options?: AgentRefActionOptions): Promise<ActionResult>;
    dragTo(sourceRefId: string, targetRefId: string, options?: AgentRefActionOptions): Promise<ActionResult>;
    scrollIntoView(refId: string, options?: AgentRefActionOptions): Promise<ActionResult>;
    dispose(): Promise<void>;
    /** The exact observation currently visible to this Agent session. */
    actionBaseline(): AXState | null;
    presentActionObservationOutcome(result: ActionResult): Promise<void>;
}
/** Agent-facing viewport input that binds post-action state to the presented AX baseline. */
export declare class AgentCUA {
    #private;
    constructor(core: CUA, ax: AgentAX);
    click(options: CuaClickOptions): Promise<ActionResult<CuaActionData>>;
    move(options: CuaPoint): Promise<ActionResult<CuaActionData>>;
    wheel(options: CuaWheelOptions): Promise<ActionResult<CuaActionData>>;
    drag(options: CuaDragOptions): Promise<ActionResult<CuaActionData>>;
}
/**
 * Agent-facing immutable Locator. Mutations default to presenting the
 * ActionResult's existing post-action observation instead of capturing again.
 */
export declare class AgentLocator {
    #private;
    constructor(core: Locator, ax: AgentAX);
    get query(): Locator["query"];
    filter(filter: AgentLocatorFilter): AgentLocator;
    locator(selector: string | AgentLocator): AgentLocator;
    and(other: AgentLocator): AgentLocator;
    or(other: AgentLocator): AgentLocator;
    inFrame(frameId: string): AgentLocator;
    nth(index: number): AgentLocator;
    first(): AgentLocator;
    last(): AgentLocator;
    count(options?: OperationOptions): Promise<number>;
    all(options?: OperationOptions): Promise<AgentLocator[]>;
    waitFor(options?: AgentLocatorWaitOptions): Promise<void>;
    elementHandle(options?: OperationOptions): Promise<ElementHandle>;
    click(options?: AgentLocatorClickOptions): Promise<LocatorResult>;
    doubleClick(options?: AgentLocatorActionOptions): Promise<LocatorResult>;
    hover(options?: AgentLocatorActionOptions): Promise<LocatorResult>;
    wheel(deltaX: number, deltaY: number, options?: AgentLocatorActionOptions): Promise<LocatorResult>;
    focus(options?: AgentLocatorActionOptions): Promise<LocatorResult>;
    scrollIntoView(options?: AgentLocatorActionOptions): Promise<LocatorResult>;
    fill(value: string, options?: AgentLocatorActionOptions): Promise<LocatorResult<TextInputActionData>>;
    type(text: string, options?: AgentLocatorTypeOptions): Promise<LocatorResult<TextInputActionData>>;
    fillAndSelectSuggestion(query: string, suggestionText: string, options?: AgentSuggestionCommitOptions): Promise<SuggestionCommitResult>;
    press(key: string, options?: AgentLocatorActionOptions): Promise<LocatorResult>;
    check(options?: AgentLocatorActionOptions): Promise<LocatorResult>;
    uncheck(options?: AgentLocatorActionOptions): Promise<LocatorResult>;
    clear(options?: AgentLocatorActionOptions): Promise<LocatorResult>;
    selectOption(values: string | string[], options?: AgentLocatorActionOptions): Promise<LocatorResult>;
    setFiles(files: string | string[], options?: AgentLocatorActionOptions): Promise<LocatorResult>;
    dragTo(target: AgentLocator, options?: AgentLocatorActionOptions): Promise<LocatorResult>;
    textContent(options?: OperationOptions): Promise<string>;
    innerText(options?: OperationOptions): Promise<string>;
    domInvoke<T = unknown>(method: string, args?: unknown[], options?: AgentLocatorActionOptions): Promise<LocatorResult<{
        value?: T;
    }>>;
    screenshot(options?: OperationOptions): Promise<Screenshot>;
    getAttribute(name: string, options?: OperationOptions): Promise<string | null>;
    boundingBox(options?: OperationOptions): ReturnType<Locator["boundingBox"]>;
    isVisible(options?: OperationOptions): Promise<boolean>;
    isEnabled(options?: OperationOptions): Promise<boolean>;
    isChecked(options?: OperationOptions): Promise<boolean>;
    inputValue(options?: OperationOptions): Promise<string>;
    inspect(options?: ElementInspectionOptions): Promise<ElementInspection>;
}
type AgentLocatorFactory = "locator" | "getByRole" | "getByText" | "getByLabel" | "getByPlaceholder" | "getByAltText" | "getByTitle" | "getByTestId";
export type AgentTab = Omit<Tab, "ax" | "cua" | AgentLocatorFactory> & {
    readonly ax: AgentAX;
    readonly cua: AgentCUA;
    locator(selector: string): AgentLocator;
    getByRole(role: string, options?: {
        name?: string;
        exact?: boolean;
    }): AgentLocator;
    getByText(text: string, options?: {
        exact?: boolean;
    }): AgentLocator;
    getByLabel(label: string, options?: {
        exact?: boolean;
    }): AgentLocator;
    getByPlaceholder(placeholder: string, options?: {
        exact?: boolean;
    }): AgentLocator;
    getByAltText(text: string, options?: {
        exact?: boolean;
    }): AgentLocator;
    getByTitle(title: string, options?: {
        exact?: boolean;
    }): AgentLocator;
    getByTestId(testId: string): AgentLocator;
};
/** Agent-wrapped tab discovery. Every tab keeps its own presentation baseline. */
export declare class AgentTabs {
    #private;
    constructor(core: Browser, presenter: AgentPresenter, documentation: AgentDocumentationRegistry);
    list(options?: OperationOptions): Promise<AgentTab[]>;
    get(targetId: string, options?: OperationOptions): Promise<AgentTab>;
    open(url?: string, options?: NavigateOptions): Promise<AgentTab>;
    dispose(): Promise<void>;
}
export declare class AgentBrowser {
    #private;
    readonly identity: BrowserIdentity;
    readonly tabs: AgentTabs;
    readonly diagnostics: Diagnostics;
    constructor(core: Browser, presenter: AgentPresenter, onDisconnect: () => void);
    get connected(): boolean;
    documentation(topic?: AgentDocumentationTopic): Promise<string>;
    disconnect(): Promise<void>;
}
/** Connects the Codex-style Agent facade to the same Core SDK and Rust runtime. */
export declare function connect(options?: AgentConnectOptions): Promise<AgentBrowser>;
export {};
//# sourceMappingURL=index.d.ts.map