import { inspect } from "node:util";
import { Screenshot } from "../artifacts/index.js";
import { ElementHandle, type ElementInspection, type ElementInspectionOptions } from "../elements/index.js";
import { type AXRef } from "../ax/index.js";
import type { ActionOptions, ActionResult, TextInputActionData } from "../actions/result.js";
import type { ProtocolClient } from "../transport/index.js";
import type { OperationOptions } from "../options.js";
import type { LocatorQuery } from "../protocol.js";
export type { LocatorQuery } from "../protocol.js";
export type LocatorActionOptions = OperationOptions & ActionOptions;
export type LocatorClickOptions = LocatorActionOptions & {
    button?: "left" | "middle" | "right";
    clickCount?: number;
};
export type LocatorWaitOptions = OperationOptions & {
    state?: "attached" | "detached" | "visible" | "hidden";
};
export type LocatorFilter = {
    visible?: boolean;
    has?: Locator;
    hasText?: string;
    exact?: boolean;
};
export type LocatorResult<TData = unknown> = ActionResult<TData>;
export type SuggestionCommitOptions = LocatorActionOptions & {
    expectedValue?: string;
    exact?: boolean;
    suggestionExact?: boolean;
};
export type SuggestionCommitResult = {
    input: LocatorResult<TextInputActionData>;
    selection: LocatorResult;
    suggestion: Pick<AXRef, "observationId" | "id" | "role" | "name">;
    committedValue: string;
};
/**
 * An immutable semantic query plan evaluated by Rust against the current page.
 * Builders do not touch the browser; strict reads and actions resolve on use.
 */
export declare class Locator {
    #private;
    readonly query: LocatorQuery;
    constructor(client: ProtocolClient, tabId: string, query: LocatorQuery, options?: {
        index?: number;
        visible?: boolean;
    });
    /** Adds relational, textual, or visibility filters without mutating this locator. */
    filter(filter: LocatorFilter): Locator;
    /** Scopes another CSS or semantic locator to descendants of this locator. */
    locator(selector: string | Locator): Locator;
    /** Intersects this query with another locator from the same tab. */
    and(other: Locator): Locator;
    /** Unions this query with another locator from the same tab. */
    or(other: Locator): Locator;
    /** Restricts this query to an explicit frame identity. */
    inFrame(frameId: string): Locator;
    nth(index: number): Locator;
    first(): Locator;
    last(): Locator;
    count(options?: OperationOptions): Promise<number>;
    all(options?: OperationOptions): Promise<Locator[]>;
    waitFor(options?: LocatorWaitOptions): Promise<void>;
    /** Resolves once and creates a server-owned handle to the exact node. */
    elementHandle(options?: OperationOptions): Promise<ElementHandle>;
    click(options?: LocatorClickOptions): Promise<LocatorResult>;
    doubleClick(options?: LocatorActionOptions): Promise<LocatorResult>;
    hover(options?: LocatorActionOptions): Promise<LocatorResult>;
    wheel(deltaX: number, deltaY: number, options?: LocatorActionOptions): Promise<LocatorResult>;
    focus(options?: LocatorActionOptions): Promise<LocatorResult>;
    scrollIntoView(options?: LocatorActionOptions): Promise<LocatorResult>;
    fill(value: string, options?: LocatorActionOptions): Promise<LocatorResult<TextInputActionData>>;
    type(text: string, options?: LocatorActionOptions & {
        clear?: boolean;
        delayMs?: number;
    }): Promise<LocatorResult<TextInputActionData>>;
    /** Completes one popup-backed input commit without exposing an intermediate ref lifecycle. */
    fillAndSelectSuggestion(query: string, suggestionText: string, options?: SuggestionCommitOptions): Promise<SuggestionCommitResult>;
    press(key: string, options?: LocatorActionOptions): Promise<LocatorResult>;
    check(options?: LocatorActionOptions): Promise<LocatorResult>;
    uncheck(options?: LocatorActionOptions): Promise<LocatorResult>;
    clear(options?: LocatorActionOptions): Promise<LocatorResult>;
    selectOption(values: string | string[], options?: LocatorActionOptions): Promise<LocatorResult>;
    setFiles(files: string | string[], options?: LocatorActionOptions): Promise<LocatorResult>;
    dragTo(target: Locator, options?: LocatorActionOptions): Promise<LocatorResult>;
    textContent(options?: OperationOptions): Promise<string>;
    innerText(options?: OperationOptions): Promise<string>;
    domInvoke<T = unknown>(method: string, args?: unknown[], options?: LocatorActionOptions): Promise<LocatorResult<{
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
    [inspect.custom](): string;
}
//# sourceMappingURL=index.d.ts.map