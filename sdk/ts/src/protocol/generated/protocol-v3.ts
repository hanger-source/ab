// Generated from server/rust/ab-protocol. Do not edit.
export const PROTOCOL_VERSION = 3 as const;
export const SDK_VERSION = "0.3.0-alpha.3" as const;
export const BUILD_ID = "ab-runtime@0.3.0-alpha.3+da1253dac2f83a06" as const;

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type RequestTarget = { tabId?: string | null, frameId?: string | null, documentGeneration?: string | null, observationId?: string | null, resourceId?: string | null, elementId?: string | null, artifactId?: string | null, };

export type ErrorContext = { requestId?: string | null, traceId?: string | null, method?: string | null, target?: RequestTarget | null, cdpMethod?: string | null, cause?: string | null, };

export type ErrorData = { kind: string, stage: string, message: string, retryable: boolean, context?: ErrorContext | null, details?: JsonValue, };

export type TraceContext = { traceId: string, };

export type ClientHello = { protocolVersion: number, sdkVersion: string, buildId: string, };

export type ChromeSource = "launched" | "reattached";

export type ChromeIdentity = { source: ChromeSource, pid: number | null, };

export type ClientReady = { protocolVersion: number, sdkVersion: string, buildId: string, clientId: string, daemonId: string, browserGeneration: string, chrome: ChromeIdentity, };

export type Request = { id: string, method: string, trace: TraceContext, target?: RequestTarget | null, params: JsonValue, deadlineUnixMs: number, };

export type Cancel = { id: string, requestId: string, };

export type LocatorQuery = { "kind": "css", value: string, } | { "kind": "role", role: string, name?: string | null, exact: boolean, } | { "kind": "text", value: string, exact: boolean, } | { "kind": "label", value: string, exact: boolean, } | { "kind": "placeholder", value: string, exact: boolean, } | { "kind": "altText", value: string, exact: boolean, } | { "kind": "title", value: string, exact: boolean, } | { "kind": "testId", value: string, exact: boolean, } | { "kind": "and", left: LocatorQuery, right: LocatorQuery, } | { "kind": "or", left: LocatorQuery, right: LocatorQuery, } | { "kind": "descendant", ancestor: LocatorQuery, descendant: LocatorQuery, } | { "kind": "has", query: LocatorQuery, descendant: LocatorQuery, } | { "kind": "hasText", query: LocatorQuery, value: string, exact: boolean, } | { "kind": "frame", frameId: string, query: LocatorQuery, };

export type LocatorRequest = { query: LocatorQuery, index?: bigint, visible?: boolean, operation: string, arguments: JsonValue, };

export type ElementInspectionRequest = { attributes?: Array<string>, };

export type ElementBounds = { x: number, y: number, width: number, height: number, };

export type ElementInspection = { tagName: string, roleAttribute: string | null, inputType: string | null, attributes: { [key in string]: string | null }, textContent: string, innerText: string, value: string | null, visible: boolean, enabled: boolean, checked: boolean | null, readOnly: boolean, contentEditable: boolean, bounds: ElementBounds, };

export type ResponseOutcome = { "status": "success", result: JsonValue, } | { "status": "error", error: ErrorData, };

export type Response = { id: string, outcome: ResponseOutcome, };

export type Stage = { requestId: string, traceId: string, method: string, name: string, sequence: number, timestampUnixMs: number, target?: RequestTarget | null, detail?: JsonValue, };

export type ResourceEvent = { resourceId: string, sequence: number, event: string, value: JsonValue, complete: boolean, };

export type ResourceClosed = { resourceId: string, reason: string, lastSequence: number, complete: boolean, closedAtUnixMs: number, };

export type DaemonEvent = { event: string, value: JsonValue, };

export type ClientClosed = { reason: string, };

export type ClientMessage = { "type": "client.hello" } & ClientHello | { "type": "request" } & Request | { "type": "cancel" } & Cancel;

export type DaemonMessage = { "type": "client.ready" } & ClientReady | { "type": "client.rejected", error: ErrorData, } | { "type": "response" } & Response | { "type": "stage" } & Stage | { "type": "resource.event" } & ResourceEvent | { "type": "resource.closed" } & ResourceClosed | { "type": "daemon.event" } & DaemonEvent | { "type": "client.closed" } & ClientClosed;
