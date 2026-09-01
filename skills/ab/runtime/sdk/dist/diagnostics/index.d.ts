import type { Stage } from "../protocol.js";
import type { ProtocolClient } from "../transport/index.js";
export type TraceEvent = Stage;
export type TraceFilter = {
    traceId?: string;
    requestId?: string;
};
export type TraceSnapshot = {
    events: readonly TraceEvent[];
    dropped: number;
    complete: boolean;
};
/** Bounded, content-safe request stage history for this SDK connection. */
export declare class Diagnostics {
    #private;
    constructor(client: ProtocolClient);
    snapshot(filter?: TraceFilter): TraceSnapshot;
    onTrace(listener: (event: TraceEvent) => void): () => void;
    clear(): void;
}
//# sourceMappingURL=index.d.ts.map