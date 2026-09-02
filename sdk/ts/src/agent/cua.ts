import {
  CUA as CoreCUA,
  type CuaActionData,
  type CuaClickOptions as CoreCuaClickOptions,
  type CuaDragOptions as CoreCuaDragOptions,
  type CuaPoint as CoreCuaPoint,
  type CuaWheelOptions as CoreCuaWheelOptions,
} from "../actions/cua.js";
import type { ActionResult } from "../ax/index.js";
import { AX, assertAgentActionOptions } from "./ax.js";

type AgentCuaOptions<T> = Omit<T, "observe" | "baseline" | "observation">;

export type CuaPoint = AgentCuaOptions<CoreCuaPoint>;
export type CuaClickOptions = AgentCuaOptions<CoreCuaClickOptions>;
export type CuaWheelOptions = AgentCuaOptions<CoreCuaWheelOptions>;
export type CuaDragOptions = AgentCuaOptions<CoreCuaDragOptions>;

/**
 * Viewport input whose coordinates must come from the currently visible
 * viewport. CUA dispatch is separate from any later observation. See
 * `docs/evidence/20260902__action-wait-observation-ownership-audit__@codex.md`.
 */
export class CUA {
  readonly #core: CoreCUA;
  readonly #ax: AX;

  private constructor(core: CoreCUA, ax: AX) {
    this.#core = core;
    this.#ax = ax;
  }

  /** @internal */
  static create(core: CoreCUA, ax: AX): CUA {
    return new CUA(core, ax);
  }

  click(options: CuaClickOptions): Promise<ActionResult<CuaActionData>> {
    return this.#perform(options, (action) => this.#core.click(action as CoreCuaClickOptions));
  }

  move(options: CuaPoint): Promise<ActionResult<CuaActionData>> {
    return this.#perform(options, (action) => this.#core.move(action as CoreCuaPoint));
  }

  wheel(options: CuaWheelOptions): Promise<ActionResult<CuaActionData>> {
    return this.#perform(options, (action) => this.#core.wheel(action as CoreCuaWheelOptions));
  }

  drag(options: CuaDragOptions): Promise<ActionResult<CuaActionData>> {
    return this.#perform(options, (action) => this.#core.drag(action as CoreCuaDragOptions));
  }

  async #perform<T extends CuaPoint | CuaDragOptions>(
    options: T,
    action: (options: T & { observe: "none" }) => Promise<ActionResult<CuaActionData>>,
  ): Promise<ActionResult<CuaActionData>> {
    assertAgentActionOptions(options);
    const result = await action({
      ...options,
      observe: "none",
    });
    this.#ax.applyActionResult(result);
    return result;
  }
}
