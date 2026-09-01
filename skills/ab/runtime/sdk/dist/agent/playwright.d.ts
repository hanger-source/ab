import type { Screenshot } from "../artifacts/index.js";
import type { ElementHandle, ElementInspection, ElementInspectionOptions } from "../elements/index.js";
import { Locator as CoreLocator, type LocatorActionOptions as CoreLocatorActionOptions, type LocatorClickOptions as CoreLocatorClickOptions, type LocatorFilter as CoreLocatorFilter, type LocatorResult, type LocatorWaitOptions as CoreLocatorWaitOptions, type SuggestionCommitOptions as CoreSuggestionCommitOptions, type SuggestionCommitResult } from "../locators/index.js";
import type { TextInputActionData } from "../actions/result.js";
import type { OperationOptions } from "../options.js";
import { type ActionWrite, type WriteOptions } from "./ax.js";
type OwnedActionOptions<T> = Omit<T, "observe" | "baseline">;
export type LocatorActionOptions = OwnedActionOptions<CoreLocatorActionOptions> & {
    write?: ActionWrite;
};
export type LocatorClickOptions = OwnedActionOptions<CoreLocatorClickOptions> & {
    write?: ActionWrite;
};
export type LocatorTypeOptions = LocatorActionOptions & {
    clear?: boolean;
    delayMs?: number;
};
export type SuggestionCommitOptions = OwnedActionOptions<CoreSuggestionCommitOptions> & {
    write?: ActionWrite;
};
export type LocatorWaitOptions = CoreLocatorWaitOptions & {
    /** Present a fresh full state after the semantic wait succeeds. */
    write?: "state" | "none";
    /** Shape and deadline for the post-wait state capture. */
    observation?: WriteOptions;
};
export type LocatorFilter = Omit<CoreLocatorFilter, "has"> & {
    has?: Locator;
};
export type PageWaitOptions = OperationOptions & {
    selector?: string;
    text?: string;
    state?: "attached" | "detached" | "visible" | "hidden";
};
/** Playwright-style semantic queries executed by the AB Rust runtime. */
export declare class Playwright {
    #private;
    private constructor();
    locator(selector: string): Locator;
    getByRole(role: string, options?: {
        name?: string;
        exact?: boolean;
    }): Locator;
    getByText(text: string, options?: {
        exact?: boolean;
    }): Locator;
    getByLabel(label: string, options?: {
        exact?: boolean;
    }): Locator;
    getByPlaceholder(placeholder: string, options?: {
        exact?: boolean;
    }): Locator;
    getByAltText(text: string, options?: {
        exact?: boolean;
    }): Locator;
    getByTitle(title: string, options?: {
        exact?: boolean;
    }): Locator;
    getByTestId(testId: string): Locator;
    waitFor(options: PageWaitOptions): Promise<void>;
}
/** Immutable semantic Locator with Agent-owned action presentation. */
export declare class Locator {
    #private;
    private constructor();
    get query(): CoreLocator["query"];
    filter(filter: LocatorFilter): Locator;
    locator(selector: string | Locator): Locator;
    and(other: Locator): Locator;
    or(other: Locator): Locator;
    inFrame(frameId: string): Locator;
    nth(index: number): Locator;
    first(): Locator;
    last(): Locator;
    count(options?: OperationOptions): Promise<number>;
    all(options?: OperationOptions): Promise<Locator[]>;
    waitFor(options?: LocatorWaitOptions): Promise<void>;
    elementHandle(options?: OperationOptions): Promise<ElementHandle>;
    click(options?: LocatorClickOptions): Promise<LocatorResult>;
    doubleClick(options?: LocatorActionOptions): Promise<LocatorResult>;
    hover(options?: LocatorActionOptions): Promise<LocatorResult>;
    wheel(deltaX: number, deltaY: number, options?: LocatorActionOptions): Promise<LocatorResult>;
    focus(options?: LocatorActionOptions): Promise<LocatorResult>;
    scrollIntoView(options?: LocatorActionOptions): Promise<LocatorResult>;
    fill(value: string, options?: LocatorActionOptions): Promise<LocatorResult<TextInputActionData>>;
    type(text: string, options?: LocatorTypeOptions): Promise<LocatorResult<TextInputActionData>>;
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
    domInvoke<T = unknown>(method: string, options?: LocatorActionOptions): Promise<LocatorResult<{
        value?: T;
    }>>;
    domInvoke<T = unknown>(method: string, args: unknown[], options?: LocatorActionOptions): Promise<LocatorResult<{
        value?: T;
    }>>;
    screenshot(options?: OperationOptions): Promise<Screenshot>;
    getAttribute(name: string, options?: OperationOptions): Promise<string | null>;
    boundingBox(options?: OperationOptions): ReturnType<CoreLocator["boundingBox"]>;
    isVisible(options?: OperationOptions): Promise<boolean>;
    isEnabled(options?: OperationOptions): Promise<boolean>;
    isChecked(options?: OperationOptions): Promise<boolean>;
    inputValue(options?: OperationOptions): Promise<string>;
    inspect(options?: ElementInspectionOptions): Promise<ElementInspection>;
}
export {};
//# sourceMappingURL=playwright.d.ts.map