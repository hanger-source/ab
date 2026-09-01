import type { Screenshot, ScreenshotScale } from "../artifacts/index.js";
import type { PageObservation } from "../browser/index.js";
import { type ActionResult, type AXState, type ClickOptions, type RefActionOptions as CoreRefActionOptions, type SnapshotOptions, type TypeOptions } from "../ax/index.js";
import type { TextInputActionData } from "../actions/result.js";
export type AXContent = "state" | "screenshot" | "both";
export type WriteOptions = SnapshotOptions & {
    fullPage?: boolean;
    scale?: ScreenshotScale;
};
export type ActionWrite = "diff" | "state" | "none";
type OwnedActionOptions<T> = Omit<T, "observe" | "baseline">;
export type RefActionOptions = OwnedActionOptions<CoreRefActionOptions> & {
    write?: ActionWrite;
};
export type ClickActionOptions = OwnedActionOptions<ClickOptions> & {
    write?: ActionWrite;
};
export type TypeActionOptions = OwnedActionOptions<TypeOptions> & {
    write?: ActionWrite;
};
export declare class AX {
    #private;
    private constructor();
    get(content: "state", options?: WriteOptions): Promise<AXState>;
    get(content: "screenshot", options?: WriteOptions): Promise<Screenshot>;
    get(content: "both", options?: WriteOptions): Promise<PageObservation>;
    write(content: AXContent, options?: WriteOptions): Promise<void>;
    write(state: AXState): Promise<void>;
    click(refId: string, options?: ClickActionOptions): Promise<ActionResult>;
    doubleClick(refId: string, options?: RefActionOptions): Promise<ActionResult>;
    hover(refId: string, options?: RefActionOptions): Promise<ActionResult>;
    wheel(refId: string, deltaX: number, deltaY: number, options?: RefActionOptions): Promise<ActionResult>;
    fill(refId: string, value: string, options?: RefActionOptions): Promise<ActionResult<TextInputActionData>>;
    type(refId: string, text: string, options?: TypeActionOptions): Promise<ActionResult<TextInputActionData>>;
    press(refId: string, key: string, options?: RefActionOptions): Promise<ActionResult>;
    focus(refId: string, options?: RefActionOptions): Promise<ActionResult>;
    clear(refId: string, options?: RefActionOptions): Promise<ActionResult>;
    check(refId: string, options?: RefActionOptions): Promise<ActionResult>;
    uncheck(refId: string, options?: RefActionOptions): Promise<ActionResult>;
    selectOption(refId: string, values: string | string[], options?: RefActionOptions): Promise<ActionResult>;
    setFiles(refId: string, files: string | string[], options?: RefActionOptions): Promise<ActionResult>;
    dragTo(sourceRefId: string, targetRefId: string, options?: RefActionOptions): Promise<ActionResult>;
    scrollIntoView(refId: string, options?: RefActionOptions): Promise<ActionResult>;
}
export {};
//# sourceMappingURL=ax.d.ts.map