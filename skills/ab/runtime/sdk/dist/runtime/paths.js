import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
export function runtimeDirectory() {
    const configured = process.env.AB_RUNTIME_DIR;
    if (configured) {
        return configured;
    }
    const uid = process.getuid?.();
    if (uid === undefined) {
        throw new Error("ab currently requires a Unix runtime");
    }
    return join(tmpdir(), `ab-${uid}`);
}
export function socketPath() {
    return join(runtimeDirectory(), "browser.sock");
}
export function startupPath() {
    return join(runtimeDirectory(), "startup.json");
}
export function dataDirectory() {
    return process.env.AB_DATA_DIR
        ?? join(homedir(), "Library", "Application Support", "ab");
}
//# sourceMappingURL=paths.js.map