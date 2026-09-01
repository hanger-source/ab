import { inspect } from "node:util";
import { Screenshot } from "../artifacts/index.js";
import { ElementHandle, } from "../elements/index.js";
import { AX, AXState } from "../ax/index.js";
import { ABError } from "../errors/index.js";
/**
 * An immutable semantic query plan evaluated by Rust against the current page.
 * Builders do not touch the browser; strict reads and actions resolve on use.
 */
export class Locator {
    query;
    #client;
    #tabId;
    #index;
    #visible;
    constructor(client, tabId, query, options = {}) {
        this.#client = client;
        this.#tabId = tabId;
        this.query = freezeQuery(query);
        this.#index = options.index;
        this.#visible = options.visible;
    }
    /** Adds relational, textual, or visibility filters without mutating this locator. */
    filter(filter) {
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
    locator(selector) {
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
    and(other) {
        this.#assertCompatible(other);
        return new Locator(this.#client, this.#tabId, { kind: "and", left: this.query, right: other.query });
    }
    /** Unions this query with another locator from the same tab. */
    or(other) {
        this.#assertCompatible(other);
        return new Locator(this.#client, this.#tabId, { kind: "or", left: this.query, right: other.query });
    }
    /** Restricts this query to an explicit frame identity. */
    inFrame(frameId) {
        return new Locator(this.#client, this.#tabId, { kind: "frame", frameId, query: this.query });
    }
    nth(index) {
        if (!Number.isInteger(index)) {
            throw new TypeError("Locator.nth(index) requires an integer");
        }
        return new Locator(this.#client, this.#tabId, this.query, {
            index,
            ...(this.#visible === undefined ? {} : { visible: this.#visible }),
        });
    }
    first() {
        return this.nth(0);
    }
    last() {
        return this.nth(-1);
    }
    async count(options = {}) {
        const value = await this.#execute("count", {}, options);
        return value.count ?? 0;
    }
    async all(options = {}) {
        const count = await this.count(options);
        return Array.from({ length: count }, (_, index) => this.nth(index));
    }
    async waitFor(options = {}) {
        await this.#execute("waitFor", { state: options.state ?? "visible" }, options);
    }
    /** Resolves once and creates a server-owned handle to the exact node. */
    async elementHandle(options = {}) {
        const descriptor = await this.#client.request("element.createFromLocator", {
            query: this.query,
            ...(this.#index === undefined ? {} : { index: this.#index }),
            ...(this.#visible === undefined ? {} : { visible: this.#visible }),
            operation: "elementHandle",
            arguments: {},
        }, { target: { tabId: this.#tabId }, ...options });
        return new ElementHandle(this.#client, descriptor);
    }
    click(options = {}) {
        return this.#act("click", {
            button: options.button ?? "left",
            clickCount: options.clickCount ?? 1,
        }, options);
    }
    doubleClick(options = {}) {
        return this.#act("dblclick", {}, options);
    }
    hover(options = {}) {
        return this.#act("hover", {}, options);
    }
    wheel(deltaX, deltaY, options = {}) {
        return this.#act("wheel", { deltaX, deltaY }, options);
    }
    focus(options = {}) {
        return this.#act("focus", {}, options);
    }
    scrollIntoView(options = {}) {
        return this.#act("scrollintoview", {}, options);
    }
    fill(value, options = {}) {
        return this.#act("fill", { value }, options);
    }
    type(text, options = {}) {
        return this.#act("type", {
            text,
            clear: options.clear ?? false,
            ...(options.delayMs === undefined ? {} : { delay: options.delayMs }),
        }, options);
    }
    /** Completes one popup-backed input commit without exposing an intermediate ref lifecycle. */
    async fillAndSelectSuggestion(query, suggestionText, options = {}) {
        const { expectedValue, exact = false, suggestionExact = false, ...actionOptions } = options;
        const deadline = Date.now() + (actionOptions.timeoutMs ?? 30_000);
        const remainingOptions = () => {
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
        let suggestionState = null;
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
            let suggestion = null;
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
        }
        finally {
            await Promise.allSettled([
                ...(suggestionState ? [suggestionState.dispose({ timeoutMs: 2_000 })] : []),
                baseline.dispose({ timeoutMs: 2_000 }),
            ]);
        }
    }
    press(key, options = {}) {
        return this.#act("press", { key }, options);
    }
    check(options = {}) {
        return this.#act("check", {}, options);
    }
    uncheck(options = {}) {
        return this.#act("uncheck", {}, options);
    }
    clear(options = {}) {
        return this.#act("clear", {}, options);
    }
    selectOption(values, options = {}) {
        return this.#act("select", {
            values: Array.isArray(values) ? values : [values],
        }, options);
    }
    setFiles(files, options = {}) {
        return this.#act("upload", {
            files: Array.isArray(files) ? files : [files],
        }, options);
    }
    dragTo(target, options = {}) {
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
    async textContent(options = {}) {
        const value = await this.#read("text", options);
        return typeof value === "string" ? value : String(value ?? "");
    }
    async innerText(options = {}) {
        const value = await this.#execute("innertext", {}, options);
        return typeof value.text === "string" ? value.text : String(value.text ?? "");
    }
    domInvoke(method, args = [], options = {}) {
        return this.#act("dominvoke", { method, args }, options);
    }
    async screenshot(options = {}) {
        return new Screenshot(this.#client, await this.#execute("screenshot", {}, options));
    }
    async getAttribute(name, options = {}) {
        const value = await this.#execute("getattribute", { attribute: name }, options);
        return value.value ?? null;
    }
    async boundingBox(options = {}) {
        const value = await this.#execute("boundingbox", {}, options);
        if (!value || value.x === undefined || value.y === undefined || value.width === undefined || value.height === undefined) {
            return null;
        }
        return { x: value.x, y: value.y, width: value.width, height: value.height };
    }
    async isVisible(options = {}) {
        const value = await this.#execute("isvisible", {}, options);
        return value.value === true;
    }
    async isEnabled(options = {}) {
        const value = await this.#execute("isenabled", {}, options);
        return value.value === true;
    }
    async isChecked(options = {}) {
        const value = await this.#execute("ischecked", {}, options);
        return value.value === true;
    }
    async inputValue(options = {}) {
        const value = await this.#execute("inputvalue", {}, options);
        return typeof value.value === "string" ? value.value : String(value.value ?? "");
    }
    inspect(options = {}) {
        const { attributes = [], ...operationOptions } = options;
        return this.#execute("inspect", { attributes }, operationOptions);
    }
    [inspect.custom]() {
        const index = this.#index === undefined ? "" : `.nth(${this.#index})`;
        return `Locator ${JSON.stringify(this.query)}${index}`;
    }
    async #act(action, extra, options) {
        const { baseline, ...operationOptions } = options;
        const result = await this.#execute(action, {
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
    async #read(subaction, options) {
        const result = await this.#execute(subaction, {}, options);
        return result.text;
    }
    #execute(operation, arguments_, options = {}) {
        return this.#client.request("locator.execute", {
            query: this.query,
            ...(this.#index === undefined ? {} : { index: this.#index }),
            ...(this.#visible === undefined ? {} : { visible: this.#visible }),
            operation,
            arguments: arguments_,
        }, {
            target: { tabId: this.#tabId },
            ...options,
        });
    }
    #assertCompatible(other) {
        if (other.#client !== this.#client || other.#tabId !== this.#tabId) {
            throw new TypeError("Locators can only be composed within the same Browser and Tab");
        }
    }
}
function freezeQuery(query) {
    const clone = JSON.parse(JSON.stringify(query));
    return deepFreeze(clone);
}
function deepFreeze(value) {
    if (value && typeof value === "object") {
        for (const nested of Object.values(value)) {
            deepFreeze(nested);
        }
        Object.freeze(value);
    }
    return value;
}
function matchesSuggestion(actual, expected, exact) {
    const normalizedActual = actual.trim().replace(/\s+/g, " ").toLocaleLowerCase();
    const normalizedExpected = expected.trim().replace(/\s+/g, " ").toLocaleLowerCase();
    return exact
        ? normalizedActual === normalizedExpected
        : normalizedActual.includes(normalizedExpected);
}
function isSuggestionItemRole(role) {
    return role === "option"
        || role === "listitem"
        || role === "menuitem"
        || role === "menuitemcheckbox"
        || role === "menuitemradio"
        || role === "treeitem"
        || role === "row";
}
//# sourceMappingURL=index.js.map