import type { Tab as CoreTab } from "../browser/index.js";
import type { OperationOptions } from "../options.js";
import type {
  ConsoleObserver,
  DialogWatcher,
  DownloadWatcher,
  FileChooserWatcher,
  InitScriptDefinition,
  InitScriptRegistration,
  NetworkObserver,
  NetworkObserverOptions,
  PopupWatcher,
} from "../resources/index.js";
import type { DocumentationRegistry } from "./documentation.js";

/** Long-lived browser event and file-resource entrypoints. */
export class Resources {
  readonly #core: CoreTab;
  readonly #documentation: DocumentationRegistry;

  private constructor(core: CoreTab, documentation: DocumentationRegistry) {
    this.#core = core;
    this.#documentation = documentation;
  }

  /** @internal */
  static create(core: CoreTab, documentation: DocumentationRegistry): Resources {
    return new Resources(core, documentation);
  }

  network(options: NetworkObserverOptions = {}): Promise<NetworkObserver> {
    this.#documentation.require("network", "tab.resources.network()");
    return this.#core.observeNetwork(options);
  }

  console(options: OperationOptions = {}): Promise<ConsoleObserver> {
    this.#documentation.require("console-dialogs", "tab.resources.console()");
    return this.#core.observeConsole(options);
  }

  dialogs(options: OperationOptions = {}): Promise<DialogWatcher> {
    this.#documentation.require("console-dialogs", "tab.resources.dialogs()");
    return this.#core.watchDialogs(options);
  }

  popups(options: OperationOptions = {}): Promise<PopupWatcher> {
    this.#documentation.require("tabs", "tab.resources.popups()");
    return this.#core.watchPopups(options);
  }

  downloads(options: OperationOptions = {}): Promise<DownloadWatcher> {
    this.#documentation.require("downloads", "tab.resources.downloads()");
    return this.#core.watchDownloads(options);
  }

  fileChoosers(options: OperationOptions = {}): Promise<FileChooserWatcher> {
    this.#documentation.require("downloads", "tab.resources.fileChoosers()");
    return this.#core.watchFileChoosers(options);
  }

  initScripts(
    definition: InitScriptDefinition,
    options: OperationOptions = {},
  ): Promise<InitScriptRegistration> {
    this.#documentation.require("init-scripts", "tab.resources.initScripts()");
    return this.#core.addInitScript(definition, options);
  }
}
