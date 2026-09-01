import { ABError } from "../errors/index.js";
import { readFile } from "node:fs/promises";
import {
  Browser,
  type BrowserIdentity,
  type NavigateOptions,
  type PageObservation,
  Tab,
} from "../browser/index.js";
import type { Screenshot, ScreenshotScale } from "../artifacts/index.js";
import type {
  ElementHandle,
  ElementInspection,
  ElementInspectionOptions,
} from "../elements/index.js";
import { connect as connectCore } from "../index.js";
import {
  type ActionResult,
  type AXRef,
  type AXState,
  type ClickOptions,
  type RefActionOptions,
  type SnapshotOptions,
  type TypeOptions,
} from "../ax/index.js";
import type { TextInputActionData } from "../actions/result.js";
import {
  CUA,
  type CuaActionData,
  type CuaClickOptions,
  type CuaDragOptions,
  type CuaPoint,
  type CuaWheelOptions,
} from "../actions/cua.js";
import type { OperationOptions } from "../options.js";
import type { Diagnostics } from "../diagnostics/index.js";
import {
  Locator,
  type LocatorActionOptions,
  type LocatorClickOptions,
  type LocatorFilter,
  type LocatorResult,
  type SuggestionCommitOptions,
  type SuggestionCommitResult,
  type LocatorWaitOptions,
} from "../locators/index.js";

export type AgentAXContent = "state" | "screenshot" | "both";

export type AgentTextPresentation = {
  kind: "ax" | "action" | "documentation";
  origin: string;
  observationId: string | null;
  text: string;
  untrusted: boolean;
  presentation?: "full" | "incremental" | "document-replacement" | "surface-replacement";
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
  emitImage(
    image: Uint8Array | { bytes: Uint8Array; mimeType: string },
  ): void | Promise<void>;
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

const AGENT_OBSERVATION_MAX_CHARS = 24_000;

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

export type AgentDocumentationTopic =
  | "core"
  | "api"
  | "bootstrap"
  | "lifecycle"
  | "safety"
  | "authentication"
  | "tabs"
  | "navigation"
  | "observation"
  | "actions"
  | "forms"
  | "screenshot"
  | "frames"
  | "evaluate"
  | "network"
  | "console-dialogs"
  | "downloads"
  | "init-scripts"
  | "resources"
  | "cdp"
  | "recovery"
  | "task-recipes"
  | "diagnostics";

const DOCUMENTATION_FILES: Record<AgentDocumentationTopic, string> = {
  core: "core.md",
  api: "api.md",
  bootstrap: "bootstrap.md",
  lifecycle: "lifecycle.md",
  safety: "safety.md",
  authentication: "authentication.md",
  tabs: "tabs.md",
  navigation: "navigation.md",
  observation: "observation.md",
  actions: "actions.md",
  forms: "forms.md",
  screenshot: "screenshot.md",
  frames: "frames.md",
  evaluate: "evaluate.md",
  network: "network.md",
  "console-dialogs": "console-dialogs.md",
  downloads: "downloads.md",
  "init-scripts": "init-scripts.md",
  resources: "resources.md",
  cdp: "cdp.md",
  recovery: "recovery.md",
  "task-recipes": "task-recipes.md",
  diagnostics: "diagnostics.md",
};

class AgentDocumentationRegistry {
  readonly #read = new Set<AgentDocumentationTopic>();

  markRead(topic: AgentDocumentationTopic): void {
    this.#read.add(topic);
  }

  require(topic: AgentDocumentationTopic, member: string): void {
    if (this.#read.has(topic)) {
      return;
    }
    throw new ABError({
      kind: "documentation_required",
      stage: "agent.documentation",
      message: `${member} requires await agent.documentation(${JSON.stringify(topic)}) before use`,
      details: { topic, member },
    });
  }
}

async function readDocumentation(topic: AgentDocumentationTopic): Promise<string> {
  const path = new URL(`../../docs/${DOCUMENTATION_FILES[topic]}`, import.meta.url);
  return readFile(path, "utf8");
}

function formatTextPresentation(value: AgentTextPresentation): string {
  const boundary = value.untrusted ? "AB_UNTRUSTED_BROWSER_CONTENT" : "AB_DOCUMENTATION";
  const presentation = value.presentation === undefined
    ? ""
    : ` presentation=${JSON.stringify(value.presentation)}`;
  return `<<<${boundary} origin=${JSON.stringify(value.origin)} observation=${JSON.stringify(value.observationId)}${presentation}>>>\n${value.text}\n<<<END_${boundary}>>>\n`;
}

function formatScreenshotPresentation(value: AgentImagePresentation): string {
  return `AB_SCREENSHOT ${JSON.stringify({
    origin: value.origin,
    id: value.screenshot.id,
    path: value.screenshot.path,
    sha256: value.screenshot.sha256,
    mediaType: value.screenshot.mediaType,
    bytes: value.screenshot.bytes,
    viewportId: value.screenshot.viewportId,
    width: value.screenshot.width,
    height: value.screenshot.height,
    fullPage: value.screenshot.fullPage,
    scale: value.screenshot.scale,
    cssViewport: value.screenshot.cssViewport,
  })}\n`;
}

/** Presentation for ordinary Node.js processes. */
export function terminalPresenter(): AgentPresenter {
  return {
    presentText(value) {
      process.stdout.write(formatTextPresentation(value));
    },
    presentImage(value) {
      process.stdout.write(formatScreenshotPresentation(value));
    },
  };
}

/** Presentation through the public content channel of a managed Node REPL. */
export function nodeReplPresenter(host: NodeReplContentHost): AgentPresenter {
  return {
    presentText(value) {
      host.write(formatTextPresentation(value));
    },
    async presentImage(value) {
      const bytes = await value.screenshot.read();
      host.write(formatScreenshotPresentation(value));
      await host.emitImage({ bytes, mimeType: value.screenshot.mediaType });
    },
  };
}

function defaultPresenter(): AgentPresenter {
  const candidate = (globalThis as { nodeRepl?: unknown }).nodeRepl;
  if (
    candidate
    && typeof candidate === "object"
    && typeof (candidate as Partial<NodeReplContentHost>).write === "function"
    && typeof (candidate as Partial<NodeReplContentHost>).emitImage === "function"
  ) {
    return nodeReplPresenter(candidate as NodeReplContentHost);
  }
  return terminalPresenter();
}

export class AgentAX {
  readonly #tab: Tab;
  readonly #presenter: AgentPresenter;
  readonly #documentation: AgentDocumentationRegistry;
  #lastPresentedState: AXState | null = null;

  constructor(
    tab: Tab,
    presenter: AgentPresenter,
    documentation: AgentDocumentationRegistry,
  ) {
    this.#tab = tab;
    this.#presenter = presenter;
    this.#documentation = documentation;
  }

  get(content: "state", options?: AgentWriteOptions): Promise<AXState>;
  get(content: "screenshot", options?: AgentWriteOptions): Promise<Screenshot>;
  get(content: "both", options?: AgentWriteOptions): Promise<PageObservation>;
  async get(
    content: AgentAXContent,
    options: AgentWriteOptions = {},
  ): Promise<AXState | Screenshot | PageObservation> {
    if (content === "screenshot" || content === "both") {
      this.#documentation.require("screenshot", `tab.ax.get(${JSON.stringify(content)})`);
    }
    if (content === "state") {
      return this.#tab.ax.snapshot(snapshotOptions(options));
    }
    if (content === "screenshot") {
      return this.#tab.screenshot({ ...options, scale: options.scale ?? "css" });
    }
    return this.#tab.observe({
      ax: snapshotOptions(options),
      screenshot: true,
      fullPage: options.fullPage ?? false,
      scale: options.scale ?? "css",
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  write(content: AgentAXContent, options?: AgentWriteOptions): Promise<void>;
  write(state: AXState): Promise<void>;
  async write(
    content: AgentAXContent | AXState,
    options: AgentWriteOptions = {},
  ): Promise<void> {
    if (typeof content !== "string") {
      if (content.targetId !== this.#tab.id) {
        throw new ABError({
          kind: "target_mismatch",
          stage: "agent.ax.write",
          message: `observation ${content.id} belongs to tab ${content.targetId}, not ${this.#tab.id}`,
        });
      }
      try {
        await this.#presentState(content);
      } catch (error) {
        await content.dispose().catch(() => undefined);
        throw error;
      }
      await this.#replacePresentedState(content);
      return;
    }
    if (content === "screenshot" || content === "both") {
      this.#documentation.require("screenshot", `tab.ax.write(${JSON.stringify(content)})`);
    }
    if (content === "state") {
      const state = await this.get("state", options);
      try {
        await this.#presentState(state);
      } catch (error) {
        await state.dispose().catch(() => undefined);
        throw error;
      }
      await this.#replacePresentedState(state);
      return;
    }
    if (content === "screenshot") {
      const screenshot = await this.get("screenshot", options);
      await this.#presenter.presentImage({
        kind: "screenshot",
        origin: this.#tab.url,
        screenshot,
      });
      return;
    }

    const observation = await this.get("both", options);
    if (!observation.state || !observation.screenshot) {
      throw new ABError({
        kind: "observation_incomplete",
        stage: "agent.ax.write",
        message: "atomic state and screenshot observation returned an incomplete result",
      });
    }
    try {
      await this.#presentState(observation.state);
      await this.#presenter.presentImage({
        kind: "screenshot",
        origin: this.#tab.url,
        screenshot: observation.screenshot,
      });
    } catch (error) {
      await observation.state.dispose().catch(() => undefined);
      throw error;
    }
    await this.#replacePresentedState(observation.state);
  }

  click(refId: string, options: AgentClickOptions = {}): Promise<ActionResult> {
    const { write = "diff", ...action } = options;
    return this.#perform(refId, write, (ref) => ref.click(agentActionOptions({
      ...action,
    }, write)));
  }

  doubleClick(refId: string, options: AgentRefActionOptions = {}): Promise<ActionResult> {
    const { write = "diff", ...action } = options;
    return this.#perform(refId, write, (ref) => ref.doubleClick(agentActionOptions({
      ...action,
    }, write)));
  }

  hover(refId: string, options: AgentRefActionOptions = {}): Promise<ActionResult> {
    const { write = "none", ...action } = options;
    return this.#perform(refId, write, (ref) => ref.hover(agentActionOptions(action, write)));
  }

  wheel(
    refId: string,
    deltaX: number,
    deltaY: number,
    options: AgentRefActionOptions = {},
  ): Promise<ActionResult> {
    const { write = "none", ...action } = options;
    return this.#perform(refId, write, (ref) => ref.wheel(deltaX, deltaY, agentActionOptions(action, write)));
  }

  fill(refId: string, value: string, options: AgentRefActionOptions = {}): Promise<ActionResult<TextInputActionData>> {
    const { write = "diff", ...action } = options;
    return this.#perform(refId, write, (ref) => ref.fill(value, agentActionOptions({
      ...action,
    }, write)));
  }

  type(refId: string, text: string, options: AgentTypeOptions = {}): Promise<ActionResult<TextInputActionData>> {
    const { write = "diff", ...action } = options;
    return this.#perform(refId, write, (ref) => ref.type(text, agentActionOptions({
      ...action,
    }, write)));
  }

  press(refId: string, key: string, options: AgentRefActionOptions = {}): Promise<ActionResult> {
    const { write = "diff", ...action } = options;
    return this.#perform(refId, write, (ref) => ref.press(key, agentActionOptions({
      ...action,
    }, write)));
  }

  focus(refId: string, options: AgentRefActionOptions = {}): Promise<ActionResult> {
    const { write = "none", ...action } = options;
    return this.#perform(refId, write, (ref) => ref.focus(agentActionOptions(action, write)));
  }

  clear(refId: string, options: AgentRefActionOptions = {}): Promise<ActionResult> {
    const { write = "diff", ...action } = options;
    return this.#perform(refId, write, (ref) => ref.clear(agentActionOptions({
      ...action,
    }, write)));
  }

  check(refId: string, options: AgentRefActionOptions = {}): Promise<ActionResult> {
    const { write = "diff", ...action } = options;
    return this.#perform(refId, write, (ref) => ref.check(agentActionOptions({
      ...action,
    }, write)));
  }

  uncheck(refId: string, options: AgentRefActionOptions = {}): Promise<ActionResult> {
    const { write = "diff", ...action } = options;
    return this.#perform(refId, write, (ref) => ref.uncheck(agentActionOptions({
      ...action,
    }, write)));
  }

  selectOption(
    refId: string,
    values: string | string[],
    options: AgentRefActionOptions = {},
  ): Promise<ActionResult> {
    const { write = "diff", ...action } = options;
    return this.#perform(refId, write, (ref) => ref.selectOption(values, agentActionOptions({
      ...action,
    }, write)));
  }

  setFiles(
    refId: string,
    files: string | string[],
    options: AgentRefActionOptions = {},
  ): Promise<ActionResult> {
    const { write = "diff", ...action } = options;
    return this.#perform(refId, write, (ref) => ref.setFiles(files, agentActionOptions({
      ...action,
    }, write)));
  }

  dragTo(
    sourceRefId: string,
    targetRefId: string,
    options: AgentRefActionOptions = {},
  ): Promise<ActionResult> {
    const { write = "diff", ...action } = options;
    return this.#perform(sourceRefId, write, (source) => source.dragTo(this.#ref(targetRefId), agentActionOptions({
      ...action,
    }, write)));
  }

  scrollIntoView(refId: string, options: AgentRefActionOptions = {}): Promise<ActionResult> {
    const { write = "none", ...action } = options;
    return this.#perform(refId, write, (ref) => ref.scrollIntoView(agentActionOptions(action, write)));
  }

  async dispose(): Promise<void> {
    const state = this.#lastPresentedState;
    this.#lastPresentedState = null;
    await state?.dispose();
  }

  /** The exact observation currently visible to this Agent session. */
  actionBaseline(): AXState | null {
    return this.#lastPresentedState;
  }

  #ref(refId: string): AXRef {
    if (!this.#lastPresentedState) {
      throw new ABError({
        kind: "agent_observation_required",
        stage: "agent.ax.ref",
        message: `tab ${this.#tab.id} has no successfully presented AX observation`,
      });
    }
    return this.#lastPresentedState.ref(refId);
  }

  async #perform<TData = unknown>(
    refId: string,
    write: AgentActionWrite,
    action: (ref: AXRef) => Promise<ActionResult<TData>>,
  ): Promise<ActionResult<TData>> {
    const result = await action(this.#ref(refId));
    if (write === "diff") {
      if (result.observation) {
        await this.#presentState(result.observation);
        await this.#replacePresentedState(result.observation);
      } else {
        await this.presentActionObservationOutcome(result);
      }
    } else if (write === "state") {
      if (result.observation) {
        await this.write(result.observation);
      } else {
        await this.write("state");
      }
    }
    return result;
  }

  async presentActionObservationOutcome(result: ActionResult): Promise<void> {
    const outcome = result.observationOutcome;
    const failure = outcome.error
      ? ` ${outcome.error.kind} [${outcome.error.stage}]: ${outcome.error.message}`
      : "";
    await this.#presenter.presentText({
      kind: "action",
      origin: this.#tab.url,
      observationId: null,
      text: `AB action ${result.action} dispatch completed; post-action observation ${outcome.status}.${failure} Observe current page state before deciding on another mutation.`,
      untrusted: false,
    });
  }

  #presentState(state: AXState): Promise<void> | void {
    const text = state.diff && !state.diff.documentReplaced && !state.diff.surfaceReplaced
      ? state.diff.text || "No accessibility-tree text changed after the action."
      : state.text;
    const presentation = state.diff?.documentReplaced
      ? "document-replacement"
      : state.diff?.surfaceReplaced
        ? "surface-replacement"
        : state.diff
          ? "incremental"
          : "full";
    return this.#presenter.presentText({
      kind: "ax",
      origin: this.#tab.url,
      observationId: state.id,
      text,
      untrusted: true,
      presentation,
    });
  }

  async #replacePresentedState(state: AXState): Promise<void> {
    const previous = this.#lastPresentedState;
    this.#lastPresentedState = state;
    if (previous && previous !== state) {
      await previous.dispose();
    }
  }
}

/** Agent-facing viewport input that binds post-action state to the presented AX baseline. */
export class AgentCUA {
  readonly #core: CUA;
  readonly #ax: AgentAX;

  constructor(core: CUA, ax: AgentAX) {
    this.#core = core;
    this.#ax = ax;
  }

  click(options: CuaClickOptions): Promise<ActionResult<CuaActionData>> {
    return this.#perform(options, (action) => this.#core.click(action as CuaClickOptions));
  }

  move(options: CuaPoint): Promise<ActionResult<CuaActionData>> {
    return this.#perform(options, (action) => this.#core.move(action as CuaPoint));
  }

  wheel(options: CuaWheelOptions): Promise<ActionResult<CuaActionData>> {
    return this.#perform(options, (action) => this.#core.wheel(action as CuaWheelOptions));
  }

  drag(options: CuaDragOptions): Promise<ActionResult<CuaActionData>> {
    return this.#perform(options, (action) => this.#core.drag(action as CuaDragOptions));
  }

  async #perform<T extends CuaPoint | CuaDragOptions>(
    options: T,
    action: (options: T) => Promise<ActionResult<CuaActionData>>,
  ): Promise<ActionResult<CuaActionData>> {
    const baseline = options.baseline ?? this.#ax.actionBaseline();
    const requested = options.observe ?? "none";
    const observe = requested === "diff" && !baseline ? "state" : requested;
    const result = await action({
      ...options,
      observe,
      ...(observe === "diff" ? { baseline: baseline! } : {}),
      ...(observe === "state" && options.observation === undefined
        ? { observation: { mode: "full", surface: "active", maxChars: AGENT_OBSERVATION_MAX_CHARS } as const }
        : {}),
    });
    if (result.observation) {
      await this.#ax.write(result.observation);
    }
    return result;
  }
}

/**
 * Agent-facing immutable Locator. Mutations default to presenting the
 * ActionResult's existing post-action observation instead of capturing again.
 */
export class AgentLocator {
  readonly #core: Locator;
  readonly #ax: AgentAX;

  constructor(core: Locator, ax: AgentAX) {
    this.#core = core;
    this.#ax = ax;
  }

  get query(): Locator["query"] {
    return this.#core.query;
  }

  filter(filter: AgentLocatorFilter): AgentLocator {
    const { has, ...coreFilter } = filter;
    return this.#wrap(this.#core.filter({
      ...coreFilter,
      ...(has ? { has: has.#core } : {}),
    }));
  }

  locator(selector: string | AgentLocator): AgentLocator {
    return this.#wrap(this.#core.locator(
      typeof selector === "string" ? selector : selector.#core,
    ));
  }

  and(other: AgentLocator): AgentLocator {
    return this.#wrap(this.#core.and(other.#core));
  }

  or(other: AgentLocator): AgentLocator {
    return this.#wrap(this.#core.or(other.#core));
  }

  inFrame(frameId: string): AgentLocator {
    return this.#wrap(this.#core.inFrame(frameId));
  }

  nth(index: number): AgentLocator {
    return this.#wrap(this.#core.nth(index));
  }

  first(): AgentLocator {
    return this.#wrap(this.#core.first());
  }

  last(): AgentLocator {
    return this.#wrap(this.#core.last());
  }

  count(options: OperationOptions = {}): Promise<number> {
    return this.#core.count(options);
  }

  async all(options: OperationOptions = {}): Promise<AgentLocator[]> {
    return (await this.#core.all(options)).map((locator) => this.#wrap(locator));
  }

  async waitFor(options: AgentLocatorWaitOptions = {}): Promise<void> {
    const { write = "state", observation = {}, ...waitOptions } = options;
    await this.#core.waitFor(waitOptions);
    if (write === "state") {
      await this.#ax.write("state", observation);
    }
  }

  elementHandle(options: OperationOptions = {}): Promise<ElementHandle> {
    return this.#core.elementHandle(options);
  }

  click(options: AgentLocatorClickOptions = {}): Promise<LocatorResult> {
    return this.#perform(options, "diff", (coreOptions) => this.#core.click(coreOptions));
  }

  doubleClick(options: AgentLocatorActionOptions = {}): Promise<LocatorResult> {
    return this.#perform(options, "diff", (coreOptions) => this.#core.doubleClick(coreOptions));
  }

  hover(options: AgentLocatorActionOptions = {}): Promise<LocatorResult> {
    return this.#perform(options, "none", (coreOptions) => this.#core.hover(coreOptions));
  }

  wheel(deltaX: number, deltaY: number, options: AgentLocatorActionOptions = {}): Promise<LocatorResult> {
    return this.#perform(options, "none", (coreOptions) => this.#core.wheel(deltaX, deltaY, coreOptions));
  }

  focus(options: AgentLocatorActionOptions = {}): Promise<LocatorResult> {
    return this.#perform(options, "none", (coreOptions) => this.#core.focus(coreOptions));
  }

  scrollIntoView(options: AgentLocatorActionOptions = {}): Promise<LocatorResult> {
    return this.#perform(options, "none", (coreOptions) => this.#core.scrollIntoView(coreOptions));
  }

  fill(value: string, options: AgentLocatorActionOptions = {}): Promise<LocatorResult<TextInputActionData>> {
    return this.#perform(options, "diff", (coreOptions) => this.#core.fill(value, coreOptions));
  }

  type(text: string, options: AgentLocatorTypeOptions = {}): Promise<LocatorResult<TextInputActionData>> {
    const { clear, delayMs, ...actionOptions } = options;
    return this.#perform(actionOptions, "diff", (coreOptions) => this.#core.type(text, {
      ...coreOptions,
      ...(clear === undefined ? {} : { clear }),
      ...(delayMs === undefined ? {} : { delayMs }),
    }));
  }

  async fillAndSelectSuggestion(
    query: string,
    suggestionText: string,
    options: AgentSuggestionCommitOptions = {},
  ): Promise<SuggestionCommitResult> {
    assertAgentOwnedObservation(options);
    const { write = "diff", ...coreOptions } = options;
    const observe = write === "diff" ? "diff" : write === "state" ? "state" : "none";
    const result = await this.#core.fillAndSelectSuggestion(query, suggestionText, {
      ...coreOptions,
      observe,
      ...(observe === "state" && coreOptions.observation === undefined
        ? { observation: { mode: "full", surface: "active", maxChars: AGENT_OBSERVATION_MAX_CHARS } as const }
        : {}),
    });
    if (write === "diff") {
      if (result.selection.observation) {
        await this.#ax.write(result.selection.observation);
      } else {
        await this.#ax.presentActionObservationOutcome(result.selection);
      }
    } else if (write === "state" && result.selection.observation) {
      await this.#ax.write(result.selection.observation);
    }
    return result;
  }

  press(key: string, options: AgentLocatorActionOptions = {}): Promise<LocatorResult> {
    return this.#perform(options, "diff", (coreOptions) => this.#core.press(key, coreOptions));
  }

  check(options: AgentLocatorActionOptions = {}): Promise<LocatorResult> {
    return this.#perform(options, "diff", (coreOptions) => this.#core.check(coreOptions));
  }

  uncheck(options: AgentLocatorActionOptions = {}): Promise<LocatorResult> {
    return this.#perform(options, "diff", (coreOptions) => this.#core.uncheck(coreOptions));
  }

  clear(options: AgentLocatorActionOptions = {}): Promise<LocatorResult> {
    return this.#perform(options, "diff", (coreOptions) => this.#core.clear(coreOptions));
  }

  selectOption(values: string | string[], options: AgentLocatorActionOptions = {}): Promise<LocatorResult> {
    return this.#perform(options, "diff", (coreOptions) => this.#core.selectOption(values, coreOptions));
  }

  setFiles(files: string | string[], options: AgentLocatorActionOptions = {}): Promise<LocatorResult> {
    return this.#perform(options, "diff", (coreOptions) => this.#core.setFiles(files, coreOptions));
  }

  dragTo(target: AgentLocator, options: AgentLocatorActionOptions = {}): Promise<LocatorResult> {
    return this.#perform(options, "diff", (coreOptions) => this.#core.dragTo(target.#core, coreOptions));
  }

  textContent(options: OperationOptions = {}): Promise<string> {
    return this.#core.textContent(options);
  }

  innerText(options: OperationOptions = {}): Promise<string> {
    return this.#core.innerText(options);
  }

  domInvoke<T = unknown>(
    method: string,
    args: unknown[] = [],
    options: AgentLocatorActionOptions = {},
  ): Promise<LocatorResult<{ value?: T }>> {
    return this.#perform(options, "diff", (coreOptions) => this.#core.domInvoke<T>(method, args, coreOptions));
  }

  screenshot(options: OperationOptions = {}): Promise<Screenshot> {
    return this.#core.screenshot(options);
  }

  getAttribute(name: string, options: OperationOptions = {}): Promise<string | null> {
    return this.#core.getAttribute(name, options);
  }

  boundingBox(options: OperationOptions = {}): ReturnType<Locator["boundingBox"]> {
    return this.#core.boundingBox(options);
  }

  isVisible(options: OperationOptions = {}): Promise<boolean> {
    return this.#core.isVisible(options);
  }

  isEnabled(options: OperationOptions = {}): Promise<boolean> {
    return this.#core.isEnabled(options);
  }

  isChecked(options: OperationOptions = {}): Promise<boolean> {
    return this.#core.isChecked(options);
  }

  inputValue(options: OperationOptions = {}): Promise<string> {
    return this.#core.inputValue(options);
  }

  inspect(options: ElementInspectionOptions = {}): Promise<ElementInspection> {
    return this.#core.inspect(options);
  }

  #wrap(locator: Locator): AgentLocator {
    return new AgentLocator(locator, this.#ax);
  }

  async #perform<TData>(
    options: AgentLocatorActionOptions,
    defaultWrite: AgentActionWrite,
    action: (options: LocatorActionOptions) => Promise<LocatorResult<TData>>,
  ): Promise<LocatorResult<TData>> {
    assertAgentOwnedObservation(options);
    const { write = defaultWrite, ...coreOptions } = options;
    const baseline = this.#ax.actionBaseline();
    const observe = write === "diff"
      ? baseline ? "diff" : "state"
      : write === "state"
        ? "state"
        : "none";
    const result = await action({
      ...coreOptions,
      observe,
      ...(observe === "diff" ? { baseline: baseline! } : {}),
      ...(observe === "state" && coreOptions.observation === undefined
        ? { observation: { mode: "full", surface: "active", maxChars: AGENT_OBSERVATION_MAX_CHARS } as const }
        : {}),
    });
    if (write === "diff") {
      if (result.observation) {
        await this.#ax.write(result.observation);
      } else {
        await this.#ax.presentActionObservationOutcome(result);
      }
    } else if (write === "state" && result.observation) {
      await this.#ax.write(result.observation);
    }
    return result;
  }
}

type AgentLocatorFactory =
  | "locator"
  | "getByRole"
  | "getByText"
  | "getByLabel"
  | "getByPlaceholder"
  | "getByAltText"
  | "getByTitle"
  | "getByTestId";

export type AgentTab = Omit<Tab, "ax" | "cua" | AgentLocatorFactory> & {
  readonly ax: AgentAX;
  readonly cua: AgentCUA;
  locator(selector: string): AgentLocator;
  getByRole(role: string, options?: { name?: string; exact?: boolean }): AgentLocator;
  getByText(text: string, options?: { exact?: boolean }): AgentLocator;
  getByLabel(label: string, options?: { exact?: boolean }): AgentLocator;
  getByPlaceholder(placeholder: string, options?: { exact?: boolean }): AgentLocator;
  getByAltText(text: string, options?: { exact?: boolean }): AgentLocator;
  getByTitle(title: string, options?: { exact?: boolean }): AgentLocator;
  getByTestId(testId: string): AgentLocator;
};

const AGENT_LOCATOR_FACTORIES = new Set<PropertyKey>([
  "locator",
  "getByRole",
  "getByText",
  "getByLabel",
  "getByPlaceholder",
  "getByAltText",
  "getByTitle",
  "getByTestId",
]);

type AgentTabCacheEntry = {
  readonly core: Tab;
  readonly wrapped: AgentTab;
};

/** Agent-wrapped tab discovery. Every tab keeps its own presentation baseline. */
export class AgentTabs {
  readonly #core: Browser;
  readonly #presenter: AgentPresenter;
  readonly #documentation: AgentDocumentationRegistry;
  readonly #cache = new Map<string, AgentTabCacheEntry>();

  constructor(
    core: Browser,
    presenter: AgentPresenter,
    documentation: AgentDocumentationRegistry,
  ) {
    this.#core = core;
    this.#presenter = presenter;
    this.#documentation = documentation;
  }

  async list(options: OperationOptions = {}): Promise<AgentTab[]> {
    return Promise.all((await this.#core.tabs.list(options)).map((tab) => this.#wrap(tab, options)));
  }

  async get(targetId: string, options: OperationOptions = {}): Promise<AgentTab> {
    return this.#wrap(await this.#core.tabs.get(targetId, options), options);
  }

  async open(url = "about:blank", options: NavigateOptions = {}): Promise<AgentTab> {
    return this.#wrap(await this.#core.tabs.open(url, options), options);
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.#cache.values()].map(({ wrapped }) => wrapped.ax.dispose()));
    this.#cache.clear();
  }

  async #wrap(core: Tab, options: OperationOptions): Promise<AgentTab> {
    const existing = this.#cache.get(core.id);
    if (existing) {
      await existing.core.refresh(options);
      return existing.wrapped;
    }
    const ax = new AgentAX(core, this.#presenter, this.#documentation);
    const own = { ax, cua: new AgentCUA(core.cua, ax) };
    const documentation = this.#documentation;
    const wrapped = new Proxy(own, {
      get(target, property, receiver) {
        if (Reflect.has(target, property)) {
          return Reflect.get(target, property, receiver);
        }
        const value = Reflect.get(core, property, core) as unknown;
        if (typeof property === "string") {
          const topic = documentationTopicForTabMember(property);
          if (topic && typeof value !== "function") {
            documentation.require(topic, `tab.${property}`);
          }
        }
        if (typeof value !== "function") {
          return value;
        }
        return (...args: unknown[]) => {
          if (typeof property === "string") {
            const topic = documentationTopicForTabCall(property, args);
            if (topic) {
              documentation.require(topic, `tab.${property}()`);
            }
          }
          const result = Reflect.apply(value, core, args);
          return AGENT_LOCATOR_FACTORIES.has(property)
            ? new AgentLocator(result as Locator, own.ax)
            : result;
        };
      },
    }) as AgentTab;
    this.#cache.set(core.id, { core, wrapped });
    return wrapped;
  }
}

export class AgentBrowser {
  readonly identity: BrowserIdentity;
  readonly tabs: AgentTabs;
  readonly diagnostics: Diagnostics;
  readonly #core: Browser;
  readonly #presenter: AgentPresenter;
  readonly #documentation = new AgentDocumentationRegistry();
  readonly #onDisconnect: () => void;

  constructor(core: Browser, presenter: AgentPresenter, onDisconnect: () => void) {
    this.#core = core;
    this.#presenter = presenter;
    this.#onDisconnect = onDisconnect;
    this.identity = core.identity;
    this.tabs = new AgentTabs(core, presenter, this.#documentation);
    this.diagnostics = core.diagnostics;
  }

  get connected(): boolean {
    return this.#core.connected;
  }

  async documentation(topic: AgentDocumentationTopic = "core"): Promise<string> {
    const text = await readDocumentation(topic);
    await this.#presenter.presentText({
      kind: "documentation",
      origin: `ab:${topic}`,
      observationId: null,
      text,
      untrusted: false,
    });
    this.#documentation.markRead(topic);
    return text;
  }

  async disconnect(): Promise<void> {
    try {
      await this.#core.disconnect();
    } finally {
      try {
        // The socket EOF is the authoritative server-side cleanup boundary.
        // Clear any locally retained presentation state without allowing a
        // now-unreachable per-observation dispose request to make disconnect
        // appear unsuccessful.
        await this.tabs.dispose().catch(() => undefined);
      } finally {
        this.#onDisconnect();
      }
    }
  }
}

function documentationTopicForTabMember(property: string): AgentDocumentationTopic | undefined {
  if (property === "cua") return "screenshot";
  return undefined;
}

function documentationTopicForTabCall(
  property: string,
  args: unknown[],
): AgentDocumentationTopic | undefined {
  switch (property) {
    case "screenshot":
      return "screenshot";
    case "frames":
    case "realms":
      return "frames";
    case "evaluate":
      return "evaluate";
    case "cdp":
      return "cdp";
    case "observeNetwork":
      return "network";
    case "observeConsole":
    case "watchDialogs":
      return "console-dialogs";
    case "watchDownloads":
    case "watchFileChoosers":
      return "downloads";
    case "addInitScript":
      return "init-scripts";
    case "observe": {
      const options = args[0];
      return options && typeof options === "object" && "screenshot" in options
        && (options as { screenshot?: unknown }).screenshot === true
        ? "screenshot"
        : undefined;
    }
    default:
      return undefined;
  }
}

let currentAgent: Promise<AgentBrowser> | undefined;

/** Connects the Codex-style Agent facade to the same Core SDK and Rust runtime. */
export function connect(options: AgentConnectOptions = {}): Promise<AgentBrowser> {
  if (currentAgent) {
    return currentAgent;
  }
  const presenter = options.presenter ?? defaultPresenter();
  const connecting = connectCore({
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  }).then((core) => new AgentBrowser(core, presenter, () => {
    if (currentAgent === connecting) {
      currentAgent = undefined;
    }
  }));
  currentAgent = connecting;
  void connecting.catch(() => {
    if (currentAgent === connecting) {
      currentAgent = undefined;
    }
  });
  return connecting;
}

function snapshotOptions(options: AgentWriteOptions): SnapshotOptions {
  return {
    mode: options.mode ?? "full",
    surface: options.surface ?? "active",
    ...(options.frames === undefined ? {} : { frames: options.frames }),
    ...(options.maxDepth === undefined ? {} : { maxDepth: options.maxDepth }),
    maxChars: options.maxChars ?? AGENT_OBSERVATION_MAX_CHARS,
    ...(options.diffFrom === undefined ? {} : { diffFrom: options.diffFrom }),
    ...(options.includeUrls === undefined ? {} : { includeUrls: options.includeUrls }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
}

function agentActionOptions<T extends RefActionOptions>(
  options: T,
  write: AgentActionWrite,
): T {
  assertAgentOwnedObservation(options);
  return {
    ...options,
    ...(write === "diff"
      ? {
          observe: "diff" as const,
        }
      : write === "state"
        ? {
            observe: "state" as const,
            ...(options.observation === undefined
              ? { observation: { mode: "full" as const, surface: "active" as const, maxChars: AGENT_OBSERVATION_MAX_CHARS } }
              : {}),
          }
        : options.observe === undefined
          ? { observe: "none" as const }
          : {}),
  };
}

function assertAgentOwnedObservation(options: object): void {
  if (Object.prototype.hasOwnProperty.call(options, "observe") || Object.prototype.hasOwnProperty.call(options, "baseline")) {
    throw new TypeError("@hanger-source/ab/agent actions own observation identity; use write instead of observe or baseline");
  }
}
