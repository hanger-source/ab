import { inspect } from "node:util";
import { Screenshot } from "../artifacts/index.js";
import { ElementHandle, } from "../elements/index.js";
import { ABError } from "../errors/index.js";
/** An actionable node identity owned by one explicit AXState. */
export class AXRef {
    observationId;
    id;
    role;
    name;
    frameId;
    documentGeneration;
    backendNodeId;
    bounds;
    #client;
    #targetId;
    constructor(client, targetId, observationId, value) {
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
    click(options = {}) {
        return this.#perform("click", {
            button: options.button ?? "left",
            clickCount: options.clickCount ?? 1,
            observe: options.observe ?? "diff",
        }, options);
    }
    doubleClick(options = {}) {
        return this.#perform("dblclick", { observe: options.observe ?? "diff" }, options);
    }
    hover(options = {}) {
        return this.#perform("hover", { observe: options.observe ?? "none" }, options);
    }
    wheel(deltaX, deltaY, options = {}) {
        return this.#perform("wheel", { deltaX, deltaY, observe: options.observe ?? "none" }, options);
    }
    fill(value, options = {}) {
        return this.#perform("fill", {
            value,
            observe: options.observe ?? "diff",
        }, options);
    }
    type(text, options = {}) {
        return this.#perform("type", {
            text,
            clear: options.clear ?? false,
            ...(options.delayMs === undefined ? {} : { delayMs: options.delayMs }),
            observe: options.observe ?? "diff",
        }, options);
    }
    press(key, options = {}) {
        return this.#perform("press", {
            key,
            observe: options.observe ?? "diff",
        }, options);
    }
    focus(options = {}) {
        return this.#perform("focus", { observe: options.observe ?? "none" }, options);
    }
    clear(options = {}) {
        return this.#perform("clear", { observe: options.observe ?? "diff" }, options);
    }
    scrollIntoView(options = {}) {
        return this.#perform("scrollIntoView", {
            observe: options.observe ?? "none",
        }, options);
    }
    check(options = {}) {
        return this.#perform("check", { observe: options.observe ?? "diff" }, options);
    }
    uncheck(options = {}) {
        return this.#perform("uncheck", { observe: options.observe ?? "diff" }, options);
    }
    selectOption(values, options = {}) {
        return this.#perform("select", {
            values: Array.isArray(values) ? values : [values],
            observe: options.observe ?? "diff",
        }, options);
    }
    setFiles(files, options = {}) {
        return this.#perform("upload", {
            files: Array.isArray(files) ? files : [files],
            observe: options.observe ?? "diff",
        }, options);
    }
    dragTo(target, options = {}) {
        if (target.#client !== this.#client || target.#targetId !== this.#targetId) {
            return Promise.reject(new TypeError("AXRef.dragTo requires a ref from the same Browser and Tab"));
        }
        return this.#perform("drag", {
            targetObservationId: target.observationId,
            targetRefId: target.id,
            observe: options.observe ?? "diff",
        }, options);
    }
    async textContent(options = {}) {
        const data = await this.#read("text", {}, options);
        return typeof data.text === "string" ? data.text : String(data.text ?? "");
    }
    async innerText(options = {}) {
        const data = await this.#read("innertext", {}, options);
        return typeof data.text === "string" ? data.text : String(data.text ?? "");
    }
    async getAttribute(name, options = {}) {
        const result = await this.#read("getattribute", { attribute: name }, options);
        const value = result.value;
        return typeof value === "string" ? value : null;
    }
    async boundingBox(options = {}) {
        const value = await this.#read("boundingbox", {}, options);
        return value && value.x !== undefined && value.y !== undefined && value.width !== undefined && value.height !== undefined
            ? { x: value.x, y: value.y, width: value.width, height: value.height }
            : null;
    }
    async isVisible(options = {}) {
        return (await this.#read("isvisible", {}, options)).value === true;
    }
    async isEnabled(options = {}) {
        return (await this.#read("isenabled", {}, options)).value === true;
    }
    async isChecked(options = {}) {
        return (await this.#read("ischecked", {}, options)).value === true;
    }
    async inputValue(options = {}) {
        const value = (await this.#read("inputvalue", {}, options)).value;
        return typeof value === "string" ? value : String(value ?? "");
    }
    inspect(options = {}) {
        const { attributes = [], ...operationOptions } = options;
        return this.#read("inspect", { attributes }, operationOptions);
    }
    domInvoke(method, args = [], options = {}) {
        return this.#perform("dominvoke", { method, args, observe: options.observe ?? "none" }, options);
    }
    async screenshot(options = {}) {
        const result = await this.#read("screenshot", {}, options);
        return new Screenshot(this.#client, result);
    }
    /** Retains this exact backend node as a server-owned ElementHandle. */
    async elementHandle(options = {}) {
        const descriptor = await this.#client.request("element.createFromRef", { observationId: this.observationId, refId: this.id }, { target: { tabId: this.#targetId, observationId: this.observationId }, ...options });
        return new ElementHandle(this.#client, descriptor);
    }
    [inspect.custom]() {
        return `AXRef { id: '${this.id}', role: '${this.role}', name: ${JSON.stringify(this.name)}, observationId: '${this.observationId}' }`;
    }
    async #perform(action, params, options) {
        const { baseline: _baseline, ...operationOptions } = options;
        const result = await this.#client.request("action.perform", {
            observationId: this.observationId,
            refId: this.id,
            action,
            ...params,
            ...(params.observe === "diff" ? { baselineObservationId: this.observationId } : {}),
            ...(options.observation === undefined ? {} : { observation: options.observation }),
        }, { target: { tabId: this.#targetId }, ...operationOptions });
        return {
            ...result,
            observation: result.observation
                ? new AXState(this.#client, result.observation)
                : null,
        };
    }
    #read(action, params, options) {
        return this.#client.request("action.perform", {
            observationId: this.observationId,
            refId: this.id,
            action,
            ...params,
        }, { target: { tabId: this.#targetId }, ...options });
    }
}
/**
 * Immutable AX observation text, refs, identity, completeness, and optional diff.
 * Agent-visible rendering belongs to @hanger-source/ab/agent's Presenter.
 */
export class AXState {
    id;
    targetId;
    frameId;
    documentGeneration;
    revision;
    text;
    #refs;
    complete;
    truncated;
    nodeCount;
    sources;
    diff;
    #client;
    #disposed = false;
    constructor(client, value) {
        this.#client = client;
        this.id = value.id;
        this.targetId = value.targetId;
        this.frameId = value.frameId;
        this.documentGeneration = value.documentGeneration;
        this.revision = value.revision;
        this.text = value.text;
        this.#refs = value.refs.map((entry) => new AXRef(client, value.targetId, value.id, entry));
        this.complete = value.complete;
        this.truncated = value.truncated;
        this.nodeCount = value.nodeCount;
        this.sources = Object.freeze({ ...value.sources });
        this.diff = value.diff;
    }
    /** Returns a ref from this observation; accepts `e7` or `@e7`. */
    ref(id) {
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
    refs() {
        this.#assertLive();
        return this.#refs;
    }
    /** Releases the server observation record. Existing refs become unusable. */
    async dispose(options = {}) {
        if (this.#disposed) {
            return;
        }
        await this.#client.request("observation.dispose", {
            observationId: this.id,
        }, options);
        this.#disposed = true;
    }
    /** Whether this client has released the observation record. */
    get disposed() {
        return this.#disposed;
    }
    [inspect.custom]() {
        return `AXState { id: '${this.id}', revision: ${this.revision}, refs: ${this.#refs.length}, complete: ${this.complete}, truncated: ${this.truncated}, documentGeneration: '${this.documentGeneration}' }`;
    }
    #assertLive() {
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
    #client;
    #tabId;
    constructor(client, tabId) {
        this.#client = client;
        this.#tabId = tabId;
    }
    /** Captures a new AXState and establishes its ref identities. */
    async snapshot(options = {}) {
        const result = await this.#client.request("observation.snapshot", {
            mode: options.mode ?? "interactive",
            surface: options.surface ?? "document",
            ...(options.frames === undefined ? {} : { frames: options.frames }),
            ...(options.maxDepth === undefined ? {} : { maxDepth: options.maxDepth }),
            ...(options.maxChars === undefined ? {} : { maxChars: options.maxChars }),
            ...(options.diffFrom === undefined
                ? {}
                : {
                    diffFrom: typeof options.diffFrom === "string"
                        ? options.diffFrom
                        : options.diffFrom.id,
                }),
            includeUrls: options.includeUrls ?? false,
        }, {
            target: { tabId: this.#tabId },
            ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
            ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        return new AXState(this.#client, result);
    }
}
//# sourceMappingURL=index.js.map