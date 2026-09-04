import { createHash } from "node:crypto";
const MANAGED_PROVIDER = { kind: "managed" };
export function normalizeBrowserProvider(provider) {
    if (provider === undefined || provider.kind === "managed") {
        return MANAGED_PROVIDER;
    }
    let endpoint;
    try {
        endpoint = new URL(provider.webSocketUrl);
    }
    catch (cause) {
        throw new TypeError("external Chrome webSocketUrl must be an absolute WebSocket URL", {
            cause,
        });
    }
    if (endpoint.protocol !== "ws:" && endpoint.protocol !== "wss:") {
        throw new TypeError("external Chrome webSocketUrl must use ws:// or wss://");
    }
    return { kind: "external", webSocketUrl: endpoint.href };
}
export function browserProviderKey(provider) {
    if (provider.kind === "managed")
        return provider.kind;
    return `external:${providerEndpointKey(provider)}`;
}
export function providerEndpointKey(provider) {
    const endpoint = new URL(provider.webSocketUrl);
    return createHash("sha256").update(endpoint.origin).digest("hex").slice(0, 16);
}
//# sourceMappingURL=provider.js.map