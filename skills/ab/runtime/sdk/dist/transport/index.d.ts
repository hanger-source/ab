import { type ClientReady, type RequestTarget, type ResourceClosed, type ResourceEvent, type Stage } from "../protocol.js";
type TraceFilter = {
    traceId?: string;
    requestId?: string;
};
export type ResourceMessage = ({
    type: "resource.event";
} & ResourceEvent) | ({
    type: "resource.closed";
} & ResourceClosed);
export declare class ProtocolClient {
    #private;
    readonly ready: ClientReady;
    private constructor();
    static connect(timeoutMs?: number, signal?: AbortSignal): Promise<ProtocolClient>;
    get connected(): boolean;
    onClose(callback: () => void): void;
    subscribeResource(resourceId: string, listener: (message: ResourceMessage) => void): () => void;
    traceSnapshot(filter?: TraceFilter): {
        events: readonly Stage[];
        dropped: number;
        complete: boolean;
    };
    subscribeTrace(listener: (event: Stage) => void): () => void;
    clearTraceHistory(): void;
    request<T>(method: string, params: unknown, options?: {
        target?: RequestTarget;
        timeoutMs?: number;
        signal?: AbortSignal;
    }): Promise<T>;
    disconnect(): Promise<void>;
}
export {};
//# sourceMappingURL=index.d.ts.map