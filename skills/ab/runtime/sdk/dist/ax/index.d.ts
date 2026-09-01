import { inspect } from "node:util";
import { Screenshot } from "../artifacts/index.js";
import { ElementHandle, type ElementInspection, type ElementInspectionOptions } from "../elements/index.js";
import type { ProtocolClient } from "../transport/index.js";
import type { OperationOptions } from "../options.js";
import type { ActionResult, TextInputActionData } from "../actions/result.js";
export type { ActionResult } from "../actions/result.js";
export type Bounds = {
    x: number;
    y: number;
    width: number;
    height: number;
};
export type ObservationRef = {
    id: string;
    role: string;
    name: string;
    frameId: string;
    documentGeneration: string;
    backendNodeId: number | null;
    bounds: Bounds | null;
};
export type ObservationDiff = {
    fromObservationId: string;
    documentReplaced: boolean;
    text: string;
    additions: number;
    removals: number;
    addedRefs: string[];
    removedRefs: string[];
    changedRefs: string[];
};
export type ObservationSources = {
    ax: boolean;
    dom: boolean;
    layout: boolean;
    piercedDom: boolean;
    sessionCount: number;
    shadowRootCount: number;
    backendNodeCount: number;
    refsCovered: boolean;
    frameCount: number;
    capturedFrameCount: number;
    gaps: ObservationGap[];
    surface: "active" | "document";
};
export type ObservationGap = {
    frameId: string | null;
    sessionId: string | null;
    source: string;
    reason: string;
};
export type SnapshotOptions = OperationOptions & {
    mode?: "interactive" | "full";
    surface?: "active" | "document";
    frames?: "all" | {
        root: string;
    };
    maxDepth?: number;
    maxChars?: number;
    diffFrom?: AXState | string;
    includeUrls?: boolean;
};
export type ObservationWire = {
    id: string;
    targetId: string;
    frameId: string;
    documentGeneration: string;
    revision: number;
    text: string;
    refs: ObservationRef[];
    complete: boolean;
    truncated: boolean;
    nodeCount: number;
    sources: ObservationSources;
    diff: ObservationDiff | null;
};
export type RefActionOptions = OperationOptions & import("../actions/result.js").ActionOptions;
export type ClickOptions = RefActionOptions & {
    button?: "left" | "middle" | "right";
    clickCount?: number;
};
export type TypeOptions = RefActionOptions & {
    clear?: boolean;
    delayMs?: number;
};
/** An actionable node identity owned by one explicit AXState. */
export declare class AXRef {
    #private;
    readonly observationId: string;
    readonly id: string;
    readonly role: string;
    readonly name: string;
    readonly frameId: string;
    readonly documentGeneration: string;
    readonly backendNodeId: number | null;
    readonly bounds: Bounds | null;
    constructor(client: ProtocolClient, targetId: string, observationId: string, value: ObservationRef);
    click(options?: ClickOptions): Promise<ActionResult>;
    doubleClick(options?: RefActionOptions): Promise<ActionResult>;
    hover(options?: RefActionOptions): Promise<ActionResult>;
    wheel(deltaX: number, deltaY: number, options?: RefActionOptions): Promise<ActionResult>;
    fill(value: string, options?: RefActionOptions): Promise<ActionResult<TextInputActionData>>;
    type(text: string, options?: TypeOptions): Promise<ActionResult<TextInputActionData>>;
    press(key: string, options?: RefActionOptions): Promise<ActionResult>;
    focus(options?: RefActionOptions): Promise<ActionResult>;
    clear(options?: RefActionOptions): Promise<ActionResult>;
    scrollIntoView(options?: RefActionOptions): Promise<ActionResult>;
    check(options?: RefActionOptions): Promise<ActionResult>;
    uncheck(options?: RefActionOptions): Promise<ActionResult>;
    selectOption(values: string | string[], options?: RefActionOptions): Promise<ActionResult>;
    setFiles(files: string | string[], options?: RefActionOptions): Promise<ActionResult>;
    dragTo(target: AXRef, options?: RefActionOptions): Promise<ActionResult>;
    textContent(options?: OperationOptions): Promise<string>;
    innerText(options?: OperationOptions): Promise<string>;
    getAttribute(name: string, options?: OperationOptions): Promise<string | null>;
    boundingBox(options?: OperationOptions): Promise<Bounds | null>;
    isVisible(options?: OperationOptions): Promise<boolean>;
    isEnabled(options?: OperationOptions): Promise<boolean>;
    isChecked(options?: OperationOptions): Promise<boolean>;
    inputValue(options?: OperationOptions): Promise<string>;
    inspect(options?: ElementInspectionOptions): Promise<ElementInspection>;
    domInvoke<T = unknown>(method: string, args?: unknown[], options?: RefActionOptions): Promise<ActionResult<{
        value?: T;
    }>>;
    screenshot(options?: OperationOptions): Promise<Screenshot>;
    /** Retains this exact backend node as a server-owned ElementHandle. */
    elementHandle(options?: OperationOptions): Promise<ElementHandle>;
    [inspect.custom](): string;
}
/**
 * Immutable AX observation text, refs, identity, completeness, and optional diff.
 * Agent-visible rendering belongs to @hanger-source/ab/agent's Presenter.
 */
export declare class AXState {
    #private;
    readonly id: string;
    readonly targetId: string;
    readonly frameId: string;
    readonly documentGeneration: string;
    readonly revision: number;
    readonly text: string;
    readonly complete: boolean;
    readonly truncated: boolean;
    readonly nodeCount: number;
    readonly sources: ObservationSources;
    readonly diff: ObservationDiff | null;
    constructor(client: ProtocolClient, value: ObservationWire);
    /** Returns a ref from this observation; accepts `e7` or `@e7`. */
    ref(id: string): AXRef;
    /** Returns the refs created by this observation. */
    refs(): readonly AXRef[];
    /** Releases the server observation record. Existing refs become unusable. */
    dispose(options?: OperationOptions): Promise<void>;
    [inspect.custom](): string;
}
/** Explicit accessibility capture surface for one tab. */
export declare class AX {
    #private;
    constructor(client: ProtocolClient, tabId: string);
    /** Captures a new AXState and establishes its ref identities. */
    snapshot(options?: SnapshotOptions): Promise<AXState>;
}
//# sourceMappingURL=index.d.ts.map