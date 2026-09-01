import type { AXState, ObservationWire, SnapshotOptions } from "../ax/index.js";

export type ActionSource = "axRef" | "locator" | "elementHandle" | "cua";

export type ActionCoordinateIdentity = {
  viewportId: string;
  x: number;
  y: number;
  endX?: number;
  endY?: number;
};

export type ActionTargetIdentity = {
  source: ActionSource;
  targetId: string;
  sessionId: string;
  frameId: string;
  documentGeneration: string;
  backendNodeId?: number;
  coordinate?: ActionCoordinateIdentity;
  observationId?: string;
  refId?: string;
  elementId?: string;
};

export type ActionTiming = {
  startedAtUnixMs: number;
  endedAtUnixMs: number;
  durationMs: number;
};

export type NavigationChange = {
  beforeUrl: string;
  afterUrl: string;
  changed: boolean;
};

export type DocumentChange = {
  beforeGeneration: string;
  afterGeneration: string;
  changed: boolean;
};

export type ActionDialog = {
  opened: boolean;
  dialog?: {
    id: string;
    rootTargetId: string;
    sessionId: string;
    type: string;
    message: string;
    url: string;
    defaultPrompt: string;
    hasBrowserHandler: boolean;
  };
};

export type ActionFileChooser = {
  opened: boolean;
  complete: boolean;
  sessionId?: string;
  frameId?: string;
  backendNodeId?: number;
  mode?: string;
};

export type ActionObservationOutcome = {
  status: "notRequested" | "completed" | "skippedDialog" | "failed";
  error?: {
    kind: string;
    stage: string;
    message: string;
    retryable: boolean;
    context?: Record<string, unknown>;
    details?: unknown;
  };
};

export type TextInputFieldOutcome = {
  requestedText: string;
  inputValue: string | null;
  popupBacked: boolean;
  signals: string[];
  next: "selectSuggestion" | "none";
};

export type TextInputActionData = {
  field: TextInputFieldOutcome;
};

export type ActionResult<TData = unknown> = {
  id: string;
  action: string;
  target: ActionTargetIdentity;
  dispatchMechanism: string;
  timing: ActionTiming;
  navigation: NavigationChange;
  document: DocumentChange;
  dialog: ActionDialog;
  fileChooser: ActionFileChooser;
  pendingRelease: boolean;
  observationOutcome: ActionObservationOutcome;
  lastStage: string;
  data: TData;
  observation: AXState | null;
};

export type ActionWire<TData = unknown> = Omit<ActionResult<TData>, "observation"> & {
  observation?: ObservationWire | null;
};

export type ActionObservationOptions = Pick<
  SnapshotOptions,
  "mode" | "surface" | "frames" | "maxDepth" | "maxChars" | "includeUrls"
>;

export type ActionOptions = {
  observe?: "diff" | "state" | "none";
  /** Existing observation used as the explicit baseline when `observe` is `diff`. */
  baseline?: import("../ax/index.js").AXState | string;
  /** Capture shape for the post-action observation. */
  observation?: ActionObservationOptions;
};
