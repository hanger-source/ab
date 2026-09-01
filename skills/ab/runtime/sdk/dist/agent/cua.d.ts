import { type CuaActionData, type CuaClickOptions, type CuaDragOptions, type CuaPoint, type CuaWheelOptions } from "../actions/cua.js";
import type { ActionResult } from "../ax/index.js";
/** Viewport input bound to the Agent's presented AX baseline. */
export declare class CUA {
    #private;
    private constructor();
    click(options: CuaClickOptions): Promise<ActionResult<CuaActionData>>;
    move(options: CuaPoint): Promise<ActionResult<CuaActionData>>;
    wheel(options: CuaWheelOptions): Promise<ActionResult<CuaActionData>>;
    drag(options: CuaDragOptions): Promise<ActionResult<CuaActionData>>;
}
//# sourceMappingURL=cua.d.ts.map