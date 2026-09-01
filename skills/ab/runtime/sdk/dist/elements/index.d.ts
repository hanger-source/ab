import { inspect } from "node:util";
import { Screenshot } from "../artifacts/index.js";
import type { OperationOptions } from "../options.js";
import type { ProtocolClient } from "../transport/index.js";
import type { ActionOptions, ActionResult, TextInputActionData } from "../actions/result.js";
import type { ElementInspection, ElementInspectionRequest } from "../protocol.js";
export type ElementActionOptions = OperationOptions & ActionOptions;
export type ElementInspectionOptions = OperationOptions & ElementInspectionRequest;
export type { ElementBounds, ElementInspection, ElementInspectionRequest } from "../protocol.js";
export type ElementHandleDescriptor = {
    id: string;
    targetId: string;
    frameId: string;
    documentGeneration: string;
    backendNodeId: number;
};
/**
 * Server-owned handle to one backend node in one frame/document generation.
 * It never reruns the Locator or searches for a semantically similar node.
 */
export declare class ElementHandle {
    #private;
    readonly id: string;
    readonly targetId: string;
    readonly frameId: string;
    readonly documentGeneration: string;
    readonly backendNodeId: number;
    constructor(client: ProtocolClient, value: ElementHandleDescriptor);
    click(options?: ElementActionOptions & {
        button?: "left" | "middle" | "right";
        clickCount?: number;
    }): Promise<ActionResult>;
    doubleClick(options?: ElementActionOptions): Promise<ActionResult>;
    hover(options?: ElementActionOptions): Promise<ActionResult>;
    wheel(deltaX: number, deltaY: number, options?: ElementActionOptions): Promise<ActionResult>;
    focus(options?: ElementActionOptions): Promise<ActionResult>;
    clear(options?: ElementActionOptions): Promise<ActionResult>;
    scrollIntoView(options?: ElementActionOptions): Promise<ActionResult>;
    fill(value: string, options?: ElementActionOptions): Promise<ActionResult<TextInputActionData>>;
    type(text: string, options?: ElementActionOptions & {
        clear?: boolean;
        delayMs?: number;
    }): Promise<ActionResult<TextInputActionData>>;
    press(key: string, options?: ElementActionOptions): Promise<ActionResult>;
    check(options?: ElementActionOptions): Promise<ActionResult>;
    uncheck(options?: ElementActionOptions): Promise<ActionResult>;
    selectOption(values: string | string[], options?: ElementActionOptions): Promise<ActionResult>;
    setFiles(files: string | string[], options?: ElementActionOptions): Promise<ActionResult>;
    dragTo(target: ElementHandle, options?: ElementActionOptions): Promise<ActionResult>;
    textContent(options?: OperationOptions): Promise<string>;
    innerText(options?: OperationOptions): Promise<string>;
    domInvoke<T = unknown>(method: string, args?: unknown[], options?: ElementActionOptions): Promise<ActionResult<{
        value?: T;
    }>>;
    screenshot(options?: OperationOptions): Promise<Screenshot>;
    getAttribute(name: string, options?: OperationOptions): Promise<string | null>;
    boundingBox(options?: OperationOptions): Promise<{
        x: number;
        y: number;
        width: number;
        height: number;
    } | null>;
    isVisible(options?: OperationOptions): Promise<boolean>;
    isEnabled(options?: OperationOptions): Promise<boolean>;
    isChecked(options?: OperationOptions): Promise<boolean>;
    inputValue(options?: OperationOptions): Promise<string>;
    inspect(options?: ElementInspectionOptions): Promise<ElementInspection>;
    /** Releases this handle; the owning client also releases it on disconnect. */
    dispose(options?: OperationOptions): Promise<void>;
    [inspect.custom](): string;
}
//# sourceMappingURL=index.d.ts.map