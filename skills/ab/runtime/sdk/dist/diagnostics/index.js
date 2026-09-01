/** Bounded, content-safe request stage history for this SDK connection. */
export class Diagnostics {
    #client;
    constructor(client) {
        this.#client = client;
    }
    snapshot(filter = {}) {
        return this.#client.traceSnapshot(filter);
    }
    onTrace(listener) {
        return this.#client.subscribeTrace(listener);
    }
    clear() {
        this.#client.clearTraceHistory();
    }
}
//# sourceMappingURL=index.js.map