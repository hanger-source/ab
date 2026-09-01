import { inspect } from "node:util";
import { CUA } from "../actions/cua.js";
import { Screenshot, } from "../artifacts/index.js";
import { ABError } from "../errors/index.js";
import { Diagnostics } from "../diagnostics/index.js";
import { buildEvaluateScript, deserializeEvaluateResult } from "./evaluate-values.js";
import { Locator } from "../locators/index.js";
import { AX, AXState } from "../ax/index.js";
import { ConsoleObserver, DialogWatcher, DownloadWatcher, FileChooserWatcher, InitScriptRegistration, NetworkObserver, } from "../resources/index.js";
import { ProtocolClient } from "../transport/index.js";
/** Explicit low-level CDP access for diagnostics and unsupported primitives. */
export class CDPSession {
    #client;
    #tabId;
    #resourceId;
    #disposed = false;
    constructor(client, tabId, resourceId) {
        this.#client = client;
        this.#tabId = tabId;
        this.#resourceId = resourceId;
    }
    /** Sends one CDP method to the tab's root session. */
    async send(method, params = {}, options = {}) {
        if (this.#disposed) {
            throw new ABError({
                kind: "resource_disposed",
                stage: "sdk.cdp.send",
                message: "CDPSession is disposed",
            });
        }
        return this.#client.request("resource.command", { command: "send", params: { method, params } }, {
            target: { tabId: this.#tabId, resourceId: this.#resourceId },
            ...options,
        });
    }
    async dispose(options = {}) {
        if (this.#disposed)
            return;
        await this.#client.request("resource.dispose", {}, {
            target: { tabId: this.#tabId, resourceId: this.#resourceId },
            ...options,
        });
        this.#disposed = true;
    }
}
/** A frame identity captured from the Rust SessionManager registry. */
export class Frame {
    id;
    targetId;
    parentId;
    url;
    name;
    documentGeneration;
    sessionId;
    #client;
    constructor(client, value) {
        this.#client = client;
        this.id = value.id;
        this.targetId = value.targetId;
        this.parentId = value.parentId;
        this.url = value.url;
        this.name = value.name;
        this.documentGeneration = value.documentGeneration;
        this.sessionId = value.sessionId;
    }
    async cdp() {
        const descriptor = await this.#client.request("resource.open", {
            kind: "cdp",
            options: {
                sessionId: this.sessionId,
                frameId: this.id,
                documentGeneration: this.documentGeneration,
            },
        }, { target: { tabId: this.targetId, frameId: this.id, documentGeneration: this.documentGeneration } });
        return new CDPSession(this.#client, this.targetId, descriptor.id);
    }
    /** Creates a CSS Locator explicitly scoped to this frame. */
    locator(selector) {
        return this.#locator({ kind: "css", value: selector });
    }
    getByRole(role, options = {}) {
        return this.#locator({
            kind: "role",
            role,
            ...(options.name === undefined ? {} : { name: options.name }),
            exact: options.exact ?? false,
        });
    }
    getByText(text, options = {}) {
        return this.#semanticLocator("text", text, options);
    }
    getByLabel(label, options = {}) {
        return this.#semanticLocator("label", label, options);
    }
    getByPlaceholder(placeholder, options = {}) {
        return this.#semanticLocator("placeholder", placeholder, options);
    }
    getByAltText(text, options = {}) {
        return this.#semanticLocator("altText", text, options);
    }
    getByTitle(title, options = {}) {
        return this.#semanticLocator("title", title, options);
    }
    getByTestId(testId) {
        return this.#semanticLocator("testId", testId, {});
    }
    /** Evaluates a function in this frame's current default realm. */
    async evaluate(pageFunction, ...args) {
        const script = buildEvaluateScript(pageFunction, args);
        const result = await this.#client.request("tab.evaluate", { expression: script, frameId: this.id }, { target: { tabId: this.targetId, frameId: this.id, documentGeneration: this.documentGeneration } });
        return deserializeEvaluateResult(result.result);
    }
    #locator(query) {
        return new Locator(this.#client, this.targetId, {
            kind: "frame",
            frameId: this.id,
            query,
        });
    }
    #semanticLocator(kind, value, options) {
        return this.#locator({ kind, value, exact: options.exact ?? false });
    }
    [inspect.custom]() {
        return `Frame { id: '${this.id}', parentId: ${this.parentId ? `'${this.parentId}'` : "null"}, url: ${JSON.stringify(this.url)}, documentGeneration: '${this.documentGeneration}' }`;
    }
}
/** A concrete JavaScript execution realm owned by one CDP session. */
export class Realm {
    id;
    executionContextId;
    rootTargetId;
    targetId;
    frameId;
    origin;
    name;
    kind;
    isDefault;
    sessionId;
    #client;
    constructor(client, value) {
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
    async evaluate(pageFunction, ...args) {
        const script = buildEvaluateScript(pageFunction, args);
        const result = await this.#client.request("tab.evaluate", {
            expression: script,
            realmId: this.id,
            contextId: this.executionContextId,
            sessionId: this.sessionId,
            ...(this.frameId ? { frameId: this.frameId } : {}),
        }, { target: { tabId: this.rootTargetId, ...(this.frameId ? { frameId: this.frameId } : {}) } });
        return deserializeEvaluateResult(result.result);
    }
    [inspect.custom]() {
        return `Realm { id: '${this.id}', frameId: ${this.frameId ? `'${this.frameId}'` : "null"}, kind: '${this.kind}', default: ${this.isDefault} }`;
    }
}
/** A Chrome page target with typed observation, action, and resource surfaces. */
export class Tab {
    id;
    #openerId;
    ax;
    cua;
    #title;
    #url;
    #active;
    #client;
    constructor(client, info) {
        this.#client = client;
        this.id = info.id;
        this.#openerId = info.openerId;
        this.ax = new AX(client, info.id);
        this.cua = new CUA(client, info.id);
        this.#title = info.title;
        this.#url = info.url;
        this.#active = info.active;
    }
    get title() {
        return this.#title;
    }
    get openerId() {
        return this.#openerId;
    }
    get url() {
        return this.#url;
    }
    get active() {
        return this.#active;
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
    applyActionResult(result) {
        this.#url = result.navigation.afterUrl;
    }
    async refresh(options = {}) {
        const info = await this.#client.request("tabs.get", {}, {
            target: { tabId: this.id },
            ...options,
        });
        this.#title = info.title;
        this.#openerId = info.openerId;
        this.#url = info.url;
        this.#active = info.active;
        return this;
    }
    /** Navigates this tab and waits for the requested mechanical lifecycle state. */
    async navigate(url, options = {}) {
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
    async screenshot(options = {}) {
        const result = await this.#client.request("tab.screenshot", {
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
    async frames(options = {}) {
        const values = await this.#client.request("tab.frames", {}, {
            target: { tabId: this.id },
            ...options,
        });
        return values.map((value) => new Frame(this.#client, value));
    }
    /** Returns the root frame for this tab's current document topology. */
    async mainFrame(options = {}) {
        const frames = await this.frames(options);
        const roots = frames.filter((frame) => frame.parentId === null);
        if (roots.length !== 1) {
            throw new ABError({
                kind: "frame_registry_error",
                stage: "sdk.tab.main_frame",
                message: `tab ${this.id} has ${roots.length} root frames`,
            });
        }
        return roots[0];
    }
    /** Returns the current JavaScript realm registry for this tab. */
    async realms(options = {}) {
        const values = await this.#client.request("tab.realms", {}, {
            target: { tabId: this.id },
            ...options,
        });
        return values.map((value) => new Realm(this.#client, value));
    }
    async cdp() {
        const descriptor = await this.#client.request("resource.open", { kind: "cdp", options: {} }, { target: { tabId: this.id } });
        return new CDPSession(this.#client, this.id, descriptor.id);
    }
    observeNetwork(options = {}) {
        return this.#openResource("network", NetworkObserver, {
            ...(options.bodyRetentionBytes === undefined ? {} : { bodyRetentionBytes: options.bodyRetentionBytes }),
            ...(options.bodyMemoryBytes === undefined ? {} : { bodyMemoryBytes: options.bodyMemoryBytes }),
            ...(options.maxBodyBytes === undefined ? {} : { maxBodyBytes: options.maxBodyBytes }),
            ...(options.cdpBufferBytes === undefined ? {} : { cdpBufferBytes: options.cdpBufferBytes }),
            ...(options.bodyStorage === undefined ? {} : { bodyStorage: options.bodyStorage }),
            ...(options.bodyCapture === undefined ? {} : { bodyCapture: options.bodyCapture }),
        }, options);
    }
    observeConsole(options = {}) {
        return this.#openResource("console", ConsoleObserver, {}, options);
    }
    watchDialogs(options = {}) {
        return this.#openResource("dialog", DialogWatcher, {}, options);
    }
    watchDownloads(options = {}) {
        return this.#openResource("download", DownloadWatcher, {}, options);
    }
    watchFileChoosers(options = {}) {
        return this.#openResource("fileChooser", FileChooserWatcher, {}, options);
    }
    addInitScript(definition, options = {}) {
        return this.#openResource("initScript", InitScriptRegistration, definition, options);
    }
    locator(selector) {
        return new Locator(this.#client, this.id, { kind: "css", value: selector });
    }
    getByRole(role, options = {}) {
        return new Locator(this.#client, this.id, {
            kind: "role",
            role,
            ...(options.name === undefined ? {} : { name: options.name }),
            exact: options.exact ?? false,
        });
    }
    getByText(text, options = {}) {
        return this.#semanticLocator("text", text, options);
    }
    getByLabel(label, options = {}) {
        return this.#semanticLocator("label", label, options);
    }
    getByPlaceholder(placeholder, options = {}) {
        return this.#semanticLocator("placeholder", placeholder, options);
    }
    getByAltText(text, options = {}) {
        return this.#semanticLocator("altText", text, options);
    }
    getByTitle(title, options = {}) {
        return this.#semanticLocator("title", title, options);
    }
    getByTestId(testId) {
        return this.#semanticLocator("testId", testId, {});
    }
    /** Evaluates a function in the root frame's current default realm. */
    async evaluate(pageFunction, ...args) {
        if (typeof pageFunction !== "function") {
            throw new TypeError("tab.evaluate() requires a function");
        }
        const script = buildEvaluateScript(pageFunction, args);
        const result = await this.#client.request("tab.evaluate", { expression: script }, { target: { tabId: this.id } });
        return deserializeEvaluateResult(result.result);
    }
    async activate(options = {}) {
        await this.#client.request("tab.activate", {}, { target: { tabId: this.id }, ...options });
        this.#active = true;
    }
    async reload(options = {}) {
        await this.#client.request("tab.reload", {}, { target: { tabId: this.id }, ...options });
        await this.refresh(options);
    }
    async goBack(options = {}) {
        await this.#client.request("tab.goBack", {}, { target: { tabId: this.id }, ...options });
        await this.refresh(options);
    }
    async goForward(options = {}) {
        await this.#client.request("tab.goForward", {}, { target: { tabId: this.id }, ...options });
        await this.refresh(options);
    }
    async waitFor(options) {
        await this.#client.request("tab.waitFor", {
            ...(options.selector === undefined ? {} : { selector: options.selector }),
            ...(options.text === undefined ? {} : { text: options.text }),
            ...(options.state === undefined ? {} : { state: options.state }),
            timeoutMs: options.timeoutMs ?? 30_000,
        }, { target: { tabId: this.id }, ...options });
    }
    /**
     * Atomically captures the requested AX state and screenshot.
     *
     * When both are requested, Rust validates one document, frame topology,
     * viewport, scroll position, and DPR transaction before returning either.
     */
    async observe(options) {
        const ax = typeof options.ax === "object"
            ? options.ax
            : options.ax === true
                ? {}
                : undefined;
        const wire = await this.#client.request("tab.observe", {
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
        }, {
            target: { tabId: this.id },
            ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
            ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        return {
            ...(wire.state ? { state: new AXState(this.#client, wire.state) } : {}),
            ...(wire.screenshot ? { screenshot: new Screenshot(this.#client, wire.screenshot) } : {}),
        };
    }
    async close(options = {}) {
        await this.#client.request("tab.close", {}, {
            target: { tabId: this.id },
            ...options,
        });
    }
    #semanticLocator(kind, value, options) {
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
    async #openResource(kind, ResourceType, resourceOptions, options) {
        const descriptor = await this.#client.request("resource.open", { kind, options: resourceOptions }, { target: { tabId: this.id }, ...options });
        return new ResourceType(this.#client, descriptor);
    }
    [inspect.custom]() {
        return `Tab { id: '${this.id}', title: ${JSON.stringify(this.#title)}, url: ${JSON.stringify(this.#url)} }`;
    }
}
/** Browser target discovery and creation. */
export class Tabs {
    #client;
    constructor(client) {
        this.#client = client;
    }
    async list(options = {}) {
        const infos = await this.#client.request("tabs.list", {}, options);
        return infos.map((info) => new Tab(this.#client, info));
    }
    async get(targetId, options = {}) {
        const info = await this.#client.request("tabs.get", {}, {
            target: { tabId: targetId },
            ...options,
        });
        return new Tab(this.#client, info);
    }
    async open(url = "about:blank", options = {}) {
        const timeoutMs = options.timeoutMs ?? 30_000;
        const info = await this.#client.request("tabs.open", {
            url,
            waitUntil: options.waitUntil ?? "domcontentloaded",
            timeoutMs,
        }, { ...options, timeoutMs });
        return new Tab(this.#client, info);
    }
}
/** One SDK client attached to the persistent AB daemon and Chrome instance. */
export class Browser {
    identity;
    tabs;
    diagnostics;
    #client;
    #onDisconnect;
    constructor(client, onDisconnect) {
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
    get connected() {
        return this.#client.connected;
    }
    /** Releases this client's server-owned resources without closing Chrome. */
    async disconnect() {
        await this.#client.disconnect();
        this.#onDisconnect();
    }
    [inspect.custom]() {
        return `Browser { connected: ${this.connected}, clientId: '${this.identity.clientId}', daemonId: '${this.identity.daemonId}', browserGeneration: '${this.identity.browserGeneration}' }`;
    }
}
//# sourceMappingURL=index.js.map