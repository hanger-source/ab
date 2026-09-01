import { inspect } from "node:util";
import { Screenshot } from "../artifacts/index.js";
import { ABError } from "../errors/index.js";
import { AXState } from "../ax/index.js";
/**
 * Server-owned handle to one backend node in one frame/document generation.
 * It never reruns the Locator or searches for a semantically similar node.
 */
export class ElementHandle {
    id;
    targetId;
    frameId;
    documentGeneration;
    backendNodeId;
    #client;
    #disposed = false;
    constructor(client, value) {
        this.#client = client;
        this.id = value.id;
        this.targetId = value.targetId;
        this.frameId = value.frameId;
        this.documentGeneration = value.documentGeneration;
        this.backendNodeId = value.backendNodeId;
    }
    click(options = {}) {
        return this.#act("click", { button: options.button ?? "left", clickCount: options.clickCount ?? 1 }, options);
    }
    doubleClick(options = {}) { return this.#act("dblclick", {}, options); }
    hover(options = {}) { return this.#act("hover", {}, options); }
    wheel(deltaX, deltaY, options = {}) {
        return this.#act("wheel", { deltaX, deltaY }, options);
    }
    focus(options = {}) { return this.#act("focus", {}, options); }
    clear(options = {}) { return this.#act("clear", {}, options); }
    scrollIntoView(options = {}) { return this.#act("scrollIntoView", {}, options); }
    fill(value, options = {}) { return this.#act("fill", { value }, options); }
    type(text, options = {}) {
        return this.#act("type", { text, clear: options.clear ?? false, ...(options.delayMs === undefined ? {} : { delayMs: options.delayMs }) }, options);
    }
    press(key, options = {}) { return this.#act("press", { key }, options); }
    check(options = {}) { return this.#act("check", {}, options); }
    uncheck(options = {}) { return this.#act("uncheck", {}, options); }
    selectOption(values, options = {}) {
        return this.#act("select", { values: Array.isArray(values) ? values : [values] }, options);
    }
    setFiles(files, options = {}) {
        return this.#act("upload", { files: Array.isArray(files) ? files : [files] }, options);
    }
    dragTo(target, options = {}) {
        if (target.#client !== this.#client || target.targetId !== this.targetId) {
            return Promise.reject(new TypeError("ElementHandle.dragTo requires a handle from the same Browser and Tab"));
        }
        return this.#act("drag", { targetElementId: target.id }, options);
    }
    async textContent(options = {}) {
        const result = await this.#perform("text", {}, options);
        return typeof result.text === "string" ? result.text : String(result.text ?? "");
    }
    async innerText(options = {}) {
        const result = await this.#perform("innertext", {}, options);
        return typeof result.text === "string" ? result.text : String(result.text ?? "");
    }
    domInvoke(method, args = [], options = {}) {
        return this.#act("dominvoke", { method, args }, options);
    }
    async screenshot(options = {}) {
        return new Screenshot(this.#client, await this.#perform("screenshot", {}, options));
    }
    async getAttribute(name, options = {}) {
        const result = await this.#perform("getattribute", { attribute: name }, options);
        return typeof result.value === "string" ? result.value : null;
    }
    boundingBox(options = {}) {
        return this.#perform("boundingbox", {}, options);
    }
    async isVisible(options = {}) {
        return (await this.#perform("isvisible", {}, options)).value === true;
    }
    async isEnabled(options = {}) {
        return (await this.#perform("isenabled", {}, options)).value === true;
    }
    async isChecked(options = {}) {
        return (await this.#perform("ischecked", {}, options)).value === true;
    }
    async inputValue(options = {}) {
        const value = (await this.#perform("inputvalue", {}, options)).value;
        return typeof value === "string" ? value : String(value ?? "");
    }
    inspect(options = {}) {
        const { attributes = [], ...operationOptions } = options;
        return this.#perform("inspect", { attributes }, operationOptions);
    }
    /** Releases this handle; the owning client also releases it on disconnect. */
    async dispose(options = {}) {
        if (this.#disposed)
            return;
        await this.#client.request("element.dispose", {}, { target: { tabId: this.targetId, elementId: this.id }, ...options });
        this.#disposed = true;
    }
    [inspect.custom]() {
        return `ElementHandle { id: '${this.id}', frameId: '${this.frameId}', documentGeneration: '${this.documentGeneration}', backendNodeId: ${this.backendNodeId} }`;
    }
    #perform(operation, arguments_, options) {
        if (this.#disposed) {
            return Promise.reject(new ABError({ kind: "resource_disposed", stage: "sdk.element", message: `element handle ${this.id} is disposed` }));
        }
        return this.#client.request("element.perform", { operation, arguments: arguments_ }, { target: { tabId: this.targetId, frameId: this.frameId, documentGeneration: this.documentGeneration, elementId: this.id }, ...options });
    }
    async #act(operation, arguments_, options) {
        const { baseline, ...operationOptions } = options;
        const result = await this.#perform(operation, {
            ...arguments_,
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
}
//# sourceMappingURL=index.js.map