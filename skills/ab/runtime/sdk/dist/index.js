import { Browser } from "./browser/index.js";
import { ProtocolClient } from "./transport/index.js";
export { ABError } from "./errors/index.js";
export { Diagnostics, } from "./diagnostics/index.js";
export { Artifact, Screenshot, } from "./artifacts/index.js";
export { ElementHandle, } from "./elements/index.js";
export { ConsoleObserver, Dialog, DialogWatcher, Download, DownloadWatcher, FileChooserWatcher, InitScriptRegistration, NetworkObserver, Resource, } from "./resources/index.js";
export { CUA, } from "./actions/cua.js";
export { Locator, } from "./locators/index.js";
export { AX, AXRef, AXState, } from "./ax/index.js";
export { Browser, CDPSession, Frame, Realm, Tab, Tabs, } from "./browser/index.js";
let currentBrowser;
/**
 * Connects this JavaScript process to the persistent AB browser runtime.
 *
 * The SDK first connects to the fixed per-user Unix socket. If no daemon is
 * listening, it launches the exact native runtime shipped with this SDK and
 * waits for the same handshake. Repeated calls in one process share a client.
 */
export function connect(options = {}) {
    if (currentBrowser) {
        return currentBrowser;
    }
    if (options.signal?.aborted) {
        return Promise.reject(new DOMException("AB connection was cancelled", "AbortError"));
    }
    const connecting = ProtocolClient.connect(options.timeoutMs, options.signal).then((client) => {
        return new Browser(client, () => {
            if (currentBrowser === connecting) {
                currentBrowser = undefined;
            }
        });
    });
    currentBrowser = connecting;
    void connecting.catch(() => {
        if (currentBrowser === connecting) {
            currentBrowser = undefined;
        }
    });
    return connecting;
}
//# sourceMappingURL=index.js.map