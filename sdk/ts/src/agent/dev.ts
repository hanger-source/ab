import type {
  CDPSession,
  Frame,
  Realm,
  Tab as CoreTab,
} from "../browser/index.js";
import type { OperationOptions } from "../options.js";
import type { DocumentationRegistry } from "./documentation.js";

/** Page script, frame/realm, and raw CDP diagnostics outside ordinary UI work. */
export class Dev {
  readonly #core: CoreTab;
  readonly #documentation: DocumentationRegistry;

  private constructor(core: CoreTab, documentation: DocumentationRegistry) {
    this.#core = core;
    this.#documentation = documentation;
  }

  /** @internal */
  static create(core: CoreTab, documentation: DocumentationRegistry): Dev {
    return new Dev(core, documentation);
  }

  evaluate<T, Args extends unknown[]>(
    pageFunction: (...args: Args) => T | Promise<T>,
    ...args: Args
  ): Promise<Awaited<T>> {
    this.#documentation.require("evaluate", "tab.dev.evaluate()");
    return this.#core.evaluate(pageFunction, ...args);
  }

  frames(options: OperationOptions = {}): Promise<Frame[]> {
    this.#documentation.require("frames", "tab.dev.frames()");
    return this.#core.frames(options);
  }

  mainFrame(options: OperationOptions = {}): Promise<Frame> {
    this.#documentation.require("frames", "tab.dev.mainFrame()");
    return this.#core.mainFrame(options);
  }

  realms(options: OperationOptions = {}): Promise<Realm[]> {
    this.#documentation.require("frames", "tab.dev.realms()");
    return this.#core.realms(options);
  }

  cdp(): Promise<CDPSession> {
    this.#documentation.require("cdp", "tab.dev.cdp()");
    return this.#core.cdp();
  }
}
