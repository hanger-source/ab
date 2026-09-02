import { Browser } from "./browser/index.js";
export { ABError, type ABErrorData } from "./errors/index.js";
export { Diagnostics, type TraceEvent, type TraceFilter, type TraceSnapshot, } from "./diagnostics/index.js";
export { Artifact, Screenshot, type ArtifactDescriptor, type CssViewport, type ScreenshotScale, type ScreenshotWire, } from "./artifacts/index.js";
export { ElementHandle, type ElementActionOptions, type ElementBounds, type ElementHandleDescriptor, type ElementInspection, type ElementInspectionOptions, type ElementInspectionRequest, } from "./elements/index.js";
export type { OperationOptions } from "./options.js";
export { ConsoleObserver, Dialog, DialogWatcher, Download, DownloadWatcher, FileChooserWatcher, InitScriptRegistration, NetworkObserver, Resource, type BrowserEvent, type DialogInfo, type DownloadInfo, type DownloadState, type NetworkBody, type NetworkBodyOptions, type NetworkObserverOptions, type ResourceState, type InitScriptDefinition, type InitScriptFrames, type InitScriptInstance, type InitScriptWorld, type ResourceDescriptor, type ResourceKind, type ResourceLifecycleState, type ResourceScope, } from "./resources/index.js";
export { CUA, type CuaActionData, type CuaClickOptions, type CuaDragOptions, type CuaPoint, type CuaWheelOptions, } from "./actions/cua.js";
export type { ActionCoordinateIdentity, ActionDialog, ActionOptions, ActionObservationOutcome, ActionObservationOptions, ActionResult, ActionSource, ActionTargetIdentity, ActionTiming, DocumentChange, NavigationChange, TextInputActionData, TextInputFieldOutcome, } from "./actions/result.js";
export { Locator, type LocatorActionOptions, type LocatorClickOptions, type LocatorFilter, type LocatorQuery, type LocatorResult, type SuggestionCommitOptions, type SuggestionCommitResult, } from "./locators/index.js";
export { AX, AXRef, AXState, type Bounds, type ClickOptions, type ObservationDiff, type ObservationGap, type ObservationRef, type ObservationSources, type ObservationSurfaceIdentity, type SnapshotOptions, type TypeOptions, } from "./ax/index.js";
export { Browser, CDPSession, Frame, Realm, Tab, Tabs, type BrowserIdentity, type FrameInfo, type LoadState, type NavigateOptions, type ObserveOptions, type PageObservation, type RealmInfo, type ScreenshotOptions, type TabInfo, } from "./browser/index.js";
/**
 * Connects this JavaScript process to the persistent AB browser runtime.
 *
 * The SDK first connects to the fixed per-user Unix socket. If no daemon is
 * listening, it launches the exact native runtime shipped with this SDK and
 * waits for the same handshake. Repeated calls in one process share a client.
 */
export declare function connect(options?: {
    timeoutMs?: number;
    signal?: AbortSignal;
}): Promise<Browser>;
//# sourceMappingURL=index.d.ts.map