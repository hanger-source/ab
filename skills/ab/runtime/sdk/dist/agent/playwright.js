var _a;
import { Locator as CoreLocator, } from "../locators/index.js";
import { AX, OBSERVATION_MAX_CHARS, assertOwnedObservation, } from "./ax.js";
/** Playwright-style semantic queries executed by the AB Rust runtime. */
export class Playwright {
    #core;
    #ax;
    constructor(core, ax) {
        this.#core = core;
        this.#ax = ax;
    }
    /** @internal */
    static create(core, ax) {
        return new Playwright(core, ax);
    }
    locator(selector) {
        return this.#wrap(this.#core.locator(selector));
    }
    getByRole(role, options = {}) {
        return this.#wrap(this.#core.getByRole(role, options));
    }
    getByText(text, options = {}) {
        return this.#wrap(this.#core.getByText(text, options));
    }
    getByLabel(label, options = {}) {
        return this.#wrap(this.#core.getByLabel(label, options));
    }
    getByPlaceholder(placeholder, options = {}) {
        return this.#wrap(this.#core.getByPlaceholder(placeholder, options));
    }
    getByAltText(text, options = {}) {
        return this.#wrap(this.#core.getByAltText(text, options));
    }
    getByTitle(title, options = {}) {
        return this.#wrap(this.#core.getByTitle(title, options));
    }
    getByTestId(testId) {
        return this.#wrap(this.#core.getByTestId(testId));
    }
    waitFor(options) {
        return this.#core.waitFor(options);
    }
    #wrap(locator) {
        return Locator.create(locator, this.#ax);
    }
}
/** Immutable semantic Locator with Agent-owned action presentation. */
export class Locator {
    #core;
    #ax;
    constructor(core, ax) {
        this.#core = core;
        this.#ax = ax;
    }
    /** @internal */
    static create(core, ax) {
        return new _a(core, ax);
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
        if (write === "state")
            await this.#ax.write("state", observation);
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
        assertOwnedObservation(options);
        const { write = "diff", ...coreOptions } = options;
        const observe = write === "diff" ? "diff" : write === "state" ? "state" : "none";
        const result = await this.#core.fillAndSelectSuggestion(query, suggestionText, {
            ...coreOptions,
            observe,
            ...(observe === "state" && coreOptions.observation === undefined
                ? { observation: { mode: "full", surface: "active", maxChars: OBSERVATION_MAX_CHARS } }
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
        return _a.create(locator, this.#ax);
    }
    async #perform(options, defaultWrite, action) {
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
            ...(observe === "diff" ? { baseline: baseline } : {}),
            ...(observe === "state" && coreOptions.observation === undefined
                ? { observation: { mode: "full", surface: "active", maxChars: OBSERVATION_MAX_CHARS } }
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
_a = Locator;
//# sourceMappingURL=playwright.js.map