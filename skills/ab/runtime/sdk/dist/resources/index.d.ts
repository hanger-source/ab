import { inspect } from "node:util";
import { Artifact, type ArtifactDescriptor } from "../artifacts/index.js";
import type { OperationOptions } from "../options.js";
import type { JsonValue } from "../protocol.js";
import type { ProtocolClient } from "../transport/index.js";
export type ResourceDescriptor = {
    id: string;
    kind: ResourceKind;
    ownerId: string;
    scope: ResourceScope;
    state: ResourceLifecycleState;
    createdAtUnixMs: number;
    sequence: number;
    complete: boolean;
    closeReason: string | null;
};
export type ResourceScope = {
    type: "target";
    targetId: string;
};
export type ResourceLifecycleState = "open" | "closed";
export type ResourceKind = "cdp" | "network" | "console" | "dialog" | "download" | "fileChooser" | "initScript";
export type InitScriptWorld = "main" | "isolated";
export type InitScriptFrames = "all" | "top";
export type InitScriptDefinition = {
    name: string;
    source: string;
    world?: InitScriptWorld;
    frames?: InitScriptFrames;
    args?: JsonValue[];
};
export type InitScriptInstance = {
    id: string;
    frameId: string;
    documentGeneration: string;
    sessionId: string;
    executionContextId: number;
    state: "starting" | "ready" | "error" | "disposed";
    error: string | null;
};
export type NetworkObserverOptions = OperationOptions & {
    /** Total response bytes retained across the observer lifetime. */
    bodyRetentionBytes?: number;
    /** Maximum bytes kept inline in daemon memory before bodies spill to artifacts. */
    bodyMemoryBytes?: number;
    maxBodyBytes?: number;
    /** Chrome's temporary response-data buffer, separate from AB retention. */
    cdpBufferBytes?: number;
    /** Force every retained body to a private artifact, or spill automatically. */
    bodyStorage?: "auto" | "artifact";
    /** Capture every response body or only documents, XHR/fetch, text, and JSON. */
    bodyCapture?: "all" | "text";
};
export type NetworkBody = {
    body: string | null;
    base64Encoded: boolean;
    bytes: number;
    artifact: Artifact | null;
};
export type NetworkBodyOptions = OperationOptions & {
    sessionId?: string;
};
export type BrowserEvent<T = Record<string, unknown>> = {
    sequence: number;
    method: string;
    params: T;
    sessionId: string | null;
    complete: boolean;
    artifact: ArtifactDescriptor | null;
};
export type DialogInfo = {
    id: string;
    rootTargetId: string;
    sessionId: string;
    type: "alert" | "confirm" | "prompt" | "beforeunload" | string;
    message: string;
    url: string;
    defaultPrompt: string;
    hasBrowserHandler: boolean;
};
export type ResourceState = {
    state: ResourceLifecycleState;
    createdAtUnixMs: number;
    sequence: number;
    complete: boolean;
    closeReason: string | null;
    closedAtUnixMs: number | null;
    bufferedFrom: number;
    gap: boolean;
};
export type DownloadState = "inProgress" | "completed" | "canceled" | "interrupted" | string;
export type DownloadInfo = {
    guid: string;
    targetId: string;
    frameId: string;
    url: string;
    suggestedFilename: string;
    path: string | null;
    receivedBytes: number;
    totalBytes: number;
    state: DownloadState;
    reason: string | null;
    artifact: Artifact | null;
    createdAtUnixMs: number;
    updatedAtUnixMs: number;
};
declare const resourceClient: unique symbol;
/**
 * Client-owned view of a server-buffered browser event resource.
 * Dispose it deterministically and check completeness before relying on history.
 */
export declare class Resource {
    #private;
    readonly id: string;
    readonly kind: ResourceKind;
    readonly ownerId: string;
    readonly scope: ResourceScope;
    readonly targetId: string;
    readonly createdAtUnixMs: number;
    readonly [resourceClient]: ProtocolClient;
    constructor(client: ProtocolClient, descriptor: ResourceDescriptor);
    get state(): ResourceLifecycleState;
    get complete(): boolean;
    get closed(): boolean;
    get closeReason(): string | null;
    get closedAtUnixMs(): number | null;
    get sequence(): number;
    get events(): readonly BrowserEvent[];
    onEvent(listener: (event: BrowserEvent) => void): () => void;
    /** Waits for a matching buffered or future event without consuming history. */
    waitFor(predicate: (event: BrowserEvent) => boolean, options?: OperationOptions): Promise<BrowserEvent>;
    command<T = unknown>(command: string, params?: Record<string, unknown>, options?: OperationOptions): Promise<T>;
    assertComplete(options?: OperationOptions): Promise<void>;
    /** Synchronizes this consumer with the Rust-owned event buffer and returns its exact cursor. */
    refresh(options?: OperationOptions): Promise<ResourceState>;
    dispose(options?: OperationOptions): Promise<void>;
    [inspect.custom](): string;
}
export declare class NetworkObserver extends Resource {
    waitForRequest(predicate?: (event: BrowserEvent) => boolean, options?: OperationOptions): Promise<BrowserEvent>;
    waitForResponse(predicate?: (event: BrowserEvent) => boolean, options?: OperationOptions): Promise<BrowserEvent>;
    responseBody(eventOrRequestId: BrowserEvent | string, options?: NetworkBodyOptions): Promise<NetworkBody>;
}
export declare class ConsoleObserver extends Resource {
    waitForMessage(predicate?: (event: BrowserEvent) => boolean, options?: OperationOptions): Promise<BrowserEvent>;
}
export declare class DialogWatcher extends Resource {
    #private;
    waitForDialog(options?: OperationOptions): Promise<Dialog>;
}
export declare class Dialog {
    #private;
    readonly id: string;
    readonly rootTargetId: string;
    readonly sessionId: string;
    readonly type: DialogInfo["type"];
    readonly message: string;
    readonly url: string;
    readonly defaultPrompt: string;
    readonly hasBrowserHandler: boolean;
    constructor(watcher: DialogWatcher, info: DialogInfo);
    get closed(): boolean;
    get accepted(): boolean | null;
    get userInput(): string | null;
    get closeReason(): string | null;
    accept(promptText?: string, options?: OperationOptions): Promise<unknown>;
    dismiss(options?: OperationOptions): Promise<unknown>;
    [inspect.custom](): string;
}
export declare class DownloadWatcher extends Resource {
    #private;
    waitForDownload(options?: OperationOptions): Promise<Download>;
    downloads(options?: OperationOptions): Promise<Download[]>;
}
export declare class Download {
    #private;
    readonly guid: string;
    readonly targetId: string;
    readonly frameId: string;
    readonly url: string;
    readonly suggestedFilename: string;
    readonly createdAtUnixMs: number;
    constructor(watcher: DownloadWatcher, info: DownloadInfo);
    get path(): string | null;
    get receivedBytes(): number;
    get totalBytes(): number;
    get state(): DownloadState;
    get reason(): string | null;
    get artifact(): Artifact | null;
    get updatedAtUnixMs(): number;
    get finished(): boolean;
    refresh(options?: OperationOptions): Promise<this>;
    waitForFinished(options?: OperationOptions): Promise<this>;
    waitForCompleted(options?: OperationOptions): Promise<this>;
    [inspect.custom](): string;
}
export declare class FileChooserWatcher extends Resource {
    waitForChooser(options?: OperationOptions): Promise<BrowserEvent>;
}
export declare class InitScriptRegistration extends Resource {
    instances(options?: OperationOptions): Promise<InitScriptInstance[]>;
    waitForInstance(predicate?: (instance: InitScriptInstance) => boolean, options?: OperationOptions): Promise<InitScriptInstance>;
    send<T = JsonValue>(instance: InitScriptInstance | string, name: string, value?: JsonValue, options?: OperationOptions): Promise<T>;
}
export {};
//# sourceMappingURL=index.d.ts.map