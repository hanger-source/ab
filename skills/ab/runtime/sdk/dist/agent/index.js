var _a;
import { ABError } from "../errors/index.js";
import { readFile } from "node:fs/promises";
import { Browser, Tab, } from "../browser/index.js";
import { connect as connectCore } from "../index.js";
import {} from "../ax/index.js";
import { CUA, } from "../actions/cua.js";
import { Locator, } from "../locators/index.js";
const AGENT_OBSERVATION_MAX_CHARS = 24_000;
const DOCUMENTATION_FILES = {
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
    #read = new Set();
    markRead(topic) {
        this.#read.add(topic);
    }
    require(topic, member) {
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
async function readDocumentation(topic) {
    const path = new URL(`../../docs/${DOCUMENTATION_FILES[topic]}`, import.meta.url);
    return readFile(path, "utf8");
}
function formatTextPresentation(value) {
    const boundary = value.untrusted ? "AB_UNTRUSTED_BROWSER_CONTENT" : "AB_DOCUMENTATION";
    return `<<<${boundary} origin=${JSON.stringify(value.origin)} observation=${JSON.stringify(value.observationId)}>>>\n${value.text}\n<<<END_${boundary}>>>\n`;
}
function formatScreenshotPresentation(value) {
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
export function terminalPresenter() {
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
export function nodeReplPresenter(host) {
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
function defaultPresenter() {
    const candidate = globalThis.nodeRepl;
    if (candidate
        && typeof candidate === "object"
        && typeof candidate.write === "function"
        && typeof candidate.emitImage === "function") {
        return nodeReplPresenter(candidate);
    }
    return terminalPresenter();
}
export class AgentAX {
    #tab;
    #presenter;
    #documentation;
    #lastPresentedState = null;
    constructor(tab, presenter, documentation) {
        this.#tab = tab;
        this.#presenter = presenter;
        this.#documentation = documentation;
    }
    async get(content, options = {}) {
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
    async write(content, options = {}) {
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
            }
            catch (error) {
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
            }
            catch (error) {
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
        }
        catch (error) {
            await observation.state.dispose().catch(() => undefined);
            throw error;
        }
        await this.#replacePresentedState(observation.state);
    }
    click(refId, options = {}) {
        const { write = "diff", ...action } = options;
        return this.#perform(refId, write, (ref) => ref.click(agentActionOptions({
            ...action,
        }, write)));
    }
    doubleClick(refId, options = {}) {
        const { write = "diff", ...action } = options;
        return this.#perform(refId, write, (ref) => ref.doubleClick(agentActionOptions({
            ...action,
        }, write)));
    }
    hover(refId, options = {}) {
        const { write = "none", ...action } = options;
        return this.#perform(refId, write, (ref) => ref.hover(agentActionOptions(action, write)));
    }
    wheel(refId, deltaX, deltaY, options = {}) {
        const { write = "none", ...action } = options;
        return this.#perform(refId, write, (ref) => ref.wheel(deltaX, deltaY, agentActionOptions(action, write)));
    }
    fill(refId, value, options = {}) {
        const { write = "diff", ...action } = options;
        return this.#perform(refId, write, (ref) => ref.fill(value, agentActionOptions({
            ...action,
        }, write)));
    }
    type(refId, text, options = {}) {
        const { write = "diff", ...action } = options;
        return this.#perform(refId, write, (ref) => ref.type(text, agentActionOptions({
            ...action,
        }, write)));
    }
    press(refId, key, options = {}) {
        const { write = "diff", ...action } = options;
        return this.#perform(refId, write, (ref) => ref.press(key, agentActionOptions({
            ...action,
        }, write)));
    }
    focus(refId, options = {}) {
        const { write = "none", ...action } = options;
        return this.#perform(refId, write, (ref) => ref.focus(agentActionOptions(action, write)));
    }
    clear(refId, options = {}) {
        const { write = "diff", ...action } = options;
        return this.#perform(refId, write, (ref) => ref.clear(agentActionOptions({
            ...action,
        }, write)));
    }
    check(refId, options = {}) {
        const { write = "diff", ...action } = options;
        return this.#perform(refId, write, (ref) => ref.check(agentActionOptions({
            ...action,
        }, write)));
    }
    uncheck(refId, options = {}) {
        const { write = "diff", ...action } = options;
        return this.#perform(refId, write, (ref) => ref.uncheck(agentActionOptions({
            ...action,
        }, write)));
    }
    selectOption(refId, values, options = {}) {
        const { write = "diff", ...action } = options;
        return this.#perform(refId, write, (ref) => ref.selectOption(values, agentActionOptions({
            ...action,
        }, write)));
    }
    setFiles(refId, files, options = {}) {
        const { write = "diff", ...action } = options;
        return this.#perform(refId, write, (ref) => ref.setFiles(files, agentActionOptions({
            ...action,
        }, write)));
    }
    dragTo(sourceRefId, targetRefId, options = {}) {
        const { write = "diff", ...action } = options;
        return this.#perform(sourceRefId, write, (source) => source.dragTo(this.#ref(targetRefId), agentActionOptions({
            ...action,
        }, write)));
    }
    scrollIntoView(refId, options = {}) {
        const { write = "none", ...action } = options;
        return this.#perform(refId, write, (ref) => ref.scrollIntoView(agentActionOptions(action, write)));
    }
    async dispose() {
        const state = this.#lastPresentedState;
        this.#lastPresentedState = null;
        await state?.dispose();
    }
    /** The exact observation currently visible to this Agent session. */
    actionBaseline() {
        return this.#lastPresentedState;
    }
    #ref(refId) {
        if (!this.#lastPresentedState) {
            throw new ABError({
                kind: "agent_observation_required",
                stage: "agent.ax.ref",
                message: `tab ${this.#tab.id} has no successfully presented AX observation`,
            });
        }
        return this.#lastPresentedState.ref(refId);
    }
    async #perform(refId, write, action) {
        const result = await action(this.#ref(refId));
        if (write === "diff") {
            if (result.observation) {
                await this.#presentState(result.observation);
                await this.#replacePresentedState(result.observation);
            }
            else {
                await this.presentActionObservationOutcome(result);
            }
        }
        else if (write === "state") {
            if (result.observation) {
                await this.write(result.observation);
            }
            else {
                await this.write("state");
            }
        }
        return result;
    }
    async presentActionObservationOutcome(result) {
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
    #presentState(state) {
        const text = state.diff && !state.diff.documentReplaced
            ? state.diff.text || "No accessibility-tree text changed after the action."
            : state.text;
        return this.#presenter.presentText({
            kind: "ax",
            origin: this.#tab.url,
            observationId: state.id,
            text,
            untrusted: true,
        });
    }
    async #replacePresentedState(state) {
        const previous = this.#lastPresentedState;
        this.#lastPresentedState = state;
        if (previous && previous !== state) {
            await previous.dispose();
        }
    }
}
/** Agent-facing viewport input that binds post-action state to the presented AX baseline. */
export class AgentCUA {
    #core;
    #ax;
    constructor(core, ax) {
        this.#core = core;
        this.#ax = ax;
    }
    click(options) {
        return this.#perform(options, (action) => this.#core.click(action));
    }
    move(options) {
        return this.#perform(options, (action) => this.#core.move(action));
    }
    wheel(options) {
        return this.#perform(options, (action) => this.#core.wheel(action));
    }
    drag(options) {
        return this.#perform(options, (action) => this.#core.drag(action));
    }
    async #perform(options, action) {
        const baseline = options.baseline ?? this.#ax.actionBaseline();
        const requested = options.observe ?? "none";
        const observe = requested === "diff" && !baseline ? "state" : requested;
        const result = await action({
            ...options,
            observe,
            ...(observe === "diff" ? { baseline: baseline } : {}),
            ...(observe === "state" && options.observation === undefined
                ? { observation: { mode: "full", surface: "active", maxChars: AGENT_OBSERVATION_MAX_CHARS } }
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
    #core;
    #ax;
    constructor(core, ax) {
        this.#core = core;
        this.#ax = ax;
    }
    get query() {
        return this.#core.query;
    }
    filter(filter) {
        const { has, ...coreFilter } = filter;
        return this.#wrap(this.#core.filter({
            ...coreFilter,
            ...(has ? { has: has.#core } : {}),
        }));
    }
    locator(selector) {
        return this.#wrap(this.#core.locator(typeof selector === "string" ? selector : selector.#core));
    }
    and(other) {
        return this.#wrap(this.#core.and(other.#core));
    }
    or(other) {
        return this.#wrap(this.#core.or(other.#core));
    }
    inFrame(frameId) {
        return this.#wrap(this.#core.inFrame(frameId));
    }
    nth(index) {
        return this.#wrap(this.#core.nth(index));
    }
    first() {
        return this.#wrap(this.#core.first());
    }
    last() {
        return this.#wrap(this.#core.last());
    }
    count(options = {}) {
        return this.#core.count(options);
    }
    async all(options = {}) {
        return (await this.#core.all(options)).map((locator) => this.#wrap(locator));
    }
    async waitFor(options = {}) {
        const { write = "state", observation = {}, ...waitOptions } = options;
        await this.#core.waitFor(waitOptions);
        if (write === "state") {
            await this.#ax.write("state", observation);
        }
    }
    elementHandle(options = {}) {
        return this.#core.elementHandle(options);
    }
    click(options = {}) {
        return this.#perform(options, "diff", (coreOptions) => this.#core.click(coreOptions));
    }
    doubleClick(options = {}) {
        return this.#perform(options, "diff", (coreOptions) => this.#core.doubleClick(coreOptions));
    }
    hover(options = {}) {
        return this.#perform(options, "none", (coreOptions) => this.#core.hover(coreOptions));
    }
    wheel(deltaX, deltaY, options = {}) {
        return this.#perform(options, "none", (coreOptions) => this.#core.wheel(deltaX, deltaY, coreOptions));
    }
    focus(options = {}) {
        return this.#perform(options, "none", (coreOptions) => this.#core.focus(coreOptions));
    }
    scrollIntoView(options = {}) {
        return this.#perform(options, "none", (coreOptions) => this.#core.scrollIntoView(coreOptions));
    }
    fill(value, options = {}) {
        return this.#perform(options, "diff", (coreOptions) => this.#core.fill(value, coreOptions));
    }
    type(text, options = {}) {
        const { clear, delayMs, ...actionOptions } = options;
        return this.#perform(actionOptions, "diff", (coreOptions) => this.#core.type(text, {
            ...coreOptions,
            ...(clear === undefined ? {} : { clear }),
            ...(delayMs === undefined ? {} : { delayMs }),
        }));
    }
    async fillAndSelectSuggestion(query, suggestionText, options = {}) {
        assertAgentOwnedObservation(options);
        const { write = "diff", ...coreOptions } = options;
        const observe = write === "diff" ? "diff" : write === "state" ? "state" : "none";
        const result = await this.#core.fillAndSelectSuggestion(query, suggestionText, {
            ...coreOptions,
            observe,
            ...(observe === "state" && coreOptions.observation === undefined
                ? { observation: { mode: "full", surface: "active", maxChars: AGENT_OBSERVATION_MAX_CHARS } }
                : {}),
        });
        if (write === "diff") {
            if (result.selection.observation) {
                await this.#ax.write(result.selection.observation);
            }
            else {
                await this.#ax.presentActionObservationOutcome(result.selection);
            }
        }
        else if (write === "state" && result.selection.observation) {
            await this.#ax.write(result.selection.observation);
        }
        return result;
    }
    press(key, options = {}) {
        return this.#perform(options, "diff", (coreOptions) => this.#core.press(key, coreOptions));
    }
    check(options = {}) {
        return this.#perform(options, "diff", (coreOptions) => this.#core.check(coreOptions));
    }
    uncheck(options = {}) {
        return this.#perform(options, "diff", (coreOptions) => this.#core.uncheck(coreOptions));
    }
    clear(options = {}) {
        return this.#perform(options, "diff", (coreOptions) => this.#core.clear(coreOptions));
    }
    selectOption(values, options = {}) {
        return this.#perform(options, "diff", (coreOptions) => this.#core.selectOption(values, coreOptions));
    }
    setFiles(files, options = {}) {
        return this.#perform(options, "diff", (coreOptions) => this.#core.setFiles(files, coreOptions));
    }
    dragTo(target, options = {}) {
        return this.#perform(options, "diff", (coreOptions) => this.#core.dragTo(target.#core, coreOptions));
    }
    textContent(options = {}) {
        return this.#core.textContent(options);
    }
    innerText(options = {}) {
        return this.#core.innerText(options);
    }
    domInvoke(method, args = [], options = {}) {
        return this.#perform(options, "diff", (coreOptions) => this.#core.domInvoke(method, args, coreOptions));
    }
    screenshot(options = {}) {
        return this.#core.screenshot(options);
    }
    getAttribute(name, options = {}) {
        return this.#core.getAttribute(name, options);
    }
    boundingBox(options = {}) {
        return this.#core.boundingBox(options);
    }
    isVisible(options = {}) {
        return this.#core.isVisible(options);
    }
    isEnabled(options = {}) {
        return this.#core.isEnabled(options);
    }
    isChecked(options = {}) {
        return this.#core.isChecked(options);
    }
    inputValue(options = {}) {
        return this.#core.inputValue(options);
    }
    inspect(options = {}) {
        return this.#core.inspect(options);
    }
    #wrap(locator) {
        return new _a(locator, this.#ax);
    }
    async #perform(options, defaultWrite, action) {
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
            ...(observe === "diff" ? { baseline: baseline } : {}),
            ...(observe === "state" && coreOptions.observation === undefined
                ? { observation: { mode: "full", surface: "active", maxChars: AGENT_OBSERVATION_MAX_CHARS } }
                : {}),
        });
        if (write === "diff") {
            if (result.observation) {
                await this.#ax.write(result.observation);
            }
            else {
                await this.#ax.presentActionObservationOutcome(result);
            }
        }
        else if (write === "state" && result.observation) {
            await this.#ax.write(result.observation);
        }
        return result;
    }
}
_a = AgentLocator;
const AGENT_LOCATOR_FACTORIES = new Set([
    "locator",
    "getByRole",
    "getByText",
    "getByLabel",
    "getByPlaceholder",
    "getByAltText",
    "getByTitle",
    "getByTestId",
]);
/** Agent-wrapped tab discovery. Every tab keeps its own presentation baseline. */
export class AgentTabs {
    #core;
    #presenter;
    #documentation;
    #cache = new Map();
    constructor(core, presenter, documentation) {
        this.#core = core;
        this.#presenter = presenter;
        this.#documentation = documentation;
    }
    async list(options = {}) {
        return Promise.all((await this.#core.tabs.list(options)).map((tab) => this.#wrap(tab, options)));
    }
    async get(targetId, options = {}) {
        return this.#wrap(await this.#core.tabs.get(targetId, options), options);
    }
    async open(url = "about:blank", options = {}) {
        return this.#wrap(await this.#core.tabs.open(url, options), options);
    }
    async dispose() {
        await Promise.all([...this.#cache.values()].map(({ wrapped }) => wrapped.ax.dispose()));
        this.#cache.clear();
    }
    async #wrap(core, options) {
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
                const value = Reflect.get(core, property, core);
                if (typeof property === "string") {
                    const topic = documentationTopicForTabMember(property);
                    if (topic && typeof value !== "function") {
                        documentation.require(topic, `tab.${property}`);
                    }
                }
                if (typeof value !== "function") {
                    return value;
                }
                return (...args) => {
                    if (typeof property === "string") {
                        const topic = documentationTopicForTabCall(property, args);
                        if (topic) {
                            documentation.require(topic, `tab.${property}()`);
                        }
                    }
                    const result = Reflect.apply(value, core, args);
                    return AGENT_LOCATOR_FACTORIES.has(property)
                        ? new AgentLocator(result, own.ax)
                        : result;
                };
            },
        });
        this.#cache.set(core.id, { core, wrapped });
        return wrapped;
    }
}
export class AgentBrowser {
    identity;
    tabs;
    diagnostics;
    #core;
    #presenter;
    #documentation = new AgentDocumentationRegistry();
    #onDisconnect;
    constructor(core, presenter, onDisconnect) {
        this.#core = core;
        this.#presenter = presenter;
        this.#onDisconnect = onDisconnect;
        this.identity = core.identity;
        this.tabs = new AgentTabs(core, presenter, this.#documentation);
        this.diagnostics = core.diagnostics;
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
                // The socket EOF is the authoritative server-side cleanup boundary.
                // Clear any locally retained presentation state without allowing a
                // now-unreachable per-observation dispose request to make disconnect
                // appear unsuccessful.
                await this.tabs.dispose().catch(() => undefined);
            }
            finally {
                this.#onDisconnect();
            }
        }
    }
}
function documentationTopicForTabMember(property) {
    if (property === "cua")
        return "screenshot";
    return undefined;
}
function documentationTopicForTabCall(property, args) {
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
                && options.screenshot === true
                ? "screenshot"
                : undefined;
        }
        default:
            return undefined;
    }
}
let currentAgent;
/** Connects the Codex-style Agent facade to the same Core SDK and Rust runtime. */
export function connect(options = {}) {
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
function snapshotOptions(options) {
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
function agentActionOptions(options, write) {
    assertAgentOwnedObservation(options);
    return {
        ...options,
        ...(write === "diff"
            ? {
                observe: "diff",
            }
            : write === "state"
                ? {
                    observe: "state",
                    ...(options.observation === undefined
                        ? { observation: { mode: "full", surface: "active", maxChars: AGENT_OBSERVATION_MAX_CHARS } }
                        : {}),
                }
                : options.observe === undefined
                    ? { observe: "none" }
                    : {}),
    };
}
function assertAgentOwnedObservation(options) {
    if (Object.prototype.hasOwnProperty.call(options, "observe") || Object.prototype.hasOwnProperty.call(options, "baseline")) {
        throw new TypeError("@hanger-source/ab/agent actions own observation identity; use write instead of observe or baseline");
    }
}
//# sourceMappingURL=index.js.map