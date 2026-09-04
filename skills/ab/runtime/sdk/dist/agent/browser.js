import { inspect } from "node:util";
import { Browser as CoreBrowser, Tab as CoreTab, } from "../browser/index.js";
import { connect as connectCore } from "../index.js";
import { browserProviderKey, normalizeBrowserProvider, } from "../runtime/provider.js";
import { AX } from "./ax.js";
import { CUA } from "./cua.js";
import { Dev } from "./dev.js";
import { DocumentationRegistry, readDocumentation, } from "./documentation.js";
import { Playwright } from "./playwright.js";
import { defaultPresenter, } from "./presentation.js";
import { Resources } from "./resources.js";
/** Explicit Agent-facing tab with capability namespaces instead of Core forwarding. */
export class Tab {
    ax;
    playwright;
    cua;
    resources;
    dev;
    #core;
    #documentation;
    #resolveTab;
    constructor(core, presenter, documentation, resolveTab) {
        this.#core = core;
        this.#documentation = documentation;
        this.#resolveTab = resolveTab;
        this.ax = AX.create(core, presenter, documentation);
        this.playwright = Playwright.create(core, this.ax);
        this.cua = CUA.create(core.cua, this.ax);
        this.resources = Resources.create(core, documentation);
        this.dev = Dev.create(core, documentation);
    }
    /** @internal */
    static create(core, presenter, documentation, resolveTab) {
        return new Tab(core, presenter, documentation, resolveTab);
    }
    get id() {
        return this.#core.id;
    }
    get title() {
        return this.#core.title;
    }
    get openerId() {
        return this.#core.openerId;
    }
    get url() {
        return this.#core.url;
    }
    get active() {
        return this.#core.active;
    }
    get ownership() {
        return this.#core.ownership;
    }
    async acquire(options = {}) {
        await this.#core.acquire(options);
        return this;
    }
    async refresh(options = {}) {
        await this.#core.refresh(options);
        return this;
    }
    goto(url, options = {}) {
        return this.#core.navigate(url, options);
    }
    reload(options = {}) {
        return this.#core.reload(options);
    }
    goBack(options = {}) {
        return this.#core.goBack(options);
    }
    goForward(options = {}) {
        return this.#core.goForward(options);
    }
    activate(options = {}) {
        return this.#core.activate(options);
    }
    close(options = {}) {
        return this.#core.close(options);
    }
    /**
     * Arms a popup watcher before running the action and returns the exact ready
     * child target created by this tab.
     */
    async expectPopup(action, options = {}) {
        this.#documentation.require("tabs", "tab.expectPopup()");
        const watcher = await this.#core.watchPopups(options);
        try {
            await action();
            const popup = await watcher.waitForPopup(options);
            return await this.#resolveTab(popup.targetId, options);
        }
        finally {
            await watcher.dispose(options);
        }
    }
    screenshot(options = {}) {
        this.#documentation.require("screenshot", "tab.screenshot()");
        return this.#core.screenshot(options);
    }
    [inspect.custom]() {
        return `Tab { id: '${this.id}', title: ${JSON.stringify(this.title)}, url: ${JSON.stringify(this.url)}, surfaces: [ax, playwright, cua, resources, dev] }`;
    }
}
/** Agent tab discovery with a stable wrapper and presentation baseline per target. */
export class Tabs {
    #core;
    #presenter;
    #documentation;
    #cache = new Map();
    constructor(core, presenter, documentation) {
        this.#core = core;
        this.#presenter = presenter;
        this.#documentation = documentation;
    }
    /** @internal */
    static create(core, presenter, documentation) {
        return new Tabs(core, presenter, documentation);
    }
    async list(options = {}) {
        return Promise.all((await this.#core.tabs.list(options)).map((tab) => this.#wrap(tab, options)));
    }
    async get(targetId, options = {}) {
        return this.#wrap(await this.#core.tabs.get(targetId, options), options);
    }
    async acquire(targetId, options = {}) {
        return this.#wrap(await this.#core.tabs.acquire(targetId, options), options);
    }
    async open(url = "about:blank", options = {}) {
        return this.#wrap(await this.#core.tabs.open(url, options), options);
    }
    /** @internal */
    async dispose() {
        await Promise.all([...this.#cache.values()].map(({ tab }) => tab.ax.dispose()));
        this.#cache.clear();
    }
    async #wrap(core, options) {
        const existing = this.#cache.get(core.id);
        if (existing) {
            await existing.core.refresh(options);
            return existing.tab;
        }
        const tab = Tab.create(core, this.#presenter, this.#documentation, (targetId, resolveOptions = {}) => this.get(targetId, resolveOptions));
        this.#cache.set(core.id, { core, tab });
        return tab;
    }
}
export class Browser {
    identity;
    tabs;
    diagnostics;
    #core;
    #presenter;
    #documentation = new DocumentationRegistry();
    #onDisconnect;
    constructor(core, presenter, onDisconnect) {
        this.#core = core;
        this.#presenter = presenter;
        this.#onDisconnect = onDisconnect;
        this.identity = core.identity;
        this.tabs = Tabs.create(core, presenter, this.#documentation);
        this.diagnostics = core.diagnostics;
    }
    /** @internal */
    static create(core, presenter, onDisconnect) {
        return new Browser(core, presenter, onDisconnect);
    }
    get connected() {
        return this.#core.connected;
    }
    async documentation(topic = "core") {
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
    async disconnect() {
        try {
            await this.#core.disconnect();
        }
        finally {
            try {
                // Core establishes the server-side cleanup boundary before local
                // presentation objects are discarded. Their disposal must not turn a
                // completed disconnect into a failure.
                await this.tabs.dispose().catch(() => undefined);
            }
            finally {
                this.#onDisconnect();
            }
        }
    }
    [inspect.custom]() {
        return `Browser { connected: ${this.connected}, clientId: '${this.identity.clientId}', daemonId: '${this.identity.daemonId}' }`;
    }
}
let currentBrowser;
let currentProviderKey;
/** Connects the Agent facade to the Core SDK and version-matched Rust runtime. */
export function connect(options = {}) {
    const provider = normalizeBrowserProvider(options.provider);
    const providerKey = browserProviderKey(provider);
    if (currentBrowser) {
        if (currentProviderKey !== providerKey) {
            return Promise.reject(new Error("this JavaScript process is already connected to a different AB browser provider; disconnect it before connecting another provider"));
        }
        return currentBrowser;
    }
    const presenter = options.presenter ?? defaultPresenter();
    const connecting = connectCore({
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        provider,
    }).then((core) => Browser.create(core, presenter, () => {
        if (currentBrowser === connecting) {
            currentBrowser = undefined;
            currentProviderKey = undefined;
        }
    }));
    currentBrowser = connecting;
    currentProviderKey = providerKey;
    void connecting.catch(() => {
        if (currentBrowser === connecting) {
            currentBrowser = undefined;
            currentProviderKey = undefined;
        }
    });
    return connecting;
}
//# sourceMappingURL=browser.js.map