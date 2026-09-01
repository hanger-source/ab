import type { ProtocolClient } from "../transport/index.js";
import type { OperationOptions } from "../options.js";
import { AXState } from "../ax/index.js";
import type { ActionOptions, ActionResult, ActionWire } from "./result.js";

export type CuaPoint = OperationOptions & ActionOptions & {
  x: number;
  y: number;
  viewportId: string;
};

export type CuaClickOptions = CuaPoint & {
  button?: "left" | "middle" | "right";
  clickCount?: number;
};

export type CuaWheelOptions = CuaPoint & {
  deltaX?: number;
  deltaY?: number;
};

export type CuaDragOptions = OperationOptions & ActionOptions & {
  from: { x: number; y: number };
  to: { x: number; y: number };
  viewportId: string;
};

export type CuaActionData = {
  operation: "click" | "move" | "wheel" | "drag";
  x: number;
  y: number;
  endX?: number;
  endY?: number;
  viewportId: string;
  dispatch: Record<string, unknown>;
};

/** Coordinate input bound to a Screenshot viewport identity. */
export class CUA {
  readonly #client: ProtocolClient;
  readonly #tabId: string;

  constructor(client: ProtocolClient, tabId: string) {
    this.#client = client;
    this.#tabId = tabId;
  }

  click(options: CuaClickOptions): Promise<ActionResult<CuaActionData>> {
    return this.#perform({
      operation: "click",
      ...options,
      button: options.button ?? "left",
      clickCount: options.clickCount ?? 1,
    });
  }

  move(options: CuaPoint): Promise<ActionResult<CuaActionData>> {
    return this.#perform({ operation: "move", ...options });
  }

  wheel(options: CuaWheelOptions): Promise<ActionResult<CuaActionData>> {
    return this.#perform({
      operation: "wheel",
      ...options,
      deltaX: options.deltaX ?? 0,
      deltaY: options.deltaY ?? 0,
    });
  }

  drag(options: CuaDragOptions): Promise<ActionResult<CuaActionData>> {
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

  async #perform(params: Record<string, unknown>): Promise<ActionResult<CuaActionData>> {
    const { timeoutMs, signal, baseline, ...wire } = params as Record<string, unknown> & OperationOptions & ActionOptions;
    const baselineObservationId = baseline === undefined
      ? undefined
      : typeof baseline === "string"
        ? baseline
        : baseline.id;
    const result = await this.#client.request<ActionWire<CuaActionData>>(
      "cua.perform",
      {
        ...wire,
        ...(baselineObservationId === undefined ? {} : { baselineObservationId }),
      },
      {
        target: { tabId: this.#tabId },
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        ...(signal === undefined ? {} : { signal }),
      },
    );
    return {
      ...result,
      observation: result.observation
        ? new AXState(this.#client, result.observation)
        : null,
    };
  }
}
