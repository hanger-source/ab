import type { Screenshot } from "../artifacts/index.js";
export type TextPresentation = {
    kind: "ax" | "action" | "documentation";
    origin: string;
    observationId: string | null;
    text: string;
    untrusted: boolean;
    presentation?: "full" | "incremental" | "document-replacement" | "surface-replacement";
};
export type ImagePresentation = {
    kind: "screenshot";
    origin: string;
    screenshot: Screenshot;
};
export interface Presenter {
    presentText(value: TextPresentation): void | Promise<void>;
    presentImage(value: ImagePresentation): void | Promise<void>;
}
export interface NodeReplContentHost {
    write(value: unknown): void;
    emitImage(image: Uint8Array | {
        bytes: Uint8Array;
        mimeType: string;
    }): void | Promise<void>;
}
/** Presentation for ordinary Node.js processes. */
export declare function terminalPresenter(): Presenter;
/** Presentation through the public content channel of a managed Node REPL. */
export declare function nodeReplPresenter(host: NodeReplContentHost): Presenter;
export declare function defaultPresenter(): Presenter;
//# sourceMappingURL=presentation.d.ts.map