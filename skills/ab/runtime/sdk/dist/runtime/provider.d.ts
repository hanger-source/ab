import type { BrowserProvider } from "../options.js";
/** A concrete endpoint or AB-owned browser, ready for the native transport. */
export type ResolvedBrowserProvider = Exclude<BrowserProvider, {
    kind: "user";
}>;
export declare function normalizeBrowserProvider(provider?: BrowserProvider): BrowserProvider;
export declare function browserProviderKey(provider: BrowserProvider): string;
export declare function providerEndpointKey(provider: Extract<BrowserProvider, {
    kind: "external";
}>): string;
//# sourceMappingURL=provider.d.ts.map