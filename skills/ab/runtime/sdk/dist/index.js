import { Browser } from "./browser/index.js";
import { ProtocolClient } from "./transport/index.js";
import { browserProviderKey, normalizeBrowserProvider, } from "./runtime/provider.js";
export { ABError } from "./errors/index.js";
export { Diagnostics, } from "./diagnostics/index.js";
export { Artifact, Screenshot, } from "./artifacts/index.js";
export { ElementHandle, } from "./elements/index.js";
export { ConsoleObserver, Dialog, DialogWatcher, Download, DownloadWatcher, FileChooserWatcher, InitScriptRegistration, NetworkObserver, PopupWatcher, Resource, } from "./resources/index.js";
export { CUA, } from "./actions/cua.js";
export { Locator, } from "./locators/index.js";
export { AX, AXRef, AXState, } from "./ax/index.js";
export { Browser, CDPSession, Frame, Realm, Tab, Tabs, } from "./browser/index.js";
let currentBrowser;
let currentProviderKey;
/**
 * Connects this JavaScript process to the persistent AB browser runtime.
 *
 * The SDK first connects to the fixed per-user Unix socket. If no daemon is
 * listening, it launches the exact native runtime shipped with this SDK and
 * waits for the same handshake. Repeated calls in one process share a client.
 */
export function connect(options = {}) {
    const provider = normalizeBrowserProvider(options.provider);
    const providerKey = browserProviderKey(provider);
    if (currentBrowser) {
        if (currentProviderKey !== providerKey) {
            return Promise.reject(new Error("this JavaScript process is already connected to a different AB browser provider; disconnect it before connecting another provider"));
        }
        return currentBrowser;
    }
    if (options.signal?.aborted) {
        return Promise.reject(new DOMException("AB connection was cancelled", "AbortError"));
    }
    const connecting = ProtocolClient.connect(provider, options.timeoutMs, options.signal).then((client) => {
        return new Browser(client, () => {
            if (currentBrowser === connecting) {
                currentBrowser = undefined;
                currentProviderKey = undefined;
            }
        });
    });
    currentBrowser = connecting;
    currentProviderKey = providerKey;
    void connecting.catch(() => {
        if (currentBrowser === connecting) {
            currentBrowser = undefined;
            currentProviderKey = undefined;
        }
    });
    return connecting;
}
//# sourceMappingURL=index.js.map