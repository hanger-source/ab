import {
  CUA as CoreCUA,
  type CuaActionData,
  type CuaClickOptions,
  type CuaDragOptions,
  type CuaPoint,
  type CuaWheelOptions,
} from "../actions/cua.js";
import type { ActionResult } from "../ax/index.js";
import { AX, OBSERVATION_MAX_CHARS } from "./ax.js";

/** Viewport input bound to the Agent's presented AX baseline. */
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
    return this.#perform(options, (action) => this.#core.click(action as CuaClickOptions));
  }

  move(options: CuaPoint): Promise<ActionResult<CuaActionData>> {
    return this.#perform(options, (action) => this.#core.move(action as CuaPoint));
  }

  wheel(options: CuaWheelOptions): Promise<ActionResult<CuaActionData>> {
    return this.#perform(options, (action) => this.#core.wheel(action as CuaWheelOptions));
  }

  drag(options: CuaDragOptions): Promise<ActionResult<CuaActionData>> {
    return this.#perform(options, (action) => this.#core.drag(action as CuaDragOptions));
  }

  async #perform<T extends CuaPoint | CuaDragOptions>(
    options: T,
    action: (options: T) => Promise<ActionResult<CuaActionData>>,
  ): Promise<ActionResult<CuaActionData>> {
    const baseline = options.baseline ?? this.#ax.actionBaseline();
    const requested = options.observe ?? "none";
    const observe = requested === "diff" && !baseline ? "state" : requested;
    const result = await action({
      ...options,
      observe,
      ...(observe === "diff" ? { baseline: baseline! } : {}),
      ...(observe === "state" && options.observation === undefined
        ? { observation: { mode: "full", surface: "active", maxChars: OBSERVATION_MAX_CHARS } as const }
        : {}),
    });
    if (result.observation) await this.#ax.write(result.observation);
    return result;
  }
}
