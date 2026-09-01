import { CUA as CoreCUA, } from "../actions/cua.js";
import { AX, OBSERVATION_MAX_CHARS } from "./ax.js";
/** Viewport input bound to the Agent's presented AX baseline. */
export class CUA {
    #core;
    #ax;
    constructor(core, ax) {
        this.#core = core;
        this.#ax = ax;
    }
    /** @internal */
    static create(core, ax) {
        return new CUA(core, ax);
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
                ? { observation: { mode: "full", surface: "active", maxChars: OBSERVATION_MAX_CHARS } }
                : {}),
        });
        this.#ax.applyActionResult(result);
        if (result.observation)
            await this.#ax.write(result.observation);
        return result;
    }
}
//# sourceMappingURL=cua.js.map