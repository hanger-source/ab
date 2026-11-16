import type { OperationOptions } from "../options.js";
import type { ResolvedBrowserProvider } from "./provider.js";
/** Resolves the current user's regular Google Chrome, excluding AB/custom profiles. */
export declare function discoverUserChrome(options?: OperationOptions): Promise<ResolvedBrowserProvider>;
/** Keeps known consent failures actionable without hiding unrelated runtime errors. */
export declare function userChromeConnectionError(error: unknown): unknown;
//# sourceMappingURL=user-chrome.d.ts.map