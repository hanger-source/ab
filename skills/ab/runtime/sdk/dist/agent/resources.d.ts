import type { OperationOptions } from "../options.js";
import type { ConsoleObserver, DialogWatcher, DownloadWatcher, FileChooserWatcher, InitScriptDefinition, InitScriptRegistration, NetworkObserver, NetworkObserverOptions, PopupWatcher } from "../resources/index.js";
/** Long-lived browser event and file-resource entrypoints. */
export declare class Resources {
    #private;
    private constructor();
    network(options?: NetworkObserverOptions): Promise<NetworkObserver>;
    console(options?: OperationOptions): Promise<ConsoleObserver>;
    dialogs(options?: OperationOptions): Promise<DialogWatcher>;
    popups(options?: OperationOptions): Promise<PopupWatcher>;
    downloads(options?: OperationOptions): Promise<DownloadWatcher>;
    fileChoosers(options?: OperationOptions): Promise<FileChooserWatcher>;
    initScripts(definition: InitScriptDefinition, options?: OperationOptions): Promise<InitScriptRegistration>;
}
//# sourceMappingURL=resources.d.ts.map