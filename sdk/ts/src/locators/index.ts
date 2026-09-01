import { inspect } from "node:util";
import { Screenshot, type ScreenshotWire } from "../artifacts/index.js";
import {
  ElementHandle,
  type ElementHandleDescriptor,
  type ElementInspection,
  type ElementInspectionOptions,
} from "../elements/index.js";
import { AX, AXState, type AXRef } from "../ax/index.js";
import { ABError } from "../errors/index.js";
import type {
  ActionOptions,
  ActionResult,
  ActionWire,
  TextInputActionData,
} from "../actions/result.js";
import type { ProtocolClient } from "../transport/index.js";
import type { OperationOptions } from "../options.js";
import type { LocatorQuery } from "../protocol.js";

export type { LocatorQuery } from "../protocol.js";

export type LocatorActionOptions = OperationOptions & ActionOptions;

export type LocatorClickOptions = LocatorActionOptions & {
  button?: "left" | "middle" | "right";
  clickCount?: number;
};

export type LocatorWaitOptions = OperationOptions & {
  state?: "attached" | "detached" | "visible" | "hidden";
};

export type LocatorFilter = {
  visible?: boolean;
  has?: Locator;
  hasText?: string;
  exact?: boolean;
};

export type LocatorResult<TData = unknown> = ActionResult<TData>;

export type SuggestionCommitOptions = LocatorActionOptions & {
  expectedValue?: string;
  exact?: boolean;
  suggestionExact?: boolean;
};

export type SuggestionCommitResult = {
  input: LocatorResult<TextInputActionData>;
  selection: LocatorResult;
  suggestion: Pick<AXRef, "observationId" | "id" | "role" | "name">;
  committedValue: string;
};

/**
 * An immutable semantic query plan evaluated by Rust against the current page.
 * Builders do not touch the browser; strict reads and actions resolve on use.
 */
export class Locator {
  readonly query: LocatorQuery;
  readonly #client: ProtocolClient;
  readonly #tabId: string;
  readonly #index: number | undefined;
  readonly #visible: boolean | undefined;

  constructor(
    client: ProtocolClient,
    tabId: string,
    query: LocatorQuery,
    options: { index?: number; visible?: boolean } = {},
  ) {
    this.#client = client;
    this.#tabId = tabId;
    this.query = freezeQuery(query);
    this.#index = options.index;
    this.#visible = options.visible;
  }

  /** Adds relational, textual, or visibility filters without mutating this locator. */
  filter(filter: LocatorFilter): Locator {
    const visible = filter.visible ?? this.#visible;
    let query = this.query;
    if (filter.has) {
      this.#assertCompatible(filter.has);
      query = { kind: "has", query, descendant: filter.has.query };
    }
    if (filter.hasText !== undefined) {
      query = { kind: "hasText", query, value: filter.hasText, exact: filter.exact ?? false };
    }
    return new Locator(this.#client, this.#tabId, query, {
      ...(this.#index === undefined ? {} : { index: this.#index }),
      ...(visible === undefined ? {} : { visible }),
    });
  }

  /** Scopes another CSS or semantic locator to descendants of this locator. */
  locator(selector: string | Locator): Locator {
    const descendant = typeof selector === "string"
      ? new Locator(this.#client, this.#tabId, { kind: "css", value: selector })
      : selector;
    this.#assertCompatible(descendant);
    return new Locator(this.#client, this.#tabId, {
      kind: "descendant",
      ancestor: this.query,
      descendant: descendant.query,
    });
  }

  /** Intersects this query with another locator from the same tab. */
  and(other: Locator): Locator {
    this.#assertCompatible(other);
    return new Locator(this.#client, this.#tabId, { kind: "and", left: this.query, right: other.query });
  }

  /** Unions this query with another locator from the same tab. */
  or(other: Locator): Locator {
    this.#assertCompatible(other);
    return new Locator(this.#client, this.#tabId, { kind: "or", left: this.query, right: other.query });
  }

  /** Restricts this query to an explicit frame identity. */
  inFrame(frameId: string): Locator {
    return new Locator(this.#client, this.#tabId, { kind: "frame", frameId, query: this.query });
  }

  nth(index: number): Locator {
    if (!Number.isInteger(index)) {
      throw new TypeError("Locator.nth(index) requires an integer");
    }
    return new Locator(this.#client, this.#tabId, this.query, {
      index,
      ...(this.#visible === undefined ? {} : { visible: this.#visible }),
    });
  }

  first(): Locator {
    return this.nth(0);
  }

  last(): Locator {
    return this.nth(-1);
  }

  async count(options: OperationOptions = {}): Promise<number> {
    const value = await this.#execute<{ count?: number }>(
      "count",
      {},
      options,
    );
    return value.count ?? 0;
  }

  async all(options: OperationOptions = {}): Promise<Locator[]> {
    const count = await this.count(options);
    return Array.from({ length: count }, (_, index) => this.nth(index));
  }

  async waitFor(options: LocatorWaitOptions = {}): Promise<void> {
    await this.#execute(
      "waitFor",
      { state: options.state ?? "visible" },
      options,
    );
  }

  /** Resolves once and creates a server-owned handle to the exact node. */
  async elementHandle(options: OperationOptions = {}): Promise<ElementHandle> {
    const descriptor = await this.#client.request<ElementHandleDescriptor>(
      "element.createFromLocator",
      {
        query: this.query,
        ...(this.#index === undefined ? {} : { index: this.#index }),
        ...(this.#visible === undefined ? {} : { visible: this.#visible }),
        operation: "elementHandle",
        arguments: {},
      },
      { target: { tabId: this.#tabId }, ...options },
    );
    return new ElementHandle(this.#client, descriptor);
  }

  click(options: LocatorClickOptions = {}): Promise<LocatorResult> {
    return this.#act("click", {
      button: options.button ?? "left",
      clickCount: options.clickCount ?? 1,
    }, options);
  }

  doubleClick(options: LocatorActionOptions = {}): Promise<LocatorResult> {
    return this.#act("dblclick", {}, options);
  }

  hover(options: LocatorActionOptions = {}): Promise<LocatorResult> {
    return this.#act("hover", {}, options);
  }

  wheel(deltaX: number, deltaY: number, options: LocatorActionOptions = {}): Promise<LocatorResult> {
    return this.#act("wheel", { deltaX, deltaY }, options);
  }

  focus(options: LocatorActionOptions = {}): Promise<LocatorResult> {
    return this.#act("focus", {}, options);
  }

  scrollIntoView(options: LocatorActionOptions = {}): Promise<LocatorResult> {
    return this.#act("scrollintoview", {}, options);
  }

  fill(value: string, options: LocatorActionOptions = {}): Promise<LocatorResult<TextInputActionData>> {
    return this.#act("fill", { value }, options);
  }

  type(
    text: string,
    options: LocatorActionOptions & { clear?: boolean; delayMs?: number } = {},
  ): Promise<LocatorResult<TextInputActionData>> {
    return this.#act("type", {
      text,
      clear: options.clear ?? false,
      ...(options.delayMs === undefined ? {} : { delay: options.delayMs }),
    }, options);
  }

  /** Completes one popup-backed input commit without exposing an intermediate ref lifecycle. */
  async fillAndSelectSuggestion(
    query: string,
    suggestionText: string,
    options: SuggestionCommitOptions = {},
  ): Promise<SuggestionCommitResult> {
    const {
      expectedValue,
      exact = false,
      suggestionExact = false,
      ...actionOptions
    } = options;
    const deadline = Date.now() + (actionOptions.timeoutMs ?? 30_000);
    const remainingOptions = (): OperationOptions => {
      const timeoutMs = deadline - Date.now();
      if (timeoutMs <= 0) {
        throw new ABError({
          kind: "timeout",
          stage: "sdk.locator.autocomplete",
          message: `autocomplete suggestion ${JSON.stringify(suggestionText)} did not become actionable before the operation deadline`,
        });
      }
      return {
        timeoutMs,
        ...(actionOptions.signal === undefined ? {} : { signal: actionOptions.signal }),
      };
    };
    const ax = new AX(this.#client, this.#tabId);
    const surface = actionOptions.observation?.surface ?? "document";
    const baseline = await ax.snapshot({ mode: "interactive", surface, ...remainingOptions() });
    let suggestionState: AXState | null = null;
    try {
      const input = await this.fill(query, { ...remainingOptions(), observe: "none" });
      if (!input.data.field.popupBacked || input.data.field.next !== "selectSuggestion") {
        throw new ABError({
          kind: "autocomplete_expected",
          stage: "sdk.locator.autocomplete",
          message: "fillAndSelectSuggestion requires a popup-backed field",
          details: { field: input.data.field },
        });
      }

      const baselineRefs = new Set(baseline.refs().map((ref) => ref.id));
      let suggestion: AXRef | null = null;
      while (!suggestion) {
        const state = await ax.snapshot({
          mode: "interactive",
          surface,
          diffFrom: baseline,
          ...remainingOptions(),
        });
        const addedRefs = new Set(state.diff?.addedRefs ?? []);
        const candidates = state.refs().filter((ref) => {
          const newlyAdded = addedRefs.size > 0
            ? addedRefs.has(ref.id)
            : !baselineRefs.has(ref.id);
          return newlyAdded
            && ref.backendNodeId !== null
            && ref.bounds !== null
            && ref.bounds.width > 0
            && ref.bounds.height > 0
            && matchesSuggestion(ref.name, suggestionText, suggestionExact);
        });
        const exactCandidates = candidates.filter((ref) => matchesSuggestion(ref.name, suggestionText, true));
        const matchingPool = exactCandidates.length > 0 ? exactCandidates : candidates;
        const itemCandidates = matchingPool.filter((ref) => isSuggestionItemRole(ref.role));
        const resolved = itemCandidates.length === 1
          ? itemCandidates[0]
          : matchingPool.length === 1
            ? matchingPool[0]
            : null;
        if (resolved) {
          suggestionState = state;
          suggestion = resolved;
          break;
        }
        const ambiguousCandidates = itemCandidates.length > 1 ? itemCandidates : matchingPool;
        if (ambiguousCandidates.length > 1) {
          await state.dispose(remainingOptions());
          throw new ABError({
            kind: "strict_violation",
            stage: "sdk.locator.autocomplete",
            message: `autocomplete suggestion ${JSON.stringify(suggestionText)} matched ${ambiguousCandidates.length} newly presented item refs`,
            details: { candidates: ambiguousCandidates.map(({ id, role, name }) => ({ id, role, name })) },
          });
        }
        await state.dispose(remainingOptions());
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      const suggestionIdentity = {
        observationId: suggestion.observationId,
        id: suggestion.id,
        role: suggestion.role,
        name: suggestion.name,
      };
      const selection = await suggestion.click({
        ...actionOptions,
        ...remainingOptions(),
      });
      const committedValue = await this.inputValue(remainingOptions());
      if (expectedValue !== undefined) {
        const matched = exact
          ? committedValue === expectedValue
          : committedValue.includes(expectedValue);
        if (!matched) {
          throw new ABError({
            kind: "autocomplete_commit_mismatch",
            stage: "sdk.locator.autocomplete",
            message: `autocomplete committed ${JSON.stringify(committedValue)}; expected ${exact ? "exactly " : "to include "}${JSON.stringify(expectedValue)}`,
            details: { committedValue, expectedValue, exact, suggestion: suggestionIdentity },
          });
        }
      }
      return { input, selection, suggestion: suggestionIdentity, committedValue };
    } finally {
      await Promise.allSettled([
        ...(suggestionState ? [suggestionState.dispose({ timeoutMs: 2_000 })] : []),
        baseline.dispose({ timeoutMs: 2_000 }),
      ]);
    }
  }

  press(key: string, options: LocatorActionOptions = {}): Promise<LocatorResult> {
    return this.#act("press", { key }, options);
  }

  check(options: LocatorActionOptions = {}): Promise<LocatorResult> {
    return this.#act("check", {}, options);
  }

  uncheck(options: LocatorActionOptions = {}): Promise<LocatorResult> {
    return this.#act("uncheck", {}, options);
  }

  clear(options: LocatorActionOptions = {}): Promise<LocatorResult> {
    return this.#act("clear", {}, options);
  }

  selectOption(
    values: string | string[],
    options: LocatorActionOptions = {},
  ): Promise<LocatorResult> {
    return this.#act("select", {
      values: Array.isArray(values) ? values : [values],
    }, options);
  }

  setFiles(files: string | string[], options: LocatorActionOptions = {}): Promise<LocatorResult> {
    return this.#act("upload", {
      files: Array.isArray(files) ? files : [files],
    }, options);
  }

  dragTo(target: Locator, options: LocatorActionOptions = {}): Promise<LocatorResult> {
    this.#assertCompatible(target);
    return this.#act("drag", {
      target: {
        query: target.query,
        ...(target.#index === undefined ? {} : { index: target.#index }),
        ...(target.#visible === undefined ? {} : { visible: target.#visible }),
        operation: "resolve",
        arguments: {},
      },
    }, options);
  }

  async textContent(options: OperationOptions = {}): Promise<string> {
    const value = await this.#read("text", options);
    return typeof value === "string" ? value : String(value ?? "");
  }

  async innerText(options: OperationOptions = {}): Promise<string> {
    const value = await this.#execute<{ text?: unknown }>("innertext", {}, options);
    return typeof value.text === "string" ? value.text : String(value.text ?? "");
  }

  domInvoke<T = unknown>(
    method: string,
    args: unknown[] = [],
    options: LocatorActionOptions = {},
  ): Promise<LocatorResult<{ value?: T }>> {
    return this.#act("dominvoke", { method, args }, options);
  }

  async screenshot(options: OperationOptions = {}): Promise<Screenshot> {
    return new Screenshot(this.#client, await this.#execute<ScreenshotWire>("screenshot", {}, options));
  }

  async getAttribute(name: string, options: OperationOptions = {}): Promise<string | null> {
    const value = await this.#execute<{ value?: string | null }>(
      "getattribute",
      { attribute: name },
      options,
    );
    return value.value ?? null;
  }

  async boundingBox(options: OperationOptions = {}): Promise<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null> {
    const value = await this.#execute<{
      x?: number;
      y?: number;
      width?: number;
      height?: number;
    } | null>(
      "boundingbox",
      {},
      options,
    );
    if (!value || value.x === undefined || value.y === undefined || value.width === undefined || value.height === undefined) {
      return null;
    }
    return { x: value.x, y: value.y, width: value.width, height: value.height };
  }

  async isVisible(options: OperationOptions = {}): Promise<boolean> {
    const value = await this.#execute<{ value?: unknown }>("isvisible", {}, options);
    return value.value === true;
  }

  async isEnabled(options: OperationOptions = {}): Promise<boolean> {
    const value = await this.#execute<{ value?: unknown }>("isenabled", {}, options);
    return value.value === true;
  }

  async isChecked(options: OperationOptions = {}): Promise<boolean> {
    const value = await this.#execute<{ value?: unknown }>("ischecked", {}, options);
    return value.value === true;
  }

  async inputValue(options: OperationOptions = {}): Promise<string> {
    const value = await this.#execute<{ value?: unknown }>("inputvalue", {}, options);
    return typeof value.value === "string" ? value.value : String(value.value ?? "");
  }

  inspect(options: ElementInspectionOptions = {}): Promise<ElementInspection> {
    const { attributes = [], ...operationOptions } = options;
    return this.#execute("inspect", { attributes }, operationOptions);
  }

  [inspect.custom](): string {
    const index = this.#index === undefined ? "" : `.nth(${this.#index})`;
    return `Locator ${JSON.stringify(this.query)}${index}`;
  }

  async #act<TData = unknown>(
    action: string,
    extra: Record<string, unknown>,
    options: LocatorActionOptions,
  ): Promise<LocatorResult<TData>> {
    const { baseline, ...operationOptions } = options;
    const result = await this.#execute<ActionWire<TData>>(action, {
      ...extra,
      observe: options.observe ?? "none",
      ...(baseline === undefined
        ? {}
        : { baselineObservationId: typeof baseline === "string" ? baseline : baseline.id }),
      ...(options.observation === undefined ? {} : { observation: options.observation }),
    }, operationOptions);
    return {
      ...result,
      observation: result.observation
        ? new AXState(this.#client, result.observation)
        : null,
    };
  }

  async #read(subaction: "text", options: OperationOptions): Promise<unknown> {
    const result = await this.#execute<Record<string, unknown>>(
      subaction,
      {},
      options,
    );
    return result.text;
  }

  #execute<T>(
    operation: string,
    arguments_: Record<string, unknown>,
    options: OperationOptions = {},
  ): Promise<T> {
    return this.#client.request<T>(
      "locator.execute",
      {
        query: this.query,
        ...(this.#index === undefined ? {} : { index: this.#index }),
        ...(this.#visible === undefined ? {} : { visible: this.#visible }),
        operation,
        arguments: arguments_,
      },
      {
        target: { tabId: this.#tabId },
        ...options,
      },
    );
  }

  #assertCompatible(other: Locator): void {
    if (other.#client !== this.#client || other.#tabId !== this.#tabId) {
      throw new TypeError("Locators can only be composed within the same Browser and Tab");
    }
  }
}

function freezeQuery(query: LocatorQuery): LocatorQuery {
  const clone = JSON.parse(JSON.stringify(query)) as LocatorQuery;
  return deepFreeze(clone);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}

function matchesSuggestion(actual: string, expected: string, exact: boolean): boolean {
  const normalizedActual = actual.trim().replace(/\s+/g, " ").toLocaleLowerCase();
  const normalizedExpected = expected.trim().replace(/\s+/g, " ").toLocaleLowerCase();
  return exact
    ? normalizedActual === normalizedExpected
    : normalizedActual.includes(normalizedExpected);
}

function isSuggestionItemRole(role: string): boolean {
  return role === "option"
    || role === "listitem"
    || role === "menuitem"
    || role === "menuitemcheckbox"
    || role === "menuitemradio"
    || role === "treeitem"
    || role === "row";
}
