import { inspect } from "node:util";
import { CUA } from "../actions/cua.js";
import type { ActionResult } from "../actions/result.js";
import {
  Screenshot,
  type ScreenshotScale,
  type ScreenshotWire,
} from "../artifacts/index.js";
import { ABError } from "../errors/index.js";
import { Diagnostics } from "../diagnostics/index.js";
import { buildEvaluateScript, deserializeEvaluateResult } from "./evaluate-values.js";
import { Locator, type LocatorQuery } from "../locators/index.js";
import { AX, AXState, type ObservationWire, type SnapshotOptions } from "../ax/index.js";
import type { OperationOptions } from "../options.js";
import {
  ConsoleObserver,
  DialogWatcher,
  DownloadWatcher,
  FileChooserWatcher,
  InitScriptRegistration,
  type InitScriptDefinition,
  NetworkObserver,
  type NetworkObserverOptions,
  PopupWatcher,
  type ResourceDescriptor,
  type ResourceKind,
} from "../resources/index.js";
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

type PageObservationWire = {
  state?: ObservationWire;
  screenshot?: ScreenshotWire;
};

export type PageObservation = {
  state?: AXState;
  screenshot?: Screenshot;
};

/** Explicit low-level CDP access for diagnostics and unsupported primitives. */
export class CDPSession {
  readonly #client: ProtocolClient;
  readonly #tabId: string;
  readonly #resourceId: string;
  #disposed = false;

  constructor(client: ProtocolClient, tabId: string, resourceId: string) {
    this.#client = client;
    this.#tabId = tabId;
    this.#resourceId = resourceId;
  }

  /** Sends one CDP method to the tab's root session. */
  async send<T = unknown>(
    method: string,
    params: unknown = {},
    options: OperationOptions = {},
  ): Promise<T> {
    if (this.#disposed) {
      throw new ABError({
        kind: "resource_disposed",
        stage: "sdk.cdp.send",
        message: "CDPSession is disposed",
      });
    }
    return this.#client.request<T>("resource.command", { command: "send", params: { method, params } }, {
      target: { tabId: this.#tabId, resourceId: this.#resourceId },
      ...options,
    });
  }

  async dispose(options: OperationOptions = {}): Promise<void> {
    if (this.#disposed) return;
    await this.#client.request("resource.dispose", {}, {
      target: { tabId: this.#tabId, resourceId: this.#resourceId },
      ...options,
    });
    this.#disposed = true;
  }
}

/** A frame identity captured from the Rust SessionManager registry. */
export class Frame {
  readonly id: string;
  readonly targetId: string;
  readonly parentId: string | null;
  readonly url: string;
  readonly name: string | null;
  readonly documentGeneration: string;
  readonly sessionId: string;
  readonly #client: ProtocolClient;

  constructor(client: ProtocolClient, value: FrameInfo) {
    this.#client = client;
    this.id = value.id;
    this.targetId = value.targetId;
    this.parentId = value.parentId;
    this.url = value.url;
    this.name = value.name;
    this.documentGeneration = value.documentGeneration;
    this.sessionId = value.sessionId;
  }

  async cdp(): Promise<CDPSession> {
    const descriptor = await this.#client.request<ResourceDescriptor>(
      "resource.open",
      {
        kind: "cdp",
        options: {
          sessionId: this.sessionId,
          frameId: this.id,
          documentGeneration: this.documentGeneration,
        },
      },
      { target: { tabId: this.targetId, frameId: this.id, documentGeneration: this.documentGeneration } },
    );
    return new CDPSession(this.#client, this.targetId, descriptor.id);
  }

  /** Creates a CSS Locator explicitly scoped to this frame. */
  locator(selector: string): Locator {
    return this.#locator({ kind: "css", value: selector });
  }

  getByRole(role: string, options: { name?: string; exact?: boolean } = {}): Locator {
    return this.#locator({
      kind: "role",
      role,
      ...(options.name === undefined ? {} : { name: options.name }),
      exact: options.exact ?? false,
    });
  }

  getByText(text: string, options: { exact?: boolean } = {}): Locator {
    return this.#semanticLocator("text", text, options);
  }

  getByLabel(label: string, options: { exact?: boolean } = {}): Locator {
    return this.#semanticLocator("label", label, options);
  }

  getByPlaceholder(placeholder: string, options: { exact?: boolean } = {}): Locator {
    return this.#semanticLocator("placeholder", placeholder, options);
  }

  getByAltText(text: string, options: { exact?: boolean } = {}): Locator {
    return this.#semanticLocator("altText", text, options);
  }

  getByTitle(title: string, options: { exact?: boolean } = {}): Locator {
    return this.#semanticLocator("title", title, options);
  }

  getByTestId(testId: string): Locator {
    return this.#semanticLocator("testId", testId, {});
  }

  /** Evaluates a function in this frame's current default realm. */
  async evaluate<T, Args extends unknown[]>(
    pageFunction: (...args: Args) => T | Promise<T>,
    ...args: Args
  ): Promise<Awaited<T>> {
    const script = buildEvaluateScript(pageFunction, args);
    const result = await this.#client.request<{ result: unknown }>(
      "tab.evaluate",
      { expression: script, frameId: this.id },
      { target: { tabId: this.targetId, frameId: this.id, documentGeneration: this.documentGeneration } },
    );
    return deserializeEvaluateResult(result.result) as Awaited<T>;
  }

  #locator(query: LocatorQuery): Locator {
    return new Locator(this.#client, this.targetId, {
      kind: "frame",
      frameId: this.id,
      query,
    });
  }

  #semanticLocator(
    kind: "text" | "label" | "placeholder" | "altText" | "title" | "testId",
    value: string,
    options: { exact?: boolean },
  ): Locator {
    return this.#locator({ kind, value, exact: options.exact ?? false });
  }

  [inspect.custom](): string {
    return `Frame { id: '${this.id}', parentId: ${this.parentId ? `'${this.parentId}'` : "null"}, url: ${JSON.stringify(this.url)}, documentGeneration: '${this.documentGeneration}' }`;
  }
}

/** A concrete JavaScript execution realm owned by one CDP session. */
export class Realm {
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
  readonly #client: ProtocolClient;

  constructor(client: ProtocolClient, value: RealmInfo) {
    this.#client = client;
    this.id = value.id;
    this.executionContextId = value.executionContextId;
    this.rootTargetId = value.rootTargetId;
    this.targetId = value.targetId;
    this.frameId = value.frameId;
    this.origin = value.origin;
    this.name = value.name;
    this.kind = value.kind;
    this.isDefault = value.isDefault;
    this.sessionId = value.sessionId;
  }

  /** Evaluates a function in this exact execution context. */
  async evaluate<T, Args extends unknown[]>(
    pageFunction: (...args: Args) => T | Promise<T>,
    ...args: Args
  ): Promise<Awaited<T>> {
    const script = buildEvaluateScript(pageFunction, args);
    const result = await this.#client.request<{ result: unknown }>(
      "tab.evaluate",
      {
        expression: script,
        realmId: this.id,
        contextId: this.executionContextId,
        sessionId: this.sessionId,
        ...(this.frameId ? { frameId: this.frameId } : {}),
      },
      { target: { tabId: this.rootTargetId, ...(this.frameId ? { frameId: this.frameId } : {}) } },
    );
    return deserializeEvaluateResult(result.result) as Awaited<T>;
  }

  [inspect.custom](): string {
    return `Realm { id: '${this.id}', frameId: ${this.frameId ? `'${this.frameId}'` : "null"}, kind: '${this.kind}', default: ${this.isDefault} }`;
  }
}

/** A Chrome page target with typed observation, action, and resource surfaces. */
export class Tab {
  readonly id: string;
  #openerId: string | null;
  readonly ax: AX;
  readonly cua: CUA;
  #title: string;
  #url: string;
  #active: boolean;
  #ownership: TabInfo["ownership"];
  readonly #client: ProtocolClient;

  constructor(client: ProtocolClient, info: TabInfo) {
    this.#client = client;
    this.id = info.id;
    this.#openerId = info.openerId;
    this.ax = new AX(client, info.id);
    this.cua = new CUA(client, info.id);
    this.#title = info.title;
    this.#url = info.url;
    this.#active = info.active;
    this.#ownership = info.ownership;
  }

  get title(): string {
    return this.#title;
  }

  get openerId(): string | null {
    return this.#openerId;
  }

  get url(): string {
    return this.#url;
  }

  get active(): boolean {
    return this.#active;
  }

  /** Mutable-target ownership relative to this SDK client. */
  get ownership(): TabInfo["ownership"] {
    return this.#ownership;
  }

  /**
   * Applies the final browser-owned URL carried by an Agent action without a
   * second RPC or a presentation side effect.
   *
   * Design evidence:
   * `docs/evidence/20260902__agent-tab-action-metadata-coherence__@codex.md`.
   *
   * @internal
   */
  applyActionResult(result: Pick<ActionResult, "navigation">): void {
    this.#url = result.navigation.afterUrl;
  }

  async refresh(options: OperationOptions = {}): Promise<Tab> {
    const info = await this.#client.request<TabInfo>("tabs.get", {}, {
      target: { tabId: this.id },
      ...options,
    });
    this.#title = info.title;
    this.#openerId = info.openerId;
    this.#url = info.url;
    this.#active = info.active;
    this.#ownership = info.ownership;
    return this;
  }

  /** Acquires this existing target for mutation by the current SDK client. */
  async acquire(options: OperationOptions = {}): Promise<Tab> {
    const info = await this.#client.request<TabInfo>("tabs.acquire", {}, {
      target: { tabId: this.id },
      ...options,
    });
    this.#title = info.title;
    this.#openerId = info.openerId;
    this.#url = info.url;
    this.#active = info.active;
    this.#ownership = info.ownership;
    return this;
  }

  /** Navigates this tab and waits for the requested mechanical lifecycle state. */
  async navigate(url: string, options: NavigateOptions = {}): Promise<void> {
    const timeoutMs = options.timeoutMs ?? 30_000;
    await this.#client.request("tab.navigate", {
      url,
      waitUntil: options.waitUntil ?? "domcontentloaded",
      timeoutMs,
    }, {
      target: { tabId: this.id },
      timeoutMs,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    await this.refresh(options);
  }

  /** Captures pixels and returns a local artifact plus viewport identity. */
  async screenshot(options: ScreenshotOptions = {}): Promise<Screenshot> {
    const result = await this.#client.request<ScreenshotWire>("tab.screenshot", {
      fullPage: options.fullPage ?? false,
      scale: options.scale ?? "device",
    }, {
      target: { tabId: this.id },
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return new Screenshot(this.#client, result);
  }

  /** Returns the current frame registry, including dynamically attached OOPIFs. */
  async frames(options: OperationOptions = {}): Promise<Frame[]> {
    const values = await this.#client.request<FrameInfo[]>("tab.frames", {}, {
      target: { tabId: this.id },
      ...options,
    });
    return values.map((value) => new Frame(this.#client, value));
  }

  /** Returns the root frame for this tab's current document topology. */
  async mainFrame(options: OperationOptions = {}): Promise<Frame> {
    const frames = await this.frames(options);
    const roots = frames.filter((frame) => frame.parentId === null);
    if (roots.length !== 1) {
      throw new ABError({
        kind: "frame_registry_error",
        stage: "sdk.tab.main_frame",
        message: `tab ${this.id} has ${roots.length} root frames`,
      });
    }
    return roots[0]!;
  }

  /** Returns the current JavaScript realm registry for this tab. */
  async realms(options: OperationOptions = {}): Promise<Realm[]> {
    const values = await this.#client.request<RealmInfo[]>("tab.realms", {}, {
      target: { tabId: this.id },
      ...options,
    });
    return values.map((value) => new Realm(this.#client, value));
  }

  async cdp(): Promise<CDPSession> {
    const descriptor = await this.#client.request<ResourceDescriptor>(
      "resource.open",
      { kind: "cdp", options: {} },
      { target: { tabId: this.id } },
    );
    return new CDPSession(this.#client, this.id, descriptor.id);
  }

  observeNetwork(options: NetworkObserverOptions = {}): Promise<NetworkObserver> {
    return this.#openResource("network", NetworkObserver, {
      ...(options.bodyRetentionBytes === undefined ? {} : { bodyRetentionBytes: options.bodyRetentionBytes }),
      ...(options.bodyMemoryBytes === undefined ? {} : { bodyMemoryBytes: options.bodyMemoryBytes }),
      ...(options.maxBodyBytes === undefined ? {} : { maxBodyBytes: options.maxBodyBytes }),
      ...(options.cdpBufferBytes === undefined ? {} : { cdpBufferBytes: options.cdpBufferBytes }),
      ...(options.bodyStorage === undefined ? {} : { bodyStorage: options.bodyStorage }),
      ...(options.bodyCapture === undefined ? {} : { bodyCapture: options.bodyCapture }),
    }, options);
  }

  observeConsole(options: OperationOptions = {}): Promise<ConsoleObserver> {
    return this.#openResource("console", ConsoleObserver, {}, options);
  }

  watchDialogs(options: OperationOptions = {}): Promise<DialogWatcher> {
    return this.#openResource("dialog", DialogWatcher, {}, options);
  }

  watchPopups(options: OperationOptions = {}): Promise<PopupWatcher> {
    return this.#openResource("popup", PopupWatcher, {}, options);
  }

  watchDownloads(options: OperationOptions = {}): Promise<DownloadWatcher> {
    return this.#openResource("download", DownloadWatcher, {}, options);
  }

  watchFileChoosers(options: OperationOptions = {}): Promise<FileChooserWatcher> {
    return this.#openResource("fileChooser", FileChooserWatcher, {}, options);
  }

  addInitScript(
    definition: InitScriptDefinition,
    options: OperationOptions = {},
  ): Promise<InitScriptRegistration> {
    return this.#openResource("initScript", InitScriptRegistration, definition, options);
  }

  locator(selector: string): Locator {
    return new Locator(this.#client, this.id, { kind: "css", value: selector });
  }

  getByRole(role: string, options: { name?: string; exact?: boolean } = {}): Locator {
    return new Locator(this.#client, this.id, {
      kind: "role",
      role,
      ...(options.name === undefined ? {} : { name: options.name }),
      exact: options.exact ?? false,
    });
  }

  getByText(text: string, options: { exact?: boolean } = {}): Locator {
    return this.#semanticLocator("text", text, options);
  }

  getByLabel(label: string, options: { exact?: boolean } = {}): Locator {
    return this.#semanticLocator("label", label, options);
  }

  getByPlaceholder(placeholder: string, options: { exact?: boolean } = {}): Locator {
    return this.#semanticLocator("placeholder", placeholder, options);
  }

  getByAltText(text: string, options: { exact?: boolean } = {}): Locator {
    return this.#semanticLocator("altText", text, options);
  }

  getByTitle(title: string, options: { exact?: boolean } = {}): Locator {
    return this.#semanticLocator("title", title, options);
  }

  getByTestId(testId: string): Locator {
    return this.#semanticLocator("testId", testId, {});
  }

  /** Evaluates a function in the root frame's current default realm. */
  async evaluate<T, Args extends unknown[]>(
    pageFunction: (...args: Args) => T | Promise<T>,
    ...args: Args
  ): Promise<Awaited<T>> {
    if (typeof pageFunction !== "function") {
      throw new TypeError("tab.evaluate() requires a function");
    }
    const script = buildEvaluateScript(pageFunction, args);
    const result = await this.#client.request<{ result: unknown }>(
      "tab.evaluate",
      { expression: script },
      { target: { tabId: this.id } },
    );
    return deserializeEvaluateResult(result.result) as Awaited<T>;
  }

  async activate(options: OperationOptions = {}): Promise<void> {
    await this.#client.request("tab.activate", {}, { target: { tabId: this.id }, ...options });
    this.#active = true;
  }

  async reload(options: OperationOptions = {}): Promise<void> {
    await this.#client.request("tab.reload", {}, { target: { tabId: this.id }, ...options });
    await this.refresh(options);
  }

  async goBack(options: OperationOptions = {}): Promise<void> {
    await this.#client.request("tab.goBack", {}, { target: { tabId: this.id }, ...options });
    await this.refresh(options);
  }

  async goForward(options: OperationOptions = {}): Promise<void> {
    await this.#client.request("tab.goForward", {}, { target: { tabId: this.id }, ...options });
    await this.refresh(options);
  }

  async waitFor(
    options: OperationOptions & {
      selector?: string;
      text?: string;
      state?: "attached" | "detached" | "visible" | "hidden";
    },
  ): Promise<void> {
    await this.#client.request("tab.waitFor", {
      ...(options.selector === undefined ? {} : { selector: options.selector }),
      ...(options.text === undefined ? {} : { text: options.text }),
      ...(options.state === undefined ? {} : { state: options.state }),
      timeoutMs: options.timeoutMs ?? 30_000,
    }, { target: { tabId: this.id }, ...options });
  }

  /** Waits until the target URL contains a literal pattern or matches a `*` wildcard pattern. */
  async waitForURL(url: string, options: OperationOptions = {}): Promise<void> {
    const result = await this.#client.request<{ url: string }>(
      "tab.waitForURL",
      { url },
      { target: { tabId: this.id }, ...options },
    );
    this.#url = result.url;
  }

  /**
   * Waits for readiness of the document current when this request reaches the Runtime.
   * This does not anticipate a future navigation or imply network/application readiness.
   */
  async waitForLoadState(state: LoadState = "load", options: OperationOptions = {}): Promise<void> {
    await this.#client.request(
      "tab.waitForLoadState",
      { state },
      { target: { tabId: this.id }, ...options },
    );
  }

  /**
   * Atomically captures the requested AX state and screenshot.
   *
   * When both are requested, Rust validates one document, frame topology,
   * viewport, scroll position, and DPR transaction before returning either.
   */
  async observe(options: ObserveOptions): Promise<PageObservation> {
    const ax = typeof options.ax === "object"
      ? options.ax
      : options.ax === true
        ? {}
        : undefined;
    const wire = await this.#client.request<PageObservationWire>(
      "tab.observe",
      {
        ...(ax === undefined ? {} : {
          ax: {
            mode: ax.mode ?? "interactive",
            surface: ax.surface ?? "document",
            ...(ax.frames === undefined ? {} : { frames: ax.frames }),
            ...(ax.maxDepth === undefined ? {} : { maxDepth: ax.maxDepth }),
            ...(ax.maxChars === undefined ? {} : { maxChars: ax.maxChars }),
            ...(ax.diffFrom === undefined ? {} : {
              diffFrom: typeof ax.diffFrom === "string" ? ax.diffFrom : ax.diffFrom.id,
            }),
            includeUrls: ax.includeUrls ?? false,
          },
        }),
        screenshot: options.screenshot ?? false,
        fullPage: options.fullPage ?? false,
        scale: options.scale ?? "device",
      },
      {
        target: { tabId: this.id },
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    );
    return {
      ...(wire.state ? { state: new AXState(this.#client, wire.state) } : {}),
      ...(wire.screenshot ? { screenshot: new Screenshot(this.#client, wire.screenshot) } : {}),
    };
  }

  async close(options: OperationOptions = {}): Promise<void> {
    await this.#client.request("tab.close", {}, {
      target: { tabId: this.id },
      ...options,
    });
  }

  #semanticLocator(
    kind: "text" | "label" | "placeholder" | "altText" | "title" | "testId",
    value: string,
    options: { exact?: boolean },
  ): Locator {
    const exact = options.exact ?? false;
    switch (kind) {
      case "text":
        return new Locator(this.#client, this.id, { kind: "text", value, exact });
      case "label":
        return new Locator(this.#client, this.id, { kind: "label", value, exact });
      case "placeholder":
        return new Locator(this.#client, this.id, { kind: "placeholder", value, exact });
      case "altText":
        return new Locator(this.#client, this.id, { kind: "altText", value, exact });
      case "title":
        return new Locator(this.#client, this.id, { kind: "title", value, exact });
      case "testId":
        return new Locator(this.#client, this.id, { kind: "testId", value, exact });
    }
  }

  async #openResource<T>(
    kind: ResourceKind,
    ResourceType: new (client: ProtocolClient, descriptor: ResourceDescriptor) => T,
    resourceOptions: Record<string, unknown>,
    options: OperationOptions,
  ): Promise<T> {
    const descriptor = await this.#client.request<ResourceDescriptor>(
      "resource.open",
      { kind, options: resourceOptions },
      { target: { tabId: this.id }, ...options },
    );
    return new ResourceType(this.#client, descriptor);
  }

  [inspect.custom](): string {
    return `Tab { id: '${this.id}', title: ${JSON.stringify(this.#title)}, url: ${JSON.stringify(this.#url)}, ownership: '${this.#ownership}' }`;
  }
}

/** Browser target discovery and creation. */
export class Tabs {
  readonly #client: ProtocolClient;

  constructor(client: ProtocolClient) {
    this.#client = client;
  }

  async list(options: OperationOptions = {}): Promise<Tab[]> {
    const infos = await this.#client.request<TabInfo[]>("tabs.list", {}, options);
    return infos.map((info) => new Tab(this.#client, info));
  }

  async get(targetId: string, options: OperationOptions = {}): Promise<Tab> {
    const info = await this.#client.request<TabInfo>("tabs.get", {}, {
      target: { tabId: targetId },
      ...options,
    });
    return new Tab(this.#client, info);
  }

  /** Gets and atomically acquires an existing target for this client. */
  async acquire(targetId: string, options: OperationOptions = {}): Promise<Tab> {
    const info = await this.#client.request<TabInfo>("tabs.acquire", {}, {
      target: { tabId: targetId },
      ...options,
    });
    return new Tab(this.#client, info);
  }

  async open(url = "about:blank", options: NavigateOptions = {}): Promise<Tab> {
    const timeoutMs = options.timeoutMs ?? 30_000;
    const info = await this.#client.request<TabInfo>("tabs.open", {
      url,
      waitUntil: options.waitUntil ?? "domcontentloaded",
      timeoutMs,
    }, { ...options, timeoutMs });
    return new Tab(this.#client, info);
  }
}

/** One SDK client attached to the persistent AB daemon and Chrome instance. */
export class Browser {
  readonly identity: BrowserIdentity;
  readonly tabs: Tabs;
  readonly diagnostics: Diagnostics;
  readonly #client: ProtocolClient;
  readonly #onDisconnect: () => void;

  constructor(client: ProtocolClient, onDisconnect: () => void) {
    this.#client = client;
    this.#onDisconnect = onDisconnect;
    this.identity = {
      clientId: client.ready.clientId,
      daemonId: client.ready.daemonId,
      browserGeneration: client.ready.browserGeneration,
      chrome: client.ready.chrome,
    };
    this.tabs = new Tabs(client);
    this.diagnostics = new Diagnostics(client);
    client.onClose(onDisconnect);
  }

  get connected(): boolean {
    return this.#client.connected;
  }

  /** Releases this client's server-owned resources without closing Chrome. */
  async disconnect(): Promise<void> {
    await this.#client.disconnect();
    this.#onDisconnect();
  }

  [inspect.custom](): string {
    return `Browser { connected: ${this.connected}, clientId: '${this.identity.clientId}', daemonId: '${this.identity.daemonId}', browserGeneration: '${this.identity.browserGeneration}' }`;
  }
}
