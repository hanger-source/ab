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
export class Diagnostics {
  readonly #client: ProtocolClient;

  constructor(client: ProtocolClient) {
    this.#client = client;
  }

  snapshot(filter: TraceFilter = {}): TraceSnapshot {
    return this.#client.traceSnapshot(filter);
  }

  onTrace(listener: (event: TraceEvent) => void): () => void {
    return this.#client.subscribeTrace(listener);
  }

  clear(): void {
    this.#client.clearTraceHistory();
  }
}
