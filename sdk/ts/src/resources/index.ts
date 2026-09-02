import { inspect } from "node:util";
import { Artifact, type ArtifactDescriptor } from "../artifacts/index.js";
import { ABError } from "../errors/index.js";
import type { OperationOptions } from "../options.js";
import type { JsonValue } from "../protocol.js";
import type { ProtocolClient, ResourceMessage } from "../transport/index.js";

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

export type ResourceKind =
  | "cdp"
  | "network"
  | "console"
  | "dialog"
  | "popup"
  | "download"
  | "fileChooser"
  | "initScript";

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

type NetworkBodyWire = Omit<NetworkBody, "artifact"> & {
  artifact: ArtifactDescriptor | null;
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

export type PopupInfo = {
  targetId: string;
  openerId: string;
  url: string;
  title: string;
  type: string;
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

type ResourceStateWire = ResourceState & {
  events: Array<{
    resourceId: string;
    sequence: number;
    event: string;
    value: JsonValue;
    complete: boolean;
  }>;
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

type Waiter = {
  predicate(event: BrowserEvent): boolean;
  resolve(event: BrowserEvent): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  onAbort?: () => void;
};

const resourceClient = Symbol("ab.resource.client");

/**
 * Client-owned view of a server-buffered browser event resource.
 * Dispose it deterministically and check completeness before relying on history.
 */
export class Resource {
  readonly id: string;
  readonly kind: ResourceKind;
  readonly ownerId: string;
  readonly scope: ResourceScope;
  readonly targetId: string;
  readonly createdAtUnixMs: number;
  readonly [resourceClient]: ProtocolClient;
  readonly #history: BrowserEvent[] = [];
  readonly #listeners = new Set<(event: BrowserEvent) => void>();
  readonly #waiters = new Set<Waiter>();
  readonly #unsubscribe: () => void;
  #complete: boolean;
  #state: ResourceLifecycleState;
  #closeReason: string | null;
  #closedAtUnixMs: number | null = null;
  #lastSequence: number;

  constructor(client: ProtocolClient, descriptor: ResourceDescriptor) {
    this[resourceClient] = client;
    this.id = descriptor.id;
    this.kind = descriptor.kind;
    this.ownerId = descriptor.ownerId;
    this.scope = descriptor.scope;
    this.targetId = descriptor.scope.targetId;
    this.createdAtUnixMs = descriptor.createdAtUnixMs;
    this.#complete = descriptor.complete;
    this.#state = descriptor.state;
    this.#closeReason = descriptor.closeReason;
    this.#lastSequence = descriptor.sequence;
    this.#unsubscribe = client.subscribeResource(this.id, (message) => this.#accept(message));
  }

  get state(): ResourceLifecycleState {
    return this.#state;
  }

  get complete(): boolean {
    return this.#complete;
  }

  get closed(): boolean {
    return this.#state === "closed";
  }

  get closeReason(): string | null {
    return this.#closeReason;
  }

  get closedAtUnixMs(): number | null {
    return this.#closedAtUnixMs;
  }

  get sequence(): number {
    return this.#lastSequence;
  }

  get events(): readonly BrowserEvent[] {
    return this.#history;
  }

  onEvent(listener: (event: BrowserEvent) => void): () => void {
    this.#assertOpen();
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Waits for a matching buffered or future event without consuming history. */
  async waitFor(
    predicate: (event: BrowserEvent) => boolean,
    options: OperationOptions = {},
  ): Promise<BrowserEvent> {
    this.#assertOpen();
    await this.refresh(options);
    const existing = this.#history.find(predicate);
    if (existing) {
      return existing;
    }
    const timeoutMs = options.timeoutMs ?? 30_000;
    if (options.signal?.aborted) {
      throw cancelledError(this.id);
    }
    return new Promise<BrowserEvent>((resolve, reject) => {
      const waiter = {} as Waiter;
      const finish = (fn: () => void) => {
        this.#waiters.delete(waiter);
        clearTimeout(waiter.timer);
        if (waiter.signal && waiter.onAbort) {
          waiter.signal.removeEventListener("abort", waiter.onAbort);
        }
        fn();
      };
      waiter.predicate = predicate;
      waiter.resolve = (event) => finish(() => resolve(event));
      waiter.reject = (error) => finish(() => reject(error));
      waiter.timer = setTimeout(() => waiter.reject(new ABError({
        kind: "timeout",
        stage: "sdk.resource.wait",
        message: `resource ${this.id} did not produce a matching event within ${timeoutMs}ms`,
      })), timeoutMs);
      if (options.signal) {
        waiter.signal = options.signal;
        waiter.onAbort = () => waiter.reject(cancelledError(this.id));
        options.signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.#waiters.add(waiter);
    });
  }

  command<T = unknown>(
    command: string,
    params: Record<string, unknown> = {},
    options: OperationOptions = {},
  ): Promise<T> {
    this.#assertOpen();
    return this[resourceClient].request<T>(
      "resource.command",
      { command, params },
      { target: { resourceId: this.id }, ...options },
    );
  }

  async assertComplete(options: OperationOptions = {}): Promise<void> {
    await this.command("assertComplete", {}, options);
  }

  /** Synchronizes this consumer with the Rust-owned event buffer and returns its exact cursor. */
  async refresh(options: OperationOptions = {}): Promise<ResourceState> {
    const state = await this.command<ResourceStateWire>(
      "state",
      { afterSequence: this.#lastSequence },
      options,
    );
    this.#state = state.state;
    this.#closeReason = state.closeReason;
    this.#closedAtUnixMs = state.closedAtUnixMs;
    if (state.gap) {
      this.#complete = false;
    }
    for (const event of state.events) {
      this.#accept({ type: "resource.event", ...event });
    }
    this.#complete &&= state.complete;
    return {
      state: state.state,
      createdAtUnixMs: state.createdAtUnixMs,
      sequence: state.sequence,
      complete: state.complete,
      closeReason: state.closeReason,
      closedAtUnixMs: state.closedAtUnixMs,
      bufferedFrom: state.bufferedFrom,
      gap: state.gap,
    };
  }

  async dispose(options: OperationOptions = {}): Promise<void> {
    if (this.closed) {
      return;
    }
    await this[resourceClient].request(
      "resource.dispose",
      {},
      { target: { resourceId: this.id }, ...options },
    );
    this.#close("disposed", this.#complete, Date.now());
  }

  [inspect.custom](): string {
    return `Resource { id: '${this.id}', kind: '${this.kind}', state: '${this.#state}', sequence: ${this.#lastSequence}, complete: ${this.#complete} }`;
  }

  #accept(message: ResourceMessage): void {
    if (message.type === "resource.closed") {
      this.#close(message.reason, message.complete, message.closedAtUnixMs);
      return;
    }
    if (message.sequence <= this.#lastSequence) {
      return;
    }
    if (message.sequence !== this.#lastSequence + 1) {
      this.#complete = false;
    }
    this.#lastSequence = message.sequence;
    const value = message.value;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      this.#close("invalid_event_payload", false, Date.now());
      return;
    }
    const raw = value as Record<string, unknown>;
    const event: BrowserEvent = {
      sequence: message.sequence,
      method: typeof raw.method === "string" ? raw.method : message.event,
      params: raw.params && typeof raw.params === "object" && !Array.isArray(raw.params)
        ? raw.params as Record<string, unknown>
        : {},
      sessionId: typeof raw.sessionId === "string" ? raw.sessionId : null,
      complete: message.complete,
      artifact: parseArtifactDescriptor(raw.artifact),
    };
    this.#complete &&= message.complete;
    this.#history.push(event);
    if (this.#history.length > 512) {
      this.#history.shift();
    }
    for (const listener of this.#listeners) {
      listener(event);
    }
    for (const waiter of [...this.#waiters]) {
      if (waiter.predicate(event)) {
        waiter.resolve(event);
      }
    }
  }

  #close(reason: string, complete: boolean, closedAtUnixMs: number): void {
    if (this.closed) {
      return;
    }
    this.#state = "closed";
    this.#closeReason = reason;
    this.#closedAtUnixMs = closedAtUnixMs;
    this.#complete &&= complete;
    this.#unsubscribe();
    const error = new ABError({
      kind: "resource_closed",
      stage: "sdk.resource",
      message: `resource ${this.id} closed: ${reason}`,
      details: { complete: this.#complete },
    });
    for (const waiter of [...this.#waiters]) {
      waiter.reject(error);
    }
    this.#listeners.clear();
  }

  #assertOpen(): void {
    if (this.closed) {
      throw new ABError({
        kind: "resource_closed",
        stage: "sdk.resource",
        message: `resource ${this.id} is closed: ${this.#closeReason ?? "unknown"}`,
      });
    }
  }
}

export class NetworkObserver extends Resource {
  waitForRequest(
    predicate: (event: BrowserEvent) => boolean = () => true,
    options: OperationOptions = {},
  ): Promise<BrowserEvent> {
    return this.waitFor(
      (event) => event.method === "Network.requestWillBeSent" && predicate(event),
      options,
    );
  }

  waitForResponse(
    predicate: (event: BrowserEvent) => boolean = () => true,
    options: OperationOptions = {},
  ): Promise<BrowserEvent> {
    return this.waitFor(
      (event) => event.method === "Network.responseReceived" && predicate(event),
      options,
    );
  }

  async responseBody(
    eventOrRequestId: BrowserEvent | string,
    options: NetworkBodyOptions = {},
  ): Promise<NetworkBody> {
    const requestId = typeof eventOrRequestId === "string"
      ? eventOrRequestId
      : String(eventOrRequestId.params.requestId ?? "");
    if (!requestId) {
      throw new TypeError("responseBody requires a Network event with params.requestId");
    }
    const sessionId = typeof eventOrRequestId === "string"
      ? options.sessionId
      : eventOrRequestId.sessionId;
    if (!sessionId) {
      throw new TypeError("responseBody requires the Network event sessionId");
    }
    const timeoutMs = options.timeoutMs ?? 30_000;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (options.signal?.aborted) throw cancelledError(this.id);
      try {
        const value = await this.command<NetworkBodyWire>(
          "responseBody",
          { requestId, sessionId },
          {
            timeoutMs: Math.max(1, deadline - Date.now()),
            ...(options.signal === undefined ? {} : { signal: options.signal }),
          },
        );
        return {
          ...value,
          artifact: value.artifact ? new Artifact(this[resourceClient], value.artifact) : null,
        };
      } catch (error) {
        if (!(error instanceof ABError) || error.kind !== "network_body_pending") throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))));
    }
    throw new ABError({
      kind: "timeout",
      stage: "sdk.resource.response_body",
      message: `response body ${sessionId}:${requestId} did not reach a terminal Rust-owned state within ${timeoutMs}ms`,
    });
  }
}

export class ConsoleObserver extends Resource {
  waitForMessage(
    predicate: (event: BrowserEvent) => boolean = () => true,
    options: OperationOptions = {},
  ): Promise<BrowserEvent> {
    return this.waitFor(
      (event) => (event.method === "Runtime.consoleAPICalled" || event.method === "Log.entryAdded") && predicate(event),
      options,
    );
  }
}

export class DialogWatcher extends Resource {
  #lastOpenedSequence = 0;

  async waitForDialog(options: OperationOptions = {}): Promise<Dialog> {
    const event = await this.waitFor(
      (candidate) => candidate.method === "Page.javascriptDialogOpening"
        && candidate.sequence > this.#lastOpenedSequence,
      options,
    );
    this.#lastOpenedSequence = event.sequence;
    return new Dialog(this, parseDialogInfo(event.params));
  }
}

export class PopupWatcher extends Resource {
  #lastCreatedSequence = 0;

  async waitForPopup(options: OperationOptions = {}): Promise<PopupInfo> {
    const event = await this.waitFor(
      (candidate) => candidate.method === "Target.targetCreated"
        && candidate.sequence > this.#lastCreatedSequence,
      options,
    );
    this.#lastCreatedSequence = event.sequence;
    const { targetId, openerId, url, title, type } = event.params;
    if (
      typeof targetId !== "string"
      || typeof openerId !== "string"
      || typeof url !== "string"
      || typeof title !== "string"
      || typeof type !== "string"
    ) {
      throw new ABError({
        kind: "invalid_resource_event",
        stage: "sdk.resource.popup",
        message: `popup resource ${this.id} returned an invalid target identity`,
      });
    }
    return { targetId, openerId, url, title, type };
  }
}

export class Dialog {
  readonly id: string;
  readonly rootTargetId: string;
  readonly sessionId: string;
  readonly type: DialogInfo["type"];
  readonly message: string;
  readonly url: string;
  readonly defaultPrompt: string;
  readonly hasBrowserHandler: boolean;
  readonly #watcher: DialogWatcher;
  #closed = false;
  #accepted: boolean | null = null;
  #userInput: string | null = null;
  #closeReason: string | null = null;
  #unsubscribe: (() => void) | null;

  constructor(watcher: DialogWatcher, info: DialogInfo) {
    this.#watcher = watcher;
    this.id = info.id;
    this.rootTargetId = info.rootTargetId;
    this.sessionId = info.sessionId;
    this.type = info.type;
    this.message = info.message;
    this.url = info.url;
    this.defaultPrompt = info.defaultPrompt;
    this.hasBrowserHandler = info.hasBrowserHandler;
    this.#unsubscribe = watcher.onEvent((event) => {
      if (
        event.method === "Page.javascriptDialogClosed"
        && event.params.dialogId === this.id
      ) {
        this.#accepted = typeof event.params.result === "boolean" ? event.params.result : null;
        this.#userInput = typeof event.params.userInput === "string" ? event.params.userInput : null;
        this.#closeReason = typeof event.params.reason === "string" ? event.params.reason : null;
        this.#markClosed();
      }
    });
  }

  get closed(): boolean {
    return this.#closed;
  }

  get accepted(): boolean | null {
    return this.#accepted;
  }

  get userInput(): string | null {
    return this.#userInput;
  }

  get closeReason(): string | null {
    return this.#closeReason;
  }

  accept(promptText?: string, options: OperationOptions = {}): Promise<unknown> {
    this.#assertOpen();
    return this.#watcher.command(
      "accept",
      {
        dialogId: this.id,
        sessionId: this.sessionId,
        ...(promptText === undefined ? {} : { promptText }),
      },
      options,
    );
  }

  dismiss(options: OperationOptions = {}): Promise<unknown> {
    this.#assertOpen();
    return this.#watcher.command(
      "dismiss",
      { dialogId: this.id, sessionId: this.sessionId },
      options,
    );
  }

  [inspect.custom](): string {
    return `Dialog { id: '${this.id}', type: '${this.type}', closed: ${this.#closed} }`;
  }

  #markClosed(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#unsubscribe?.();
    this.#unsubscribe = null;
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new ABError({
        kind: "stale_dialog",
        stage: "sdk.dialog.identity",
        message: `dialog ${this.id} is no longer open`,
      });
    }
  }
}

export class DownloadWatcher extends Resource {
  #lastStartedSequence = 0;

  async waitForDownload(options: OperationOptions = {}): Promise<Download> {
    const event = await this.waitFor(
      (candidate) => candidate.method === "download.started"
        && candidate.sequence > this.#lastStartedSequence,
      options,
    );
    this.#lastStartedSequence = event.sequence;
    return new Download(this, parseDownloadInfo(event.params, this[resourceClient]));
  }

  async downloads(options: OperationOptions = {}): Promise<Download[]> {
    const records = await this.command<Record<string, unknown>[]>("downloads", {}, options);
    return records.map((record) => new Download(this, parseDownloadInfo(record, this[resourceClient])));
  }
}

export class Download {
  readonly guid: string;
  readonly targetId: string;
  readonly frameId: string;
  readonly url: string;
  readonly suggestedFilename: string;
  readonly createdAtUnixMs: number;
  readonly #watcher: DownloadWatcher;
  #path: string | null;
  #receivedBytes: number;
  #totalBytes: number;
  #state: DownloadState;
  #reason: string | null;
  #artifact: Artifact | null;
  #updatedAtUnixMs: number;
  #unsubscribe: (() => void) | null;

  constructor(watcher: DownloadWatcher, info: DownloadInfo) {
    this.#watcher = watcher;
    this.guid = info.guid;
    this.targetId = info.targetId;
    this.frameId = info.frameId;
    this.url = info.url;
    this.suggestedFilename = info.suggestedFilename;
    this.createdAtUnixMs = info.createdAtUnixMs;
    this.#path = info.path;
    this.#receivedBytes = info.receivedBytes;
    this.#totalBytes = info.totalBytes;
    this.#state = info.state;
    this.#reason = info.reason;
    this.#artifact = info.artifact;
    this.#updatedAtUnixMs = info.updatedAtUnixMs;
    this.#unsubscribe = watcher.onEvent((event) => {
      if (event.method === "download.updated" && event.params.guid === this.guid) {
        this.#update(parseDownloadInfo(event.params, watcher[resourceClient]));
      }
    });
    if (this.finished) {
      this.#releaseListener();
    }
  }

  get path(): string | null {
    return this.#path;
  }

  get receivedBytes(): number {
    return this.#receivedBytes;
  }

  get totalBytes(): number {
    return this.#totalBytes;
  }

  get state(): DownloadState {
    return this.#state;
  }

  get reason(): string | null {
    return this.#reason;
  }

  get artifact(): Artifact | null {
    return this.#artifact;
  }

  get updatedAtUnixMs(): number {
    return this.#updatedAtUnixMs;
  }

  get finished(): boolean {
    return this.#state !== "inProgress";
  }

  async refresh(options: OperationOptions = {}): Promise<this> {
    const state = await this.#watcher.command<Record<string, unknown>>(
      "downloadState",
      { guid: this.guid },
      options,
    );
    this.#update(parseDownloadInfo(state, this.#watcher[resourceClient]));
    return this;
  }

  async waitForFinished(options: OperationOptions = {}): Promise<this> {
    if (!this.finished) {
      const event = await this.#watcher.waitFor(
        (candidate) => candidate.method === "download.updated"
          && candidate.params.guid === this.guid
          && candidate.params.state !== "inProgress",
        options,
      );
      this.#update(parseDownloadInfo(event.params, this.#watcher[resourceClient]));
    }
    return this;
  }

  async waitForCompleted(options: OperationOptions = {}): Promise<this> {
    await this.waitForFinished(options);
    if (this.#state !== "completed" || !this.#artifact || !this.#path) {
      throw new ABError({
        kind: "download_failed",
        stage: "sdk.download.complete",
        message: `download ${this.guid} ended as ${this.#state}: ${this.#reason ?? "no reason reported"}`,
        details: { guid: this.guid, state: this.#state, reason: this.#reason },
      });
    }
    return this;
  }

  [inspect.custom](): string {
    return `Download { guid: '${this.guid}', state: '${this.#state}', receivedBytes: ${this.#receivedBytes}, totalBytes: ${this.#totalBytes} }`;
  }

  #update(info: DownloadInfo): void {
    if (info.guid !== this.guid) {
      throw new ABError({
        kind: "protocol_error",
        stage: "sdk.download.identity",
        message: `download update for ${info.guid} cannot update ${this.guid}`,
      });
    }
    this.#path = info.path;
    this.#receivedBytes = info.receivedBytes;
    this.#totalBytes = info.totalBytes;
    this.#state = info.state;
    this.#reason = info.reason;
    this.#artifact = info.artifact?.id === this.#artifact?.id ? this.#artifact : info.artifact;
    this.#updatedAtUnixMs = info.updatedAtUnixMs;
    if (this.finished) {
      this.#releaseListener();
    }
  }

  #releaseListener(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
  }
}

export class FileChooserWatcher extends Resource {
  waitForChooser(options: OperationOptions = {}): Promise<BrowserEvent> {
    return this.waitFor((event) => event.method === "Page.fileChooserOpened", options);
  }
}

export class InitScriptRegistration extends Resource {
  instances(options: OperationOptions = {}): Promise<InitScriptInstance[]> {
    return this.command<InitScriptInstance[]>("instances", {}, options);
  }

  async waitForInstance(
    predicate: (instance: InitScriptInstance) => boolean = () => true,
    options: OperationOptions = {},
  ): Promise<InitScriptInstance> {
    const current = (await this.instances(options)).find(
      (instance) => instance.state === "ready" && predicate(instance),
    );
    if (current) {
      return current;
    }
    const event = await this.waitFor(
      (candidate) => {
        if (candidate.method !== "initScript.instanceReady") {
          return false;
        }
        const instance = candidate.params.instance as InitScriptInstance | undefined;
        return instance?.state === "ready" && predicate(instance);
      },
      options,
    );
    return event.params.instance as InitScriptInstance;
  }

  send<T = JsonValue>(
    instance: InitScriptInstance | string,
    name: string,
    value: JsonValue = null,
    options: OperationOptions = {},
  ): Promise<T> {
    return this.command<T>(
      "command",
      {
        instanceId: typeof instance === "string" ? instance : instance.id,
        name,
        value,
      },
      options,
    );
  }
}

function cancelledError(resourceId: string): ABError {
  return new ABError({
    kind: "cancelled",
    stage: "sdk.resource.wait",
    message: `waiting on resource ${resourceId} was cancelled`,
  });
}

function parseArtifactDescriptor(value: unknown): ArtifactDescriptor | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const artifact = value as Record<string, unknown>;
  if (
    typeof artifact.id !== "string"
    || typeof artifact.path !== "string"
    || typeof artifact.sha256 !== "string"
    || typeof artifact.bytes !== "number"
    || typeof artifact.mediaType !== "string"
    || typeof artifact.encoding !== "string"
    || typeof artifact.createdAtUnixMs !== "number"
    || typeof artifact.expiresAtUnixMs !== "number"
  ) {
    return null;
  }
  return {
    id: artifact.id,
    path: artifact.path,
    sha256: artifact.sha256,
    bytes: artifact.bytes,
    mediaType: artifact.mediaType,
    encoding: artifact.encoding,
    createdAtUnixMs: artifact.createdAtUnixMs,
    expiresAtUnixMs: artifact.expiresAtUnixMs,
  };
}

function parseDownloadInfo(value: Record<string, unknown>, client: ProtocolClient): DownloadInfo {
  const requiredString = (field: string): string => {
    const entry = value[field];
    if (typeof entry !== "string") {
      throw downloadProtocolError(field);
    }
    return entry;
  };
  const requiredNumber = (field: string): number => {
    const entry = value[field];
    if (typeof entry !== "number" || !Number.isFinite(entry) || entry < 0) {
      throw downloadProtocolError(field);
    }
    return entry;
  };
  return {
    guid: requiredString("guid"),
    targetId: requiredString("targetId"),
    frameId: requiredString("frameId"),
    url: requiredString("url"),
    suggestedFilename: requiredString("suggestedFilename"),
    path: value.path === null ? null : requiredString("path"),
    receivedBytes: requiredNumber("receivedBytes"),
    totalBytes: requiredNumber("totalBytes"),
    state: requiredString("state"),
    reason: value.reason === null ? null : requiredString("reason"),
    artifact: value.artifact === null ? null : new Artifact(client, requiredDownloadArtifact(value.artifact)),
    createdAtUnixMs: requiredNumber("createdAtUnixMs"),
    updatedAtUnixMs: requiredNumber("updatedAtUnixMs"),
  };
}

function requiredDownloadArtifact(value: unknown): ArtifactDescriptor {
  const artifact = parseArtifactDescriptor(value);
  if (!artifact) {
    throw downloadProtocolError("artifact");
  }
  return artifact;
}

function downloadProtocolError(field: string): ABError {
  return new ABError({
    kind: "protocol_error",
    stage: "sdk.download.event",
    message: `download state omitted or invalidated ${field}`,
  });
}

function parseDialogInfo(value: Record<string, unknown>): DialogInfo {
  const required = (field: string): string => {
    const entry = value[field];
    if (typeof entry !== "string") {
      throw new ABError({
        kind: "protocol_error",
        stage: "sdk.dialog.event",
        message: `dialog opening event omitted ${field}`,
      });
    }
    return entry;
  };
  return {
    id: required("id"),
    rootTargetId: required("rootTargetId"),
    sessionId: required("sessionId"),
    type: required("type"),
    message: required("message"),
    url: required("url"),
    defaultPrompt: required("defaultPrompt"),
    hasBrowserHandler: value.hasBrowserHandler === true,
  };
}
