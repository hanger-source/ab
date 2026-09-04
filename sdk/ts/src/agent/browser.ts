import { inspect } from "node:util";
import {
  Browser as CoreBrowser,
  Tab as CoreTab,
  type BrowserIdentity,
  type NavigateOptions,
  type ScreenshotOptions,
} from "../browser/index.js";
import type { Screenshot } from "../artifacts/index.js";
import { connect as connectCore } from "../index.js";
import type { Diagnostics } from "../diagnostics/index.js";
import type { OperationOptions } from "../options.js";
import type { BrowserProvider } from "../options.js";
import {
  browserProviderKey,
  normalizeBrowserProvider,
} from "../runtime/provider.js";
import { AX } from "./ax.js";
import { CUA } from "./cua.js";
import { Dev } from "./dev.js";
import {
  DocumentationRegistry,
  readDocumentation,
  type DocumentationTopic,
} from "./documentation.js";
import { Playwright } from "./playwright.js";
import {
  defaultPresenter,
  type Presenter,
} from "./presentation.js";
import { Resources } from "./resources.js";

export type ConnectOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
  presenter?: Presenter;
  provider?: BrowserProvider;
};

export type PopupExpectationOptions = OperationOptions;

type TabResolver = (targetId: string, options?: OperationOptions) => Promise<Tab>;

/** Explicit Agent-facing tab with capability namespaces instead of Core forwarding. */
export class Tab {
  readonly ax: AX;
  readonly playwright: Playwright;
  readonly cua: CUA;
  readonly resources: Resources;
  readonly dev: Dev;
  readonly #core: CoreTab;
  readonly #documentation: DocumentationRegistry;
  readonly #resolveTab: TabResolver;

  private constructor(
    core: CoreTab,
    presenter: Presenter,
    documentation: DocumentationRegistry,
    resolveTab: TabResolver,
  ) {
    this.#core = core;
    this.#documentation = documentation;
    this.#resolveTab = resolveTab;
    this.ax = AX.create(core, presenter, documentation);
    this.playwright = Playwright.create(core, this.ax);
    this.cua = CUA.create(core.cua, this.ax);
    this.resources = Resources.create(core, documentation);
    this.dev = Dev.create(core, documentation);
  }

  /** @internal */
  static create(
    core: CoreTab,
    presenter: Presenter,
    documentation: DocumentationRegistry,
    resolveTab: TabResolver,
  ): Tab {
    return new Tab(core, presenter, documentation, resolveTab);
  }

  get id(): string {
    return this.#core.id;
  }

  get title(): string {
    return this.#core.title;
  }

  get openerId(): string | null {
    return this.#core.openerId;
  }

  get url(): string {
    return this.#core.url;
  }

  get active(): boolean {
    return this.#core.active;
  }

  get ownership(): "available" | "owned" | "other" {
    return this.#core.ownership;
  }

  async acquire(options: OperationOptions = {}): Promise<Tab> {
    await this.#core.acquire(options);
    return this;
  }

  async refresh(options: OperationOptions = {}): Promise<Tab> {
    await this.#core.refresh(options);
    return this;
  }

  goto(url: string, options: NavigateOptions = {}): Promise<void> {
    return this.#core.navigate(url, options);
  }

  reload(options: OperationOptions = {}): Promise<void> {
    return this.#core.reload(options);
  }

  goBack(options: OperationOptions = {}): Promise<void> {
    return this.#core.goBack(options);
  }

  goForward(options: OperationOptions = {}): Promise<void> {
    return this.#core.goForward(options);
  }

  activate(options: OperationOptions = {}): Promise<void> {
    return this.#core.activate(options);
  }

  close(options: OperationOptions = {}): Promise<void> {
    return this.#core.close(options);
  }

  /**
   * Arms a popup watcher before running the action and returns the exact ready
   * child target created by this tab.
   */
  async expectPopup(
    action: () => unknown | Promise<unknown>,
    options: PopupExpectationOptions = {},
  ): Promise<Tab> {
    this.#documentation.require("tabs", "tab.expectPopup()");
    const watcher = await this.#core.watchPopups(options);
    try {
      await action();
      const popup = await watcher.waitForPopup(options);
      return await this.#resolveTab(popup.targetId, options);
    } finally {
      await watcher.dispose(options);
    }
  }

  screenshot(options: ScreenshotOptions = {}): Promise<Screenshot> {
    this.#documentation.require("screenshot", "tab.screenshot()");
    return this.#core.screenshot(options);
  }

  [inspect.custom](): string {
    return `Tab { id: '${this.id}', title: ${JSON.stringify(this.title)}, url: ${JSON.stringify(this.url)}, surfaces: [ax, playwright, cua, resources, dev] }`;
  }
}

type TabCacheEntry = {
  readonly core: CoreTab;
  readonly tab: Tab;
};

/** Agent tab discovery with a stable wrapper and presentation baseline per target. */
export class Tabs {
  readonly #core: CoreBrowser;
  readonly #presenter: Presenter;
  readonly #documentation: DocumentationRegistry;
  readonly #cache = new Map<string, TabCacheEntry>();

  private constructor(
    core: CoreBrowser,
    presenter: Presenter,
    documentation: DocumentationRegistry,
  ) {
    this.#core = core;
    this.#presenter = presenter;
    this.#documentation = documentation;
  }

  /** @internal */
  static create(core: CoreBrowser, presenter: Presenter, documentation: DocumentationRegistry): Tabs {
    return new Tabs(core, presenter, documentation);
  }

  async list(options: OperationOptions = {}): Promise<Tab[]> {
    return Promise.all((await this.#core.tabs.list(options)).map((tab) => this.#wrap(tab, options)));
  }

  async get(targetId: string, options: OperationOptions = {}): Promise<Tab> {
    return this.#wrap(await this.#core.tabs.get(targetId, options), options);
  }

  async acquire(targetId: string, options: OperationOptions = {}): Promise<Tab> {
    return this.#wrap(await this.#core.tabs.acquire(targetId, options), options);
  }

  async open(url = "about:blank", options: NavigateOptions = {}): Promise<Tab> {
    return this.#wrap(await this.#core.tabs.open(url, options), options);
  }

  /** @internal */
  async dispose(): Promise<void> {
    await Promise.all([...this.#cache.values()].map(({ tab }) => tab.ax.dispose()));
    this.#cache.clear();
  }

  async #wrap(core: CoreTab, options: OperationOptions): Promise<Tab> {
    const existing = this.#cache.get(core.id);
    if (existing) {
      await existing.core.refresh(options);
      return existing.tab;
    }
    const tab = Tab.create(
      core,
      this.#presenter,
      this.#documentation,
      (targetId, resolveOptions = {}) => this.get(targetId, resolveOptions),
    );
    this.#cache.set(core.id, { core, tab });
    return tab;
  }
}

export class Browser {
  readonly identity: BrowserIdentity;
  readonly tabs: Tabs;
  readonly diagnostics: Diagnostics;
  readonly #core: CoreBrowser;
  readonly #presenter: Presenter;
  readonly #documentation = new DocumentationRegistry();
  readonly #onDisconnect: () => void;

  private constructor(core: CoreBrowser, presenter: Presenter, onDisconnect: () => void) {
    this.#core = core;
    this.#presenter = presenter;
    this.#onDisconnect = onDisconnect;
    this.identity = core.identity;
    this.tabs = Tabs.create(core, presenter, this.#documentation);
    this.diagnostics = core.diagnostics;
  }

  /** @internal */
  static create(core: CoreBrowser, presenter: Presenter, onDisconnect: () => void): Browser {
    return new Browser(core, presenter, onDisconnect);
  }

  get connected(): boolean {
    return this.#core.connected;
  }

  async documentation(topic: DocumentationTopic = "core"): Promise<string> {
    const text = await readDocumentation(topic);
    await this.#presenter.presentText({
      kind: "documentation",
      origin: `ab:${topic}`,
      observationId: null,
      text,
      untrusted: false,
    });
    this.#documentation.markRead(topic);
    return text;
  }

  async disconnect(): Promise<void> {
    try {
      await this.#core.disconnect();
    } finally {
      try {
        // Core establishes the server-side cleanup boundary before local
        // presentation objects are discarded. Their disposal must not turn a
        // completed disconnect into a failure.
        await this.tabs.dispose().catch(() => undefined);
      } finally {
        this.#onDisconnect();
      }
    }
  }

  [inspect.custom](): string {
    return `Browser { connected: ${this.connected}, clientId: '${this.identity.clientId}', daemonId: '${this.identity.daemonId}' }`;
  }
}

let currentBrowser: Promise<Browser> | undefined;
let currentProviderKey: string | undefined;

/** Connects the Agent facade to the Core SDK and version-matched Rust runtime. */
export function connect(options: ConnectOptions = {}): Promise<Browser> {
  const provider = normalizeBrowserProvider(options.provider);
  const providerKey = browserProviderKey(provider);
  if (currentBrowser) {
    if (currentProviderKey !== providerKey) {
      return Promise.reject(new Error(
        "this JavaScript process is already connected to a different AB browser provider; disconnect it before connecting another provider",
      ));
    }
    return currentBrowser;
  }
  const presenter = options.presenter ?? defaultPresenter();
  const connecting = connectCore({
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    provider,
  }).then((core) => Browser.create(core, presenter, () => {
    if (currentBrowser === connecting) {
      currentBrowser = undefined;
      currentProviderKey = undefined;
    }
  }));
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
