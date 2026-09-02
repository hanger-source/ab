import { type CuaActionData, type CuaClickOptions as CoreCuaClickOptions, type CuaDragOptions as CoreCuaDragOptions, type CuaPoint as CoreCuaPoint, type CuaWheelOptions as CoreCuaWheelOptions } from "../actions/cua.js";
import type { ActionResult } from "../ax/index.js";
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
export declare class CUA {
    #private;
    private constructor();
    click(options: CuaClickOptions): Promise<ActionResult<CuaActionData>>;
    move(options: CuaPoint): Promise<ActionResult<CuaActionData>>;
    wheel(options: CuaWheelOptions): Promise<ActionResult<CuaActionData>>;
    drag(options: CuaDragOptions): Promise<ActionResult<CuaActionData>>;
}
export {};
//# sourceMappingURL=cua.d.ts.map