import { inspect } from "node:util";
import { Screenshot, type ScreenshotWire } from "../artifacts/index.js";
import { ABError } from "../errors/index.js";
import type { OperationOptions } from "../options.js";
import type { ProtocolClient } from "../transport/index.js";
import { AXState } from "../ax/index.js";
import type {
  ActionOptions,
  ActionResult,
  ActionWire,
  TextInputActionData,
} from "../actions/result.js";
import type { ElementInspection, ElementInspectionRequest } from "../protocol.js";

export type ElementActionOptions = OperationOptions & ActionOptions;
export type ElementInspectionOptions = OperationOptions & ElementInspectionRequest;
export type { ElementBounds, ElementInspection, ElementInspectionRequest } from "../protocol.js";

export type ElementHandleDescriptor = {
  id: string;
  targetId: string;
  frameId: string;
  documentGeneration: string;
  backendNodeId: number;
};

/**
 * Server-owned handle to one backend node in one frame/document generation.
 * It never reruns the Locator or searches for a semantically similar node.
 */
export class ElementHandle {
  readonly id: string;
  readonly targetId: string;
  readonly frameId: string;
  readonly documentGeneration: string;
  readonly backendNodeId: number;
  readonly #client: ProtocolClient;
  #disposed = false;

  constructor(client: ProtocolClient, value: ElementHandleDescriptor) {
    this.#client = client;
    this.id = value.id;
    this.targetId = value.targetId;
    this.frameId = value.frameId;
    this.documentGeneration = value.documentGeneration;
    this.backendNodeId = value.backendNodeId;
  }

  click(options: ElementActionOptions & { button?: "left" | "middle" | "right"; clickCount?: number } = {}): Promise<ActionResult> {
    return this.#act("click", { button: options.button ?? "left", clickCount: options.clickCount ?? 1 }, options);
  }

  doubleClick(options: ElementActionOptions = {}): Promise<ActionResult> { return this.#act("dblclick", {}, options); }

  hover(options: ElementActionOptions = {}): Promise<ActionResult> { return this.#act("hover", {}, options); }
  wheel(deltaX: number, deltaY: number, options: ElementActionOptions = {}): Promise<ActionResult> {
    return this.#act("wheel", { deltaX, deltaY }, options);
  }
  focus(options: ElementActionOptions = {}): Promise<ActionResult> { return this.#act("focus", {}, options); }
  clear(options: ElementActionOptions = {}): Promise<ActionResult> { return this.#act("clear", {}, options); }
  scrollIntoView(options: ElementActionOptions = {}): Promise<ActionResult> { return this.#act("scrollIntoView", {}, options); }
  fill(value: string, options: ElementActionOptions = {}): Promise<ActionResult<TextInputActionData>> { return this.#act("fill", { value }, options); }
  type(text: string, options: ElementActionOptions & { clear?: boolean; delayMs?: number } = {}): Promise<ActionResult<TextInputActionData>> {
    return this.#act("type", { text, clear: options.clear ?? false, ...(options.delayMs === undefined ? {} : { delayMs: options.delayMs }) }, options);
  }
  press(key: string, options: ElementActionOptions = {}): Promise<ActionResult> { return this.#act("press", { key }, options); }
  check(options: ElementActionOptions = {}): Promise<ActionResult> { return this.#act("check", {}, options); }
  uncheck(options: ElementActionOptions = {}): Promise<ActionResult> { return this.#act("uncheck", {}, options); }
  selectOption(values: string | string[], options: ElementActionOptions = {}): Promise<ActionResult> {
    return this.#act("select", { values: Array.isArray(values) ? values : [values] }, options);
  }
  setFiles(files: string | string[], options: ElementActionOptions = {}): Promise<ActionResult> {
    return this.#act("upload", { files: Array.isArray(files) ? files : [files] }, options);
  }
  dragTo(target: ElementHandle, options: ElementActionOptions = {}): Promise<ActionResult> {
    if (target.#client !== this.#client || target.targetId !== this.targetId) {
      return Promise.reject(new TypeError("ElementHandle.dragTo requires a handle from the same Browser and Tab"));
    }
    return this.#act("drag", { targetElementId: target.id }, options);
  }
  async textContent(options: OperationOptions = {}): Promise<string> {
    const result = await this.#perform<{ text?: unknown }>("text", {}, options);
    return typeof result.text === "string" ? result.text : String(result.text ?? "");
  }
  async innerText(options: OperationOptions = {}): Promise<string> {
    const result = await this.#perform<{ text?: unknown }>("innertext", {}, options);
    return typeof result.text === "string" ? result.text : String(result.text ?? "");
  }
  domInvoke<T = unknown>(method: string, args: unknown[] = [], options: ElementActionOptions = {}): Promise<ActionResult<{ value?: T }>> {
    return this.#act("dominvoke", { method, args }, options);
  }
  async screenshot(options: OperationOptions = {}): Promise<Screenshot> {
    return new Screenshot(this.#client, await this.#perform<ScreenshotWire>("screenshot", {}, options));
  }
  async getAttribute(name: string, options: OperationOptions = {}): Promise<string | null> {
    const result = await this.#perform<{ value?: unknown }>("getattribute", { attribute: name }, options);
    return typeof result.value === "string" ? result.value : null;
  }
  boundingBox(options: OperationOptions = {}): Promise<{ x: number; y: number; width: number; height: number } | null> {
    return this.#perform("boundingbox", {}, options);
  }
  async isVisible(options: OperationOptions = {}): Promise<boolean> {
    return (await this.#perform<{ value?: unknown }>("isvisible", {}, options)).value === true;
  }
  async isEnabled(options: OperationOptions = {}): Promise<boolean> {
    return (await this.#perform<{ value?: unknown }>("isenabled", {}, options)).value === true;
  }
  async isChecked(options: OperationOptions = {}): Promise<boolean> {
    return (await this.#perform<{ value?: unknown }>("ischecked", {}, options)).value === true;
  }
  async inputValue(options: OperationOptions = {}): Promise<string> {
    const value = (await this.#perform<{ value?: unknown }>("inputvalue", {}, options)).value;
    return typeof value === "string" ? value : String(value ?? "");
  }
  inspect(options: ElementInspectionOptions = {}): Promise<ElementInspection> {
    const { attributes = [], ...operationOptions } = options;
    return this.#perform("inspect", { attributes }, operationOptions);
  }

  /** Releases this handle; the owning client also releases it on disconnect. */
  async dispose(options: OperationOptions = {}): Promise<void> {
    if (this.#disposed) return;
    await this.#client.request("element.dispose", {}, { target: { tabId: this.targetId, elementId: this.id }, ...options });
    this.#disposed = true;
  }

  [inspect.custom](): string {
    return `ElementHandle { id: '${this.id}', frameId: '${this.frameId}', documentGeneration: '${this.documentGeneration}', backendNodeId: ${this.backendNodeId} }`;
  }

  #perform<T = unknown>(operation: string, arguments_: Record<string, unknown>, options: OperationOptions): Promise<T> {
    if (this.#disposed) {
      return Promise.reject(new ABError({ kind: "resource_disposed", stage: "sdk.element", message: `element handle ${this.id} is disposed` }));
    }
    return this.#client.request<T>(
      "element.perform",
      { operation, arguments: arguments_ },
      { target: { tabId: this.targetId, frameId: this.frameId, documentGeneration: this.documentGeneration, elementId: this.id }, ...options },
    );
  }

  async #act<TData = unknown>(
    operation: string,
    arguments_: Record<string, unknown>,
    options: ElementActionOptions,
  ): Promise<ActionResult<TData>> {
    const { baseline, ...operationOptions } = options;
    const result = await this.#perform<ActionWire<TData>>(operation, {
      ...arguments_,
      observe: options.observe ?? "none",
      ...(baseline === undefined
        ? {}
        : { baselineObservationId: typeof baseline === "string" ? baseline : baseline.id }),
      ...(options.observation === undefined ? {} : { observation: options.observation }),
    }, operationOptions);
    return {
      ...result,
      observation: result.observation
        ? new AXState(this.#client, result.observation)
        : null,
    };
  }
}
