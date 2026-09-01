import { inspect } from "node:util";
import type { ErrorContext } from "../protocol.js";
export type ABErrorData = {
    kind: string;
    stage: string;
    message: string;
    retryable?: boolean;
    context?: ErrorContext | null;
    details?: unknown;
};
/** Stable structured error returned by the SDK or Rust runtime. */
export declare class ABError extends Error {
    readonly kind: string;
    readonly stage: string;
    readonly retryable: boolean;
    readonly context?: ErrorContext;
    readonly details?: unknown;
    constructor(data: ABErrorData);
    [inspect.custom](): string;
}
//# sourceMappingURL=index.d.ts.map