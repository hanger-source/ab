import type { ProtocolClient } from "../transport/index.js";
import type { OperationOptions } from "../options.js";
import type { ActionOptions, ActionResult } from "./result.js";
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
    from: {
        x: number;
        y: number;
    };
    to: {
        x: number;
        y: number;
    };
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
export declare class CUA {
    #private;
    constructor(client: ProtocolClient, tabId: string);
    click(options: CuaClickOptions): Promise<ActionResult<CuaActionData>>;
    move(options: CuaPoint): Promise<ActionResult<CuaActionData>>;
    wheel(options: CuaWheelOptions): Promise<ActionResult<CuaActionData>>;
    drag(options: CuaDragOptions): Promise<ActionResult<CuaActionData>>;
}
//# sourceMappingURL=cua.d.ts.map