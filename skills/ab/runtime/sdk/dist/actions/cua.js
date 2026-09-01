import { AXState } from "../ax/index.js";
/** Coordinate input bound to a Screenshot viewport identity. */
export class CUA {
    #client;
    #tabId;
    constructor(client, tabId) {
        this.#client = client;
        this.#tabId = tabId;
    }
    click(options) {
        return this.#perform({
            operation: "click",
            ...options,
            button: options.button ?? "left",
            clickCount: options.clickCount ?? 1,
        });
    }
    move(options) {
        return this.#perform({ operation: "move", ...options });
    }
    wheel(options) {
        return this.#perform({
            operation: "wheel",
            ...options,
            deltaX: options.deltaX ?? 0,
            deltaY: options.deltaY ?? 0,
        });
    }
    drag(options) {
        const { from, to, ...action } = options;
        return this.#perform({
            operation: "drag",
            x: from.x,
            y: from.y,
            endX: to.x,
            endY: to.y,
            ...action,
        });
    }
    async #perform(params) {
        const { timeoutMs, signal, baseline, ...wire } = params;
        const baselineObservationId = baseline === undefined
            ? undefined
            : typeof baseline === "string"
                ? baseline
                : baseline.id;
        const result = await this.#client.request("cua.perform", {
            ...wire,
            ...(baselineObservationId === undefined ? {} : { baselineObservationId }),
        }, {
            target: { tabId: this.#tabId },
            ...(timeoutMs === undefined ? {} : { timeoutMs }),
            ...(signal === undefined ? {} : { signal }),
        });
        return {
            ...result,
            observation: result.observation
                ? new AXState(this.#client, result.observation)
                : null,
        };
    }
}
//# sourceMappingURL=cua.js.map