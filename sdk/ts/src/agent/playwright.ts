import type { Screenshot } from "../artifacts/index.js";
import type { Tab as CoreTab } from "../browser/index.js";
import type {
  ElementHandle,
  ElementInspection,
  ElementInspectionOptions,
} from "../elements/index.js";
import {
  Locator as CoreLocator,
  type LocatorActionOptions as CoreLocatorActionOptions,
  type LocatorClickOptions as CoreLocatorClickOptions,
  type LocatorFilter as CoreLocatorFilter,
  type LocatorResult,
  type LocatorWaitOptions as CoreLocatorWaitOptions,
  type SuggestionCommitOptions as CoreSuggestionCommitOptions,
  type SuggestionCommitResult,
} from "../locators/index.js";
import type { TextInputActionData } from "../actions/result.js";
import type { OperationOptions } from "../options.js";
import {
  AX,
  OBSERVATION_MAX_CHARS,
  assertOwnedObservation,
  type ActionWrite,
  type WriteOptions,
} from "./ax.js";

type OwnedActionOptions<T> = Omit<T, "observe" | "baseline">;

export type LocatorActionOptions = OwnedActionOptions<CoreLocatorActionOptions> & {
  write?: ActionWrite;
};

export type LocatorClickOptions = OwnedActionOptions<CoreLocatorClickOptions> & {
  write?: ActionWrite;
};

export type LocatorTypeOptions = LocatorActionOptions & {
  clear?: boolean;
  delayMs?: number;
};

export type SuggestionCommitOptions = OwnedActionOptions<CoreSuggestionCommitOptions> & {
  write?: ActionWrite;
};

export type LocatorWaitOptions = CoreLocatorWaitOptions & {
  /** Present a fresh full state after the semantic wait succeeds. */
  write?: "state" | "none";
  /** Shape and deadline for the post-wait state capture. */
  observation?: WriteOptions;
};

export type LocatorFilter = Omit<CoreLocatorFilter, "has"> & {
  has?: Locator;
};

export type PageWaitOptions = OperationOptions & {
  selector?: string;
  text?: string;
  state?: "attached" | "detached" | "visible" | "hidden";
};

/** Playwright-style semantic queries executed by the AB Rust runtime. */
export class Playwright {
  readonly #core: CoreTab;
  readonly #ax: AX;

  private constructor(core: CoreTab, ax: AX) {
    this.#core = core;
    this.#ax = ax;
  }

  /** @internal */
  static create(core: CoreTab, ax: AX): Playwright {
    return new Playwright(core, ax);
  }

  locator(selector: string): Locator {
    return this.#wrap(this.#core.locator(selector));
  }

  getByRole(role: string, options: { name?: string; exact?: boolean } = {}): Locator {
    return this.#wrap(this.#core.getByRole(role, options));
  }

  getByText(text: string, options: { exact?: boolean } = {}): Locator {
    return this.#wrap(this.#core.getByText(text, options));
  }

  getByLabel(label: string, options: { exact?: boolean } = {}): Locator {
    return this.#wrap(this.#core.getByLabel(label, options));
  }

  getByPlaceholder(placeholder: string, options: { exact?: boolean } = {}): Locator {
    return this.#wrap(this.#core.getByPlaceholder(placeholder, options));
  }

  getByAltText(text: string, options: { exact?: boolean } = {}): Locator {
    return this.#wrap(this.#core.getByAltText(text, options));
  }

  getByTitle(title: string, options: { exact?: boolean } = {}): Locator {
    return this.#wrap(this.#core.getByTitle(title, options));
  }

  getByTestId(testId: string): Locator {
    return this.#wrap(this.#core.getByTestId(testId));
  }

  waitFor(options: PageWaitOptions): Promise<void> {
    return this.#core.waitFor(options);
  }

  #wrap(locator: CoreLocator): Locator {
    return Locator.create(locator, this.#ax);
  }
}

/** Immutable semantic Locator with Agent-owned action presentation. */
export class Locator {
  readonly #core: CoreLocator;
  readonly #ax: AX;

  private constructor(core: CoreLocator, ax: AX) {
    this.#core = core;
    this.#ax = ax;
  }

  /** @internal */
  static create(core: CoreLocator, ax: AX): Locator {
    return new Locator(core, ax);
  }

  get query(): CoreLocator["query"] {
    return this.#core.query;
  }

  filter(filter: LocatorFilter): Locator {
    const { has, ...coreFilter } = filter;
    return this.#wrap(this.#core.filter({
      ...coreFilter,
      ...(has ? { has: has.#core } : {}),
    }));
  }

  locator(selector: string | Locator): Locator {
    return this.#wrap(this.#core.locator(
      typeof selector === "string" ? selector : selector.#core,
    ));
  }

  and(other: Locator): Locator {
    return this.#wrap(this.#core.and(other.#core));
  }

  or(other: Locator): Locator {
    return this.#wrap(this.#core.or(other.#core));
  }

  inFrame(frameId: string): Locator {
    return this.#wrap(this.#core.inFrame(frameId));
  }

  nth(index: number): Locator {
    return this.#wrap(this.#core.nth(index));
  }

  first(): Locator {
    return this.#wrap(this.#core.first());
  }

  last(): Locator {
    return this.#wrap(this.#core.last());
  }

  count(options: OperationOptions = {}): Promise<number> {
    return this.#core.count(options);
  }

  async all(options: OperationOptions = {}): Promise<Locator[]> {
    return (await this.#core.all(options)).map((locator) => this.#wrap(locator));
  }

  async waitFor(options: LocatorWaitOptions = {}): Promise<void> {
    const { write = "state", observation = {}, ...waitOptions } = options;
    await this.#core.waitFor(waitOptions);
    if (write === "state") await this.#ax.write("state", observation);
  }

  elementHandle(options: OperationOptions = {}): Promise<ElementHandle> {
    return this.#core.elementHandle(options);
  }

  click(options: LocatorClickOptions = {}): Promise<LocatorResult> {
    return this.#perform(options, "diff", (coreOptions) => this.#core.click(coreOptions));
  }

  doubleClick(options: LocatorActionOptions = {}): Promise<LocatorResult> {
    return this.#perform(options, "diff", (coreOptions) => this.#core.doubleClick(coreOptions));
  }

  hover(options: LocatorActionOptions = {}): Promise<LocatorResult> {
    return this.#perform(options, "none", (coreOptions) => this.#core.hover(coreOptions));
  }

  wheel(deltaX: number, deltaY: number, options: LocatorActionOptions = {}): Promise<LocatorResult> {
    return this.#perform(options, "none", (coreOptions) => this.#core.wheel(deltaX, deltaY, coreOptions));
  }

  focus(options: LocatorActionOptions = {}): Promise<LocatorResult> {
    return this.#perform(options, "none", (coreOptions) => this.#core.focus(coreOptions));
  }

  scrollIntoView(options: LocatorActionOptions = {}): Promise<LocatorResult> {
    return this.#perform(options, "none", (coreOptions) => this.#core.scrollIntoView(coreOptions));
  }

  async fill(value: string, options: LocatorActionOptions = {}): Promise<LocatorResult<TextInputActionData>> {
    const result = await this.#perform(options, "diff", (coreOptions) => this.#core.fill(value, coreOptions));
    await this.#ax.presentTextInputOutcome(result);
    return result;
  }

  async type(text: string, options: LocatorTypeOptions = {}): Promise<LocatorResult<TextInputActionData>> {
    const { clear, delayMs, ...actionOptions } = options;
    const result = await this.#perform(actionOptions, "diff", (coreOptions) => this.#core.type(text, {
      ...coreOptions,
      ...(clear === undefined ? {} : { clear }),
      ...(delayMs === undefined ? {} : { delayMs }),
    }));
    await this.#ax.presentTextInputOutcome(result);
    return result;
  }

  async fillAndSelectSuggestion(
    query: string,
    suggestionText: string,
    options: SuggestionCommitOptions = {},
  ): Promise<SuggestionCommitResult> {
    assertOwnedObservation(options);
    const { write = "diff", ...coreOptions } = options;
    const observe = write === "diff" ? "diff" : write === "state" ? "state" : "none";
    const result = await this.#core.fillAndSelectSuggestion(query, suggestionText, {
      ...coreOptions,
      observe,
      ...(observe === "state" && coreOptions.observation === undefined
        ? { observation: { mode: "full", surface: "active", maxChars: OBSERVATION_MAX_CHARS } as const }
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

  press(key: string, options: LocatorActionOptions = {}): Promise<LocatorResult> {
    return this.#perform(options, "diff", (coreOptions) => this.#core.press(key, coreOptions));
  }

  check(options: LocatorActionOptions = {}): Promise<LocatorResult> {
    return this.#perform(options, "diff", (coreOptions) => this.#core.check(coreOptions));
  }

  uncheck(options: LocatorActionOptions = {}): Promise<LocatorResult> {
    return this.#perform(options, "diff", (coreOptions) => this.#core.uncheck(coreOptions));
  }

  clear(options: LocatorActionOptions = {}): Promise<LocatorResult> {
    return this.#perform(options, "diff", (coreOptions) => this.#core.clear(coreOptions));
  }

  selectOption(values: string | string[], options: LocatorActionOptions = {}): Promise<LocatorResult> {
    return this.#perform(options, "diff", (coreOptions) => this.#core.selectOption(values, coreOptions));
  }

  setFiles(files: string | string[], options: LocatorActionOptions = {}): Promise<LocatorResult> {
    return this.#perform(options, "diff", (coreOptions) => this.#core.setFiles(files, coreOptions));
  }

  dragTo(target: Locator, options: LocatorActionOptions = {}): Promise<LocatorResult> {
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
    options?: LocatorActionOptions,
  ): Promise<LocatorResult<{ value?: T }>>;
  domInvoke<T = unknown>(
    method: string,
    args: unknown[],
    options?: LocatorActionOptions,
  ): Promise<LocatorResult<{ value?: T }>>;
  domInvoke<T = unknown>(
    method: string,
    argsOrOptions: unknown[] | LocatorActionOptions = [],
    options: LocatorActionOptions = {},
  ): Promise<LocatorResult<{ value?: T }>> {
    const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
    const actionOptions = Array.isArray(argsOrOptions) ? options : argsOrOptions;
    return this.#perform(actionOptions, "diff", (coreOptions) => this.#core.domInvoke<T>(method, args, coreOptions));
  }

  screenshot(options: OperationOptions = {}): Promise<Screenshot> {
    return this.#core.screenshot(options);
  }

  getAttribute(name: string, options: OperationOptions = {}): Promise<string | null> {
    return this.#core.getAttribute(name, options);
  }

  boundingBox(options: OperationOptions = {}): ReturnType<CoreLocator["boundingBox"]> {
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

  #wrap(locator: CoreLocator): Locator {
    return Locator.create(locator, this.#ax);
  }

  async #perform<TData>(
    options: LocatorActionOptions,
    defaultWrite: ActionWrite,
    action: (options: CoreLocatorActionOptions) => Promise<LocatorResult<TData>>,
  ): Promise<LocatorResult<TData>> {
    assertOwnedObservation(options);
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
        ? { observation: { mode: "full", surface: "active", maxChars: OBSERVATION_MAX_CHARS } as const }
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
