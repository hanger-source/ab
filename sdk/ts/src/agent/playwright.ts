import type { Screenshot } from "../artifacts/index.js";
import type { LoadState, Tab as CoreTab } from "../browser/index.js";
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
  assertAgentActionOptions,
} from "./ax.js";

type AgentActionOptions<T> = Omit<T, "observe" | "baseline" | "observation">;

export type LocatorActionOptions = AgentActionOptions<CoreLocatorActionOptions>;

export type LocatorClickOptions = AgentActionOptions<CoreLocatorClickOptions>;

export type LocatorTypeOptions = LocatorActionOptions & {
  clear?: boolean;
  delayMs?: number;
};

export type SuggestionCommitOptions = AgentActionOptions<CoreSuggestionCommitOptions>;

export type LocatorWaitOptions = CoreLocatorWaitOptions;

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

  /** Waits for one explicit URL postcondition without presenting page state. */
  waitForURL(url: string, options: OperationOptions = {}): Promise<void> {
    return this.#core.waitForURL(url, options);
  }

  /**
   * Waits for readiness of the current document without anticipating a future navigation
   * or implying application/business completion.
   */
  waitForLoadState(state: LoadState = "load", options: OperationOptions = {}): Promise<void> {
    return this.#core.waitForLoadState(state, options);
  }

  #wrap(locator: CoreLocator): Locator {
    return Locator.create(locator, this.#ax);
  }
}

/**
 * Immutable semantic Locator with explicit post-action waits and observations.
 * Design evidence:
 * `docs/evidence/20260902__action-wait-observation-ownership-audit__@codex.md`.
 */
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
    await this.#core.waitFor(options);
  }

  elementHandle(options: OperationOptions = {}): Promise<ElementHandle> {
    return this.#core.elementHandle(options);
  }

  click(options: LocatorClickOptions = {}): Promise<LocatorResult> {
    return this.#perform(options, (coreOptions) => this.#core.click(coreOptions));
  }

  doubleClick(options: LocatorActionOptions = {}): Promise<LocatorResult> {
    return this.#perform(options, (coreOptions) => this.#core.doubleClick(coreOptions));
  }

  hover(options: LocatorActionOptions = {}): Promise<LocatorResult> {
    return this.#perform(options, (coreOptions) => this.#core.hover(coreOptions));
  }

  wheel(deltaX: number, deltaY: number, options: LocatorActionOptions = {}): Promise<LocatorResult> {
    return this.#perform(options, (coreOptions) => this.#core.wheel(deltaX, deltaY, coreOptions));
  }

  focus(options: LocatorActionOptions = {}): Promise<LocatorResult> {
    return this.#perform(options, (coreOptions) => this.#core.focus(coreOptions));
  }

  scrollIntoView(options: LocatorActionOptions = {}): Promise<LocatorResult> {
    return this.#perform(options, (coreOptions) => this.#core.scrollIntoView(coreOptions));
  }

  async fill(value: string, options: LocatorActionOptions = {}): Promise<LocatorResult<TextInputActionData>> {
    const result = await this.#perform(options, (coreOptions) => this.#core.fill(value, coreOptions));
    await this.#ax.presentTextInputOutcome(result);
    return result;
  }

  async type(text: string, options: LocatorTypeOptions = {}): Promise<LocatorResult<TextInputActionData>> {
    const { clear, delayMs, ...actionOptions } = options;
    const result = await this.#perform(actionOptions, (coreOptions) => this.#core.type(text, {
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
    assertAgentActionOptions(options);
    const result = await this.#core.fillAndSelectSuggestion(query, suggestionText, {
      ...options,
      observe: "none",
    });
    this.#ax.applyActionResult(result.selection);
    return result;
  }

  press(key: string, options: LocatorActionOptions = {}): Promise<LocatorResult> {
    return this.#perform(options, (coreOptions) => this.#core.press(key, coreOptions));
  }

  check(options: LocatorActionOptions = {}): Promise<LocatorResult> {
    return this.#perform(options, (coreOptions) => this.#core.check(coreOptions));
  }

  uncheck(options: LocatorActionOptions = {}): Promise<LocatorResult> {
    return this.#perform(options, (coreOptions) => this.#core.uncheck(coreOptions));
  }

  clear(options: LocatorActionOptions = {}): Promise<LocatorResult> {
    return this.#perform(options, (coreOptions) => this.#core.clear(coreOptions));
  }

  selectOption(values: string | string[], options: LocatorActionOptions = {}): Promise<LocatorResult> {
    return this.#perform(options, (coreOptions) => this.#core.selectOption(values, coreOptions));
  }

  setFiles(files: string | string[], options: LocatorActionOptions = {}): Promise<LocatorResult> {
    return this.#perform(options, (coreOptions) => this.#core.setFiles(files, coreOptions));
  }

  dragTo(target: Locator, options: LocatorActionOptions = {}): Promise<LocatorResult> {
    return this.#perform(options, (coreOptions) => this.#core.dragTo(target.#core, coreOptions));
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
    return this.#perform(actionOptions, (coreOptions) => this.#core.domInvoke<T>(method, args, coreOptions));
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
    action: (options: CoreLocatorActionOptions) => Promise<LocatorResult<TData>>,
  ): Promise<LocatorResult<TData>> {
    assertAgentActionOptions(options);
    const result = await action({
      ...options,
      observe: "none",
    });
    this.#ax.applyActionResult(result);
    return result;
  }
}
