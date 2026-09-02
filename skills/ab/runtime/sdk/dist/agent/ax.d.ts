import type { Screenshot, ScreenshotScale } from "../artifacts/index.js";
import type { PageObservation } from "../browser/index.js";
import { type ActionResult, type AXState, type ClickOptions, type RefActionOptions as CoreRefActionOptions, type SnapshotOptions, type TypeOptions } from "../ax/index.js";
import type { TextInputActionData } from "../actions/result.js";
import type { OperationOptions } from "../options.js";
export type AXContent = "state" | "screenshot" | "both";
export type AXWriteContent = AXContent | "diff";
export type WriteOptions = SnapshotOptions & {
    fullPage?: boolean;
    scale?: ScreenshotScale;
};
type AgentActionOptions<T> = Omit<T, "observe" | "baseline" | "observation">;
export type RefActionOptions = AgentActionOptions<CoreRefActionOptions>;
export type ClickActionOptions = AgentActionOptions<ClickOptions>;
export type TypeActionOptions = AgentActionOptions<TypeOptions>;
/**
 * Agent-facing AX observation and short-ref actions.
 *
 * Actions deliberately do not capture or present post-action state. The Agent
 * chooses an explicit wait or `write()` at the next decision boundary. See
 * `docs/evidence/20260902__action-wait-observation-ownership-audit__@codex.md`.
 */
export declare class AX {
    #private;
    private constructor();
    get(content: "state", options?: WriteOptions): Promise<AXState>;
    get(content: "screenshot", options?: WriteOptions): Promise<Screenshot>;
    get(content: "both", options?: WriteOptions): Promise<PageObservation>;
    write(content: "state", options?: WriteOptions): Promise<AXState>;
    write(content: "diff", options?: OperationOptions): Promise<AXState>;
    write(content: "screenshot", options?: WriteOptions): Promise<Screenshot>;
    write(content: "both", options?: WriteOptions): Promise<{
        state: AXState;
        screenshot: Screenshot;
    }>;
    write(content: AXWriteContent, options?: WriteOptions): Promise<AXState | Screenshot | {
        state: AXState;
        screenshot: Screenshot;
    }>;
    write(state: AXState): Promise<AXState>;
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
    /** Releases every live AX observation owned by this Agent tab. The AX surface remains usable. */
    dispose(): Promise<void>;
    /** Number of live AX observations currently retained by this Agent tab. */
    get liveObservations(): number;
}
export {};
//# sourceMappingURL=ax.d.ts.map