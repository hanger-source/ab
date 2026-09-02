import { CUA as CoreCUA, } from "../actions/cua.js";
import { AX, assertAgentActionOptions } from "./ax.js";
/**
 * Viewport input whose coordinates must come from the currently visible
 * viewport. CUA dispatch is separate from any later observation. See
 * `docs/evidence/20260902__action-wait-observation-ownership-audit__@codex.md`.
 */
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
        assertAgentActionOptions(options);
        const result = await action({
            ...options,
            observe: "none",
        });
        this.#ax.applyActionResult(result);
        return result;
    }
}
//# sourceMappingURL=cua.js.map