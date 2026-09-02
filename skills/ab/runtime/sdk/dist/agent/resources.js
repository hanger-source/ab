/** Long-lived browser event and file-resource entrypoints. */
export class Resources {
    #core;
    #documentation;
    constructor(core, documentation) {
        this.#core = core;
        this.#documentation = documentation;
    }
    /** @internal */
    static create(core, documentation) {
        return new Resources(core, documentation);
    }
    network(options = {}) {
        this.#documentation.require("network", "tab.resources.network()");
        return this.#core.observeNetwork(options);
    }
    console(options = {}) {
        this.#documentation.require("console-dialogs", "tab.resources.console()");
        return this.#core.observeConsole(options);
    }
    dialogs(options = {}) {
        this.#documentation.require("console-dialogs", "tab.resources.dialogs()");
        return this.#core.watchDialogs(options);
    }
    popups(options = {}) {
        this.#documentation.require("tabs", "tab.resources.popups()");
        return this.#core.watchPopups(options);
    }
    downloads(options = {}) {
        this.#documentation.require("downloads", "tab.resources.downloads()");
        return this.#core.watchDownloads(options);
    }
    fileChoosers(options = {}) {
        this.#documentation.require("downloads", "tab.resources.fileChoosers()");
        return this.#core.watchFileChoosers(options);
    }
    initScripts(definition, options = {}) {
        this.#documentation.require("init-scripts", "tab.resources.initScripts()");
        return this.#core.addInitScript(definition, options);
    }
}
//# sourceMappingURL=resources.js.map