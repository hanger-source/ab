import type { CDPSession, Frame, Realm } from "../browser/index.js";
import type { OperationOptions } from "../options.js";
/** Page script, frame/realm, and raw CDP diagnostics outside ordinary UI work. */
export declare class Dev {
    #private;
    private constructor();
    evaluate<T, Args extends unknown[]>(pageFunction: (...args: Args) => T | Promise<T>, ...args: Args): Promise<Awaited<T>>;
    frames(options?: OperationOptions): Promise<Frame[]>;
    mainFrame(options?: OperationOptions): Promise<Frame>;
    realms(options?: OperationOptions): Promise<Realm[]>;
    cdp(): Promise<CDPSession>;
}
//# sourceMappingURL=dev.d.ts.map