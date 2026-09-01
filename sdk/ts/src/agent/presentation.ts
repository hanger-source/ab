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
  emitImage(
    image: Uint8Array | { bytes: Uint8Array; mimeType: string },
  ): void | Promise<void>;
}

function formatTextPresentation(value: TextPresentation): string {
  const boundary = value.untrusted ? "AB_UNTRUSTED_BROWSER_CONTENT" : "AB_DOCUMENTATION";
  const presentation = value.presentation === undefined
    ? ""
    : ` presentation=${JSON.stringify(value.presentation)}`;
  return `<<<${boundary} origin=${JSON.stringify(value.origin)} observation=${JSON.stringify(value.observationId)}${presentation}>>>\n${value.text}\n<<<END_${boundary}>>>\n`;
}

function formatScreenshotPresentation(value: ImagePresentation): string {
  return `AB_SCREENSHOT ${JSON.stringify({
    origin: value.origin,
    id: value.screenshot.id,
    path: value.screenshot.path,
    sha256: value.screenshot.sha256,
    mediaType: value.screenshot.mediaType,
    bytes: value.screenshot.bytes,
    viewportId: value.screenshot.viewportId,
    width: value.screenshot.width,
    height: value.screenshot.height,
    fullPage: value.screenshot.fullPage,
    scale: value.screenshot.scale,
    cssViewport: value.screenshot.cssViewport,
  })}\n`;
}

/** Presentation for ordinary Node.js processes. */
export function terminalPresenter(): Presenter {
  return {
    presentText(value) {
      process.stdout.write(formatTextPresentation(value));
    },
    presentImage(value) {
      process.stdout.write(formatScreenshotPresentation(value));
    },
  };
}

/** Presentation through the public content channel of a managed Node REPL. */
export function nodeReplPresenter(host: NodeReplContentHost): Presenter {
  return {
    presentText(value) {
      host.write(formatTextPresentation(value));
    },
    async presentImage(value) {
      const bytes = await value.screenshot.read();
      host.write(formatScreenshotPresentation(value));
      await host.emitImage({ bytes, mimeType: value.screenshot.mediaType });
    },
  };
}

export function defaultPresenter(): Presenter {
  const candidate = (globalThis as { nodeRepl?: unknown }).nodeRepl;
  if (
    candidate
    && typeof candidate === "object"
    && typeof (candidate as Partial<NodeReplContentHost>).write === "function"
    && typeof (candidate as Partial<NodeReplContentHost>).emitImage === "function"
  ) {
    return nodeReplPresenter(candidate as NodeReplContentHost);
  }
  return terminalPresenter();
}
