var _a;
import { Locator as CoreLocator, } from "../locators/index.js";
import { AX, assertAgentActionOptions, } from "./ax.js";
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
    /** Waits for one explicit URL postcondition without presenting page state. */
    waitForURL(url, options = {}) {
        return this.#core.waitForURL(url, options);
    }
    /**
     * Waits for readiness of the current document without anticipating a future navigation
     * or implying application/business completion.
     */
    waitForLoadState(state = "load", options = {}) {
        return this.#core.waitForLoadState(state, options);
    }
    #wrap(locator) {
        return Locator.create(locator, this.#ax);
    }
}
/**
 * Immutable semantic Locator with explicit post-action waits and observations.
 * Design evidence:
 * `docs/evidence/20260902__action-wait-observation-ownership-audit__@codex.md`.
 */
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
        await this.#core.waitFor(options);
    }
    elementHandle(options = {}) {
        return this.#core.elementHandle(options);
    }
    click(options = {}) {
        return this.#perform(options, (coreOptions) => this.#core.click(coreOptions));
    }
    doubleClick(options = {}) {
        return this.#perform(options, (coreOptions) => this.#core.doubleClick(coreOptions));
    }
    hover(options = {}) {
        return this.#perform(options, (coreOptions) => this.#core.hover(coreOptions));
    }
    wheel(deltaX, deltaY, options = {}) {
        return this.#perform(options, (coreOptions) => this.#core.wheel(deltaX, deltaY, coreOptions));
    }
    focus(options = {}) {
        return this.#perform(options, (coreOptions) => this.#core.focus(coreOptions));
    }
    scrollIntoView(options = {}) {
        return this.#perform(options, (coreOptions) => this.#core.scrollIntoView(coreOptions));
    }
    async fill(value, options = {}) {
        const result = await this.#perform(options, (coreOptions) => this.#core.fill(value, coreOptions));
        await this.#ax.presentTextInputOutcome(result);
        return result;
    }
    async type(text, options = {}) {
        const { clear, delayMs, ...actionOptions } = options;
        const result = await this.#perform(actionOptions, (coreOptions) => this.#core.type(text, {
            ...coreOptions,
            ...(clear === undefined ? {} : { clear }),
            ...(delayMs === undefined ? {} : { delayMs }),
        }));
        await this.#ax.presentTextInputOutcome(result);
        return result;
    }
    async fillAndSelectSuggestion(query, suggestionText, options = {}) {
        assertAgentActionOptions(options);
        const result = await this.#core.fillAndSelectSuggestion(query, suggestionText, {
            ...options,
            observe: "none",
        });
        this.#ax.applyActionResult(result.selection);
        return result;
    }
    press(key, options = {}) {
        return this.#perform(options, (coreOptions) => this.#core.press(key, coreOptions));
    }
    check(options = {}) {
        return this.#perform(options, (coreOptions) => this.#core.check(coreOptions));
    }
    uncheck(options = {}) {
        return this.#perform(options, (coreOptions) => this.#core.uncheck(coreOptions));
    }
    clear(options = {}) {
        return this.#perform(options, (coreOptions) => this.#core.clear(coreOptions));
    }
    selectOption(values, options = {}) {
        return this.#perform(options, (coreOptions) => this.#core.selectOption(values, coreOptions));
    }
    setFiles(files, options = {}) {
        return this.#perform(options, (coreOptions) => this.#core.setFiles(files, coreOptions));
    }
    dragTo(target, options = {}) {
        return this.#perform(options, (coreOptions) => this.#core.dragTo(target.#core, coreOptions));
    }
    textContent(options = {}) {
        return this.#core.textContent(options);
    }
    innerText(options = {}) {
        return this.#core.innerText(options);
    }
    domInvoke(method, argsOrOptions = [], options = {}) {
        const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
        const actionOptions = Array.isArray(argsOrOptions) ? options : argsOrOptions;
        return this.#perform(actionOptions, (coreOptions) => this.#core.domInvoke(method, args, coreOptions));
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
    async #perform(options, action) {
        assertAgentActionOptions(options);
        const result = await action({
            ...options,
            observe: "none",
        });
        this.#ax.applyActionResult(result);
        return result;
    }
}
_a = Locator;
//# sourceMappingURL=playwright.js.map