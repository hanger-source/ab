import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { providerEndpointKey } from "./provider.js";
export function runtimeDirectory(provider) {
    const base = process.env.AB_RUNTIME_DIR ?? defaultRuntimeDirectory();
    return provider.kind === "managed"
        ? base
        : `${base}-external-${providerEndpointKey(provider)}`;
}
function defaultRuntimeDirectory() {
    const uid = process.getuid?.();
    if (uid === undefined) {
        throw new Error("ab currently requires a Unix runtime");
    }
    return join(tmpdir(), `ab-${uid}`);
}
export function socketPath(provider) {
    return join(runtimeDirectory(provider), "browser.sock");
}
export function startupPath(provider) {
    return join(runtimeDirectory(provider), "startup.json");
}
export function dataDirectory() {
    return process.env.AB_DATA_DIR
        ?? join(homedir(), "Library", "Application Support", "ab");
}
//# sourceMappingURL=paths.js.map