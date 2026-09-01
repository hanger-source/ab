import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { inspect } from "node:util";
import { ABError } from "../errors/index.js";
/** A client-owned local artifact whose bytes are verified before use. */
export class Artifact {
    artifact;
    id;
    path;
    sha256;
    mediaType;
    encoding;
    bytes;
    createdAtUnixMs;
    expiresAtUnixMs;
    #client;
    #disposed = false;
    constructor(client, value) {
        assertArtifactDescriptor(value);
        this.artifact = Object.freeze({ ...value });
        this.id = value.id;
        this.path = value.path;
        this.sha256 = value.sha256;
        this.mediaType = value.mediaType;
        this.encoding = value.encoding;
        this.bytes = value.bytes;
        this.createdAtUnixMs = value.createdAtUnixMs;
        this.expiresAtUnixMs = value.expiresAtUnixMs;
        this.#client = client;
    }
    /** Reads the artifact and verifies both its byte length and SHA-256 digest. */
    async read() {
        if (this.#disposed) {
            throw new ABError({
                kind: "resource_disposed",
                stage: "sdk.artifact",
                message: `artifact ${this.artifact.id} is disposed`,
            });
        }
        const data = await readFile(this.path);
        if (data.byteLength !== this.artifact.bytes) {
            throw new ABError({
                kind: "artifact_corrupt",
                stage: "sdk.artifact.bytes",
                message: `artifact ${this.artifact.id} has ${data.byteLength} bytes; expected ${this.artifact.bytes}`,
            });
        }
        const sha256 = createHash("sha256").update(data).digest("hex");
        if (sha256 !== this.artifact.sha256) {
            throw new ABError({
                kind: "artifact_corrupt",
                stage: "sdk.artifact.sha256",
                message: `artifact ${this.artifact.id} failed SHA-256 verification`,
            });
        }
        return data;
    }
    async dispose(options = {}) {
        if (this.#disposed)
            return;
        await this.#client.request("artifact.dispose", {}, { target: { artifactId: this.artifact.id }, ...options });
        this.#disposed = true;
    }
    [inspect.custom]() {
        return `Artifact { id: '${this.id}', path: ${JSON.stringify(this.path)}, sha256: '${this.sha256}', mediaType: '${this.mediaType}', encoding: '${this.encoding}', bytes: ${this.bytes} }`;
    }
}
/** A verified PNG artifact bound to an exact viewport identity. */
export class Screenshot extends Artifact {
    viewportId;
    width;
    height;
    fullPage;
    scale;
    cssViewport;
    constructor(client, value) {
        if (!value || typeof value !== "object" || !value.artifact) {
            throw new TypeError(`invalid AB screenshot wire: ${JSON.stringify(value)}`);
        }
        super(client, value.artifact);
        this.viewportId = value.viewportId;
        this.width = value.width;
        this.height = value.height;
        this.fullPage = value.fullPage;
        this.scale = value.scale;
        this.cssViewport = Object.freeze({ ...value.cssViewport });
    }
    [inspect.custom]() {
        return `Screenshot { id: '${this.id}', path: ${JSON.stringify(this.path)}, sha256: '${this.sha256}', mediaType: '${this.mediaType}', bytes: ${this.bytes}, image: ${this.width}x${this.height}, scale: '${this.scale}', cssViewport: ${this.cssViewport.width}x${this.cssViewport.height}@${this.cssViewport.pageX},${this.cssViewport.pageY}, dpr: ${this.cssViewport.deviceScaleFactor}, fullPage: ${this.fullPage} }`;
    }
}
function assertArtifactDescriptor(value) {
    if (!value
        || typeof value !== "object"
        || typeof value.id !== "string"
        || typeof value.path !== "string"
        || typeof value.sha256 !== "string"
        || typeof value.bytes !== "number"
        || !Number.isFinite(value.bytes)
        || value.bytes < 0
        || typeof value.mediaType !== "string"
        || typeof value.encoding !== "string"
        || typeof value.createdAtUnixMs !== "number"
        || typeof value.expiresAtUnixMs !== "number") {
        throw new TypeError(`invalid AB artifact descriptor: ${JSON.stringify(value)}`);
    }
}
//# sourceMappingURL=index.js.map