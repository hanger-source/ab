/** Caller-side deadline and cancellation shared by public operations. */
export type OperationOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type BrowserProvider =
  | { kind: "managed" }
  | { kind: "external"; webSocketUrl: string };

export type ConnectOptions = OperationOptions & {
  provider?: BrowserProvider;
};
