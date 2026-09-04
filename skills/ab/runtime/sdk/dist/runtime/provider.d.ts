import type { BrowserProvider } from "../options.js";
export declare function normalizeBrowserProvider(provider?: BrowserProvider): BrowserProvider;
export declare function browserProviderKey(provider: BrowserProvider): string;
export declare function providerEndpointKey(provider: Extract<BrowserProvider, {
    kind: "external";
}>): string;
//# sourceMappingURL=provider.d.ts.map