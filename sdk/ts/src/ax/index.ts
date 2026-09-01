import { inspect } from "node:util";
import { Screenshot, type ScreenshotWire } from "../artifacts/index.js";
import {
  ElementHandle,
  type ElementHandleDescriptor,
  type ElementInspection,
  type ElementInspectionOptions,
} from "../elements/index.js";
import { ABError } from "../errors/index.js";
import type { ProtocolClient } from "../transport/index.js";
import type { OperationOptions } from "../options.js";
import type { ActionResult, ActionWire, TextInputActionData } from "../actions/result.js";

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
  surfaceReplaced: boolean;
  text: string;
  additions: number;
  removals: number;
  addedRefs: string[];
  removedRefs: string[];
  changedRefs: string[];
};

export type ObservationSurfaceIdentity = {
  sessionId: string;
  frameId: string;
  documentGeneration: string;
  rootBackendNodeId: number;
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
  surfaceIdentity: ObservationSurfaceIdentity;
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
  frames?: "all" | { root: string };
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
export class AXRef {
  readonly observationId: string;
  readonly id: string;
  readonly role: string;
  readonly name: string;
  readonly frameId: string;
  readonly documentGeneration: string;
  readonly backendNodeId: number | null;
  readonly bounds: Bounds | null;
  readonly #client: ProtocolClient;
  readonly #targetId: string;

  constructor(
    client: ProtocolClient,
    targetId: string,
    observationId: string,
    value: ObservationRef,
  ) {
    this.#client = client;
    this.#targetId = targetId;
    this.observationId = observationId;
    this.id = value.id;
    this.role = value.role;
    this.name = value.name;
    this.frameId = value.frameId;
    this.documentGeneration = value.documentGeneration;
    this.backendNodeId = value.backendNodeId;
    this.bounds = value.bounds;
  }

  click(options: ClickOptions = {}): Promise<ActionResult> {
    return this.#perform("click", {
      button: options.button ?? "left",
      clickCount: options.clickCount ?? 1,
      observe: options.observe ?? "diff",
    }, options);
  }

  doubleClick(options: RefActionOptions = {}): Promise<ActionResult> {
    return this.#perform("dblclick", { observe: options.observe ?? "diff" }, options);
  }

  hover(options: RefActionOptions = {}): Promise<ActionResult> {
    return this.#perform("hover", { observe: options.observe ?? "none" }, options);
  }

  wheel(deltaX: number, deltaY: number, options: RefActionOptions = {}): Promise<ActionResult> {
    return this.#perform("wheel", { deltaX, deltaY, observe: options.observe ?? "none" }, options);
  }

  fill(value: string, options: RefActionOptions = {}): Promise<ActionResult<TextInputActionData>> {
    return this.#perform("fill", {
      value,
      observe: options.observe ?? "diff",
    }, options);
  }

  type(text: string, options: TypeOptions = {}): Promise<ActionResult<TextInputActionData>> {
    return this.#perform("type", {
      text,
      clear: options.clear ?? false,
      ...(options.delayMs === undefined ? {} : { delayMs: options.delayMs }),
      observe: options.observe ?? "diff",
    }, options);
  }

  press(key: string, options: RefActionOptions = {}): Promise<ActionResult> {
    return this.#perform("press", {
      key,
      observe: options.observe ?? "diff",
    }, options);
  }

  focus(options: RefActionOptions = {}): Promise<ActionResult> {
    return this.#perform("focus", { observe: options.observe ?? "none" }, options);
  }

  clear(options: RefActionOptions = {}): Promise<ActionResult> {
    return this.#perform("clear", { observe: options.observe ?? "diff" }, options);
  }

  scrollIntoView(options: RefActionOptions = {}): Promise<ActionResult> {
    return this.#perform("scrollIntoView", {
      observe: options.observe ?? "none",
    }, options);
  }

  check(options: RefActionOptions = {}): Promise<ActionResult> {
    return this.#perform("check", { observe: options.observe ?? "diff" }, options);
  }

  uncheck(options: RefActionOptions = {}): Promise<ActionResult> {
    return this.#perform("uncheck", { observe: options.observe ?? "diff" }, options);
  }

  selectOption(values: string | string[], options: RefActionOptions = {}): Promise<ActionResult> {
    return this.#perform("select", {
      values: Array.isArray(values) ? values : [values],
      observe: options.observe ?? "diff",
    }, options);
  }

  setFiles(files: string | string[], options: RefActionOptions = {}): Promise<ActionResult> {
    return this.#perform("upload", {
      files: Array.isArray(files) ? files : [files],
      observe: options.observe ?? "diff",
    }, options);
  }

  dragTo(target: AXRef, options: RefActionOptions = {}): Promise<ActionResult> {
    if (target.#client !== this.#client || target.#targetId !== this.#targetId) {
      return Promise.reject(new TypeError("AXRef.dragTo requires a ref from the same Browser and Tab"));
    }
    return this.#perform("drag", {
      targetObservationId: target.observationId,
      targetRefId: target.id,
      observe: options.observe ?? "diff",
    }, options);
  }

  async textContent(options: OperationOptions = {}): Promise<string> {
    const data = await this.#read<{ text?: unknown }>("text", {}, options);
    return typeof data.text === "string" ? data.text : String(data.text ?? "");
  }

  async innerText(options: OperationOptions = {}): Promise<string> {
    const data = await this.#read<{ text?: unknown }>("innertext", {}, options);
    return typeof data.text === "string" ? data.text : String(data.text ?? "");
  }

  async getAttribute(name: string, options: OperationOptions = {}): Promise<string | null> {
    const result = await this.#read<{ value?: unknown }>("getattribute", { attribute: name }, options);
    const value = result.value;
    return typeof value === "string" ? value : null;
  }

  async boundingBox(options: OperationOptions = {}): Promise<Bounds | null> {
    const value = await this.#read<Partial<Bounds> | null>("boundingbox", {}, options);
    return value && value.x !== undefined && value.y !== undefined && value.width !== undefined && value.height !== undefined
      ? { x: value.x, y: value.y, width: value.width, height: value.height }
      : null;
  }

  async isVisible(options: OperationOptions = {}): Promise<boolean> {
    return (await this.#read<{ value?: unknown }>("isvisible", {}, options)).value === true;
  }

  async isEnabled(options: OperationOptions = {}): Promise<boolean> {
    return (await this.#read<{ value?: unknown }>("isenabled", {}, options)).value === true;
  }

  async isChecked(options: OperationOptions = {}): Promise<boolean> {
    return (await this.#read<{ value?: unknown }>("ischecked", {}, options)).value === true;
  }

  async inputValue(options: OperationOptions = {}): Promise<string> {
    const value = (await this.#read<{ value?: unknown }>("inputvalue", {}, options)).value;
    return typeof value === "string" ? value : String(value ?? "");
  }

  inspect(options: ElementInspectionOptions = {}): Promise<ElementInspection> {
    const { attributes = [], ...operationOptions } = options;
    return this.#read("inspect", { attributes }, operationOptions);
  }

  domInvoke<T = unknown>(method: string, args: unknown[] = [], options: RefActionOptions = {}): Promise<ActionResult<{ value?: T }>> {
    return this.#perform("dominvoke", { method, args, observe: options.observe ?? "none" }, options);
  }

  async screenshot(options: OperationOptions = {}): Promise<Screenshot> {
    const result = await this.#read<ScreenshotWire>("screenshot", {}, options);
    return new Screenshot(this.#client, result);
  }

  /** Retains this exact backend node as a server-owned ElementHandle. */
  async elementHandle(options: OperationOptions = {}): Promise<ElementHandle> {
    const descriptor = await this.#client.request<ElementHandleDescriptor>(
      "element.createFromRef",
      { observationId: this.observationId, refId: this.id },
      { target: { tabId: this.#targetId, observationId: this.observationId }, ...options },
    );
    return new ElementHandle(this.#client, descriptor);
  }

  [inspect.custom](): string {
    return `AXRef { id: '${this.id}', role: '${this.role}', name: ${JSON.stringify(this.name)}, observationId: '${this.observationId}' }`;
  }

  async #perform<TData = unknown>(
    action: string,
    params: Record<string, unknown>,
    options: RefActionOptions,
  ): Promise<ActionResult<TData>> {
    const { baseline: _baseline, ...operationOptions } = options;
    const result = await this.#client.request<ActionWire<TData>>(
      "action.perform",
      {
        observationId: this.observationId,
        refId: this.id,
        action,
        ...params,
        ...(params.observe === "diff" ? { baselineObservationId: this.observationId } : {}),
        ...(options.observation === undefined ? {} : { observation: options.observation }),
      },
      { target: { tabId: this.#targetId }, ...operationOptions },
    );
    return {
      ...result,
      observation: result.observation
        ? new AXState(this.#client, result.observation)
        : null,
    };
  }

  #read<TData>(
    action: string,
    params: Record<string, unknown>,
    options: OperationOptions,
  ): Promise<TData> {
    return this.#client.request<TData>(
      "action.perform",
      {
        observationId: this.observationId,
        refId: this.id,
        action,
        ...params,
      },
      { target: { tabId: this.#targetId }, ...options },
    );
  }
}

/**
 * Immutable AX observation text, refs, identity, completeness, and optional diff.
 * Agent-visible rendering belongs to @hanger-source/ab/agent's Presenter.
 */
export class AXState {
  readonly id: string;
  readonly targetId: string;
  readonly frameId: string;
  readonly documentGeneration: string;
  readonly revision: number;
  readonly text: string;
  readonly #refs: readonly AXRef[];
  readonly complete: boolean;
  readonly truncated: boolean;
  readonly nodeCount: number;
  readonly sources: ObservationSources;
  readonly diff: ObservationDiff | null;
  readonly #client: ProtocolClient;
  #disposed = false;

  constructor(client: ProtocolClient, value: ObservationWire) {
    this.#client = client;
    this.id = value.id;
    this.targetId = value.targetId;
    this.frameId = value.frameId;
    this.documentGeneration = value.documentGeneration;
    this.revision = value.revision;
    this.text = value.text;
    this.#refs = value.refs.map(
      (entry) => new AXRef(client, value.targetId, value.id, entry),
    );
    this.complete = value.complete;
    this.truncated = value.truncated;
    this.nodeCount = value.nodeCount;
    this.sources = Object.freeze({ ...value.sources });
    this.diff = value.diff;
  }

  /** Returns a ref from this observation; accepts `e7` or `@e7`. */
  ref(id: string): AXRef {
    this.#assertLive();
    const normalized = id.startsWith("@") ? id.slice(1) : id;
    const reference = this.#refs.find((entry) => entry.id === normalized);
    if (!reference) {
      throw new ABError({
        kind: "ref_not_found",
        stage: "sdk.observation.ref",
        message: `observation ${this.id} has no ref ${id}`,
      });
    }
    return reference;
  }

  /** Returns the refs created by this observation. */
  refs(): readonly AXRef[] {
    this.#assertLive();
    return this.#refs;
  }

  /** Releases the server observation record. Existing refs become unusable. */
  async dispose(options: OperationOptions = {}): Promise<void> {
    if (this.#disposed) {
      return;
    }
    await this.#client.request("observation.dispose", {
      observationId: this.id,
    }, options);
    this.#disposed = true;
  }

  [inspect.custom](): string {
    return `AXState { id: '${this.id}', revision: ${this.revision}, refs: ${this.#refs.length}, complete: ${this.complete}, truncated: ${this.truncated}, documentGeneration: '${this.documentGeneration}' }`;
  }

  #assertLive(): void {
    if (this.#disposed) {
      throw new ABError({
        kind: "resource_disposed",
        stage: "sdk.observation",
        message: `observation ${this.id} is disposed`,
      });
    }
  }
}

/** Explicit accessibility capture surface for one tab. */
export class AX {
  readonly #client: ProtocolClient;
  readonly #tabId: string;

  constructor(client: ProtocolClient, tabId: string) {
    this.#client = client;
    this.#tabId = tabId;
  }

  /** Captures a new AXState and establishes its ref identities. */
  async snapshot(options: SnapshotOptions = {}): Promise<AXState> {
    const result = await this.#client.request<ObservationWire>(
      "observation.snapshot",
      {
        mode: options.mode ?? "interactive",
        surface: options.surface ?? "document",
        ...(options.frames === undefined ? {} : { frames: options.frames }),
        ...(options.maxDepth === undefined ? {} : { maxDepth: options.maxDepth }),
        ...(options.maxChars === undefined ? {} : { maxChars: options.maxChars }),
        ...(options.diffFrom === undefined
          ? {}
          : {
              diffFrom:
                typeof options.diffFrom === "string"
                  ? options.diffFrom
                  : options.diffFrom.id,
            }),
        includeUrls: options.includeUrls ?? false,
      },
      {
        target: { tabId: this.#tabId },
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    );
    return new AXState(this.#client, result);
  }
}
