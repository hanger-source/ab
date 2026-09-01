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
export class ABError extends Error {
  readonly kind: string;
  readonly stage: string;
  readonly retryable: boolean;
  readonly context?: ErrorContext;
  readonly details?: unknown;

  constructor(data: ABErrorData) {
    super(data.message);
    this.name = "ABError";
    this.kind = data.kind;
    this.stage = data.stage;
    this.retryable = data.retryable ?? false;
    if (data.context != null) {
      this.context = data.context;
    }
    if (data.details !== undefined) {
      this.details = data.details;
    }
  }

  [inspect.custom](): string {
    return `ABError ${inspect({
      kind: this.kind,
      stage: this.stage,
      message: this.message,
      retryable: this.retryable,
      ...(this.context === undefined ? {} : { context: this.context }),
      ...(this.details === undefined ? {} : { details: this.details }),
    }, { colors: false, depth: 6, compact: 2, breakLength: 100 })}`;
  }
}
