import { ABError } from "../errors/index.js";
import type { Screenshot, ScreenshotScale } from "../artifacts/index.js";
import type { PageObservation, Tab as CoreTab } from "../browser/index.js";
import {
  type ActionResult,
  type AXRef,
  type AXState,
  type ClickOptions,
  type RefActionOptions as CoreRefActionOptions,
  type SnapshotOptions,
  type TypeOptions,
} from "../ax/index.js";
import type { TextInputActionData } from "../actions/result.js";
import type { DocumentationRegistry } from "./documentation.js";
import type { Presenter } from "./presentation.js";

/** @internal */
export const OBSERVATION_MAX_CHARS = 24_000;

export type AXContent = "state" | "screenshot" | "both";

export type WriteOptions = SnapshotOptions & {
  fullPage?: boolean;
  scale?: ScreenshotScale;
};

export type ActionWrite = "diff" | "state" | "none";

type OwnedActionOptions<T> = Omit<T, "observe" | "baseline">;

export type RefActionOptions = OwnedActionOptions<CoreRefActionOptions> & {
  write?: ActionWrite;
};

export type ClickActionOptions = OwnedActionOptions<ClickOptions> & {
  write?: ActionWrite;
};

export type TypeActionOptions = OwnedActionOptions<TypeOptions> & {
  write?: ActionWrite;
};

export class AX {
  readonly #tab: CoreTab;
  readonly #presenter: Presenter;
  readonly #documentation: DocumentationRegistry;
  #lastPresentedState: AXState | null = null;

  private constructor(
    tab: CoreTab,
    presenter: Presenter,
    documentation: DocumentationRegistry,
  ) {
    this.#tab = tab;
    this.#presenter = presenter;
    this.#documentation = documentation;
  }

  /** @internal */
  static create(tab: CoreTab, presenter: Presenter, documentation: DocumentationRegistry): AX {
    return new AX(tab, presenter, documentation);
  }

  get(content: "state", options?: WriteOptions): Promise<AXState>;
  get(content: "screenshot", options?: WriteOptions): Promise<Screenshot>;
  get(content: "both", options?: WriteOptions): Promise<PageObservation>;
  async get(
    content: AXContent,
    options: WriteOptions = {},
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

  write(content: AXContent, options?: WriteOptions): Promise<void>;
  write(state: AXState): Promise<void>;
  async write(
    content: AXContent | AXState,
    options: WriteOptions = {},
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

  click(refId: string, options: ClickActionOptions = {}): Promise<ActionResult> {
    const { write = "diff", ...action } = options;
    return this.#perform(refId, write, (ref) => ref.click(actionOptions(action, write)));
  }

  doubleClick(refId: string, options: RefActionOptions = {}): Promise<ActionResult> {
    const { write = "diff", ...action } = options;
    return this.#perform(refId, write, (ref) => ref.doubleClick(actionOptions(action, write)));
  }

  hover(refId: string, options: RefActionOptions = {}): Promise<ActionResult> {
    const { write = "none", ...action } = options;
    return this.#perform(refId, write, (ref) => ref.hover(actionOptions(action, write)));
  }

  wheel(
    refId: string,
    deltaX: number,
    deltaY: number,
    options: RefActionOptions = {},
  ): Promise<ActionResult> {
    const { write = "none", ...action } = options;
    return this.#perform(refId, write, (ref) => ref.wheel(deltaX, deltaY, actionOptions(action, write)));
  }

  fill(refId: string, value: string, options: RefActionOptions = {}): Promise<ActionResult<TextInputActionData>> {
    const { write = "diff", ...action } = options;
    return this.#perform(refId, write, (ref) => ref.fill(value, actionOptions(action, write)));
  }

  type(refId: string, text: string, options: TypeActionOptions = {}): Promise<ActionResult<TextInputActionData>> {
    const { write = "diff", ...action } = options;
    return this.#perform(refId, write, (ref) => ref.type(text, actionOptions(action, write)));
  }

  press(refId: string, key: string, options: RefActionOptions = {}): Promise<ActionResult> {
    const { write = "diff", ...action } = options;
    return this.#perform(refId, write, (ref) => ref.press(key, actionOptions(action, write)));
  }

  focus(refId: string, options: RefActionOptions = {}): Promise<ActionResult> {
    const { write = "none", ...action } = options;
    return this.#perform(refId, write, (ref) => ref.focus(actionOptions(action, write)));
  }

  clear(refId: string, options: RefActionOptions = {}): Promise<ActionResult> {
    const { write = "diff", ...action } = options;
    return this.#perform(refId, write, (ref) => ref.clear(actionOptions(action, write)));
  }

  check(refId: string, options: RefActionOptions = {}): Promise<ActionResult> {
    const { write = "diff", ...action } = options;
    return this.#perform(refId, write, (ref) => ref.check(actionOptions(action, write)));
  }

  uncheck(refId: string, options: RefActionOptions = {}): Promise<ActionResult> {
    const { write = "diff", ...action } = options;
    return this.#perform(refId, write, (ref) => ref.uncheck(actionOptions(action, write)));
  }

  selectOption(
    refId: string,
    values: string | string[],
    options: RefActionOptions = {},
  ): Promise<ActionResult> {
    const { write = "diff", ...action } = options;
    return this.#perform(refId, write, (ref) => ref.selectOption(values, actionOptions(action, write)));
  }

  setFiles(
    refId: string,
    files: string | string[],
    options: RefActionOptions = {},
  ): Promise<ActionResult> {
    const { write = "diff", ...action } = options;
    return this.#perform(refId, write, (ref) => ref.setFiles(files, actionOptions(action, write)));
  }

  dragTo(
    sourceRefId: string,
    targetRefId: string,
    options: RefActionOptions = {},
  ): Promise<ActionResult> {
    const { write = "diff", ...action } = options;
    return this.#perform(sourceRefId, write, (source) => source.dragTo(
      this.#ref(targetRefId),
      actionOptions(action, write),
    ));
  }

  scrollIntoView(refId: string, options: RefActionOptions = {}): Promise<ActionResult> {
    const { write = "none", ...action } = options;
    return this.#perform(refId, write, (ref) => ref.scrollIntoView(actionOptions(action, write)));
  }

  /** @internal */
  async dispose(): Promise<void> {
    const state = this.#lastPresentedState;
    this.#lastPresentedState = null;
    await state?.dispose();
  }

  /** The exact observation currently visible to this Agent session. */
  /** @internal */
  actionBaseline(): AXState | null {
    return this.#lastPresentedState;
  }

  /** @internal */
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
    write: ActionWrite,
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
    if (previous && previous !== state) await previous.dispose();
  }
}

function snapshotOptions(options: WriteOptions): SnapshotOptions {
  return {
    mode: options.mode ?? "full",
    surface: options.surface ?? "active",
    ...(options.frames === undefined ? {} : { frames: options.frames }),
    ...(options.maxDepth === undefined ? {} : { maxDepth: options.maxDepth }),
    maxChars: options.maxChars ?? OBSERVATION_MAX_CHARS,
    ...(options.diffFrom === undefined ? {} : { diffFrom: options.diffFrom }),
    ...(options.includeUrls === undefined ? {} : { includeUrls: options.includeUrls }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
}

function actionOptions<T extends CoreRefActionOptions>(options: T, write: ActionWrite): T {
  assertOwnedObservation(options);
  return {
    ...options,
    ...(write === "diff"
      ? { observe: "diff" as const }
      : write === "state"
        ? {
            observe: "state" as const,
            ...(options.observation === undefined
              ? { observation: { mode: "full" as const, surface: "active" as const, maxChars: OBSERVATION_MAX_CHARS } }
              : {}),
          }
        : { observe: "none" as const }),
  };
}

/** @internal */
export function assertOwnedObservation(options: object): void {
  if (Object.prototype.hasOwnProperty.call(options, "observe") || Object.prototype.hasOwnProperty.call(options, "baseline")) {
    throw new TypeError("@hanger-source/ab/agent actions own observation identity; use write instead of observe or baseline");
  }
}
