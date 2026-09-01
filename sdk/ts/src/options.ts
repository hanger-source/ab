/** Caller-side deadline and cancellation shared by public operations. */
export type OperationOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
};
