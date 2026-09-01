import { inspect } from "node:util";
import type { OperationOptions } from "../options.js";
import type { ProtocolClient } from "../transport/index.js";
export type ArtifactDescriptor = {
    id: string;
    path: string;
    sha256: string;
    bytes: number;
    mediaType: string;
    encoding: string;
    createdAtUnixMs: number;
    expiresAtUnixMs: number;
};
export type ScreenshotWire = {
    artifact: ArtifactDescriptor;
    viewportId: string;
    width: number;
    height: number;
    fullPage: boolean;
    scale: ScreenshotScale;
    cssViewport: CssViewport;
};
export type ScreenshotScale = "css" | "device";
export type CssViewport = {
    width: number;
    height: number;
    pageX: number;
    pageY: number;
    deviceScaleFactor: number;
};
/** A client-owned local artifact whose bytes are verified before use. */
export declare class Artifact {
    #private;
    readonly artifact: ArtifactDescriptor;
    readonly id: string;
    readonly path: string;
    readonly sha256: string;
    readonly mediaType: string;
    readonly encoding: string;
    readonly bytes: number;
    readonly createdAtUnixMs: number;
    readonly expiresAtUnixMs: number;
    constructor(client: ProtocolClient, value: ArtifactDescriptor);
    /** Reads the artifact and verifies both its byte length and SHA-256 digest. */
    read(): Promise<Uint8Array>;
    dispose(options?: OperationOptions): Promise<void>;
    [inspect.custom](): string;
}
/** A verified PNG artifact bound to an exact viewport identity. */
export declare class Screenshot extends Artifact {
    readonly viewportId: string;
    readonly width: number;
    readonly height: number;
    readonly fullPage: boolean;
    readonly scale: ScreenshotScale;
    readonly cssViewport: Readonly<CssViewport>;
    constructor(client: ProtocolClient, value: ScreenshotWire);
    [inspect.custom](): string;
}
//# sourceMappingURL=index.d.ts.map