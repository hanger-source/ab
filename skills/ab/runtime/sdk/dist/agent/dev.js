/** Page script, frame/realm, and raw CDP diagnostics outside ordinary UI work. */
export class Dev {
    #core;
    #documentation;
    constructor(core, documentation) {
        this.#core = core;
        this.#documentation = documentation;
    }
    /** @internal */
    static create(core, documentation) {
        return new Dev(core, documentation);
    }
    evaluate(pageFunction, ...args) {
        this.#documentation.require("evaluate", "tab.dev.evaluate()");
        return this.#core.evaluate(pageFunction, ...args);
    }
    frames(options = {}) {
        this.#documentation.require("frames", "tab.dev.frames()");
        return this.#core.frames(options);
    }
    mainFrame(options = {}) {
        this.#documentation.require("frames", "tab.dev.mainFrame()");
        return this.#core.mainFrame(options);
    }
    realms(options = {}) {
        this.#documentation.require("frames", "tab.dev.realms()");
        return this.#core.realms(options);
    }
    cdp() {
        this.#documentation.require("cdp", "tab.dev.cdp()");
        return this.#core.cdp();
    }
}
//# sourceMappingURL=dev.js.map