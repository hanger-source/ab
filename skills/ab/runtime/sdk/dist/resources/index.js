import { inspect } from "node:util";
import { Artifact } from "../artifacts/index.js";
import { ABError } from "../errors/index.js";
const resourceClient = Symbol("ab.resource.client");
/**
 * Client-owned view of a server-buffered browser event resource.
 * Dispose it deterministically and check completeness before relying on history.
 */
export class Resource {
    id;
    kind;
    ownerId;
    scope;
    targetId;
    createdAtUnixMs;
    [resourceClient];
    #history = [];
    #listeners = new Set();
    #waiters = new Set();
    #unsubscribe;
    #complete;
    #state;
    #closeReason;
    #closedAtUnixMs = null;
    #lastSequence;
    constructor(client, descriptor) {
        this[resourceClient] = client;
        this.id = descriptor.id;
        this.kind = descriptor.kind;
        this.ownerId = descriptor.ownerId;
        this.scope = descriptor.scope;
        this.targetId = descriptor.scope.targetId;
        this.createdAtUnixMs = descriptor.createdAtUnixMs;
        this.#complete = descriptor.complete;
        this.#state = descriptor.state;
        this.#closeReason = descriptor.closeReason;
        this.#lastSequence = descriptor.sequence;
        this.#unsubscribe = client.subscribeResource(this.id, (message) => this.#accept(message));
    }
    get state() {
        return this.#state;
    }
    get complete() {
        return this.#complete;
    }
    get closed() {
        return this.#state === "closed";
    }
    get closeReason() {
        return this.#closeReason;
    }
    get closedAtUnixMs() {
        return this.#closedAtUnixMs;
    }
    get sequence() {
        return this.#lastSequence;
    }
    get events() {
        return this.#history;
    }
    onEvent(listener) {
        this.#assertOpen();
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }
    /** Waits for a matching buffered or future event without consuming history. */
    async waitFor(predicate, options = {}) {
        this.#assertOpen();
        await this.refresh(options);
        const existing = this.#history.find(predicate);
        if (existing) {
            return existing;
        }
        const timeoutMs = options.timeoutMs ?? 30_000;
        if (options.signal?.aborted) {
            throw cancelledError(this.id);
        }
        return new Promise((resolve, reject) => {
            const waiter = {};
            const finish = (fn) => {
                this.#waiters.delete(waiter);
                clearTimeout(waiter.timer);
                if (waiter.signal && waiter.onAbort) {
                    waiter.signal.removeEventListener("abort", waiter.onAbort);
                }
                fn();
            };
            waiter.predicate = predicate;
            waiter.resolve = (event) => finish(() => resolve(event));
            waiter.reject = (error) => finish(() => reject(error));
            waiter.timer = setTimeout(() => waiter.reject(new ABError({
                kind: "timeout",
                stage: "sdk.resource.wait",
                message: `resource ${this.id} did not produce a matching event within ${timeoutMs}ms`,
            })), timeoutMs);
            if (options.signal) {
                waiter.signal = options.signal;
                waiter.onAbort = () => waiter.reject(cancelledError(this.id));
                options.signal.addEventListener("abort", waiter.onAbort, { once: true });
            }
            this.#waiters.add(waiter);
        });
    }
    command(command, params = {}, options = {}) {
        this.#assertOpen();
        return this[resourceClient].request("resource.command", { command, params }, { target: { resourceId: this.id }, ...options });
    }
    async assertComplete(options = {}) {
        await this.command("assertComplete", {}, options);
    }
    /** Synchronizes this consumer with the Rust-owned event buffer and returns its exact cursor. */
    async refresh(options = {}) {
        const state = await this.command("state", { afterSequence: this.#lastSequence }, options);
        this.#state = state.state;
        this.#closeReason = state.closeReason;
        this.#closedAtUnixMs = state.closedAtUnixMs;
        if (state.gap) {
            this.#complete = false;
        }
        for (const event of state.events) {
            this.#accept({ type: "resource.event", ...event });
        }
        this.#complete &&= state.complete;
        return {
            state: state.state,
            createdAtUnixMs: state.createdAtUnixMs,
            sequence: state.sequence,
            complete: state.complete,
            closeReason: state.closeReason,
            closedAtUnixMs: state.closedAtUnixMs,
            bufferedFrom: state.bufferedFrom,
            gap: state.gap,
        };
    }
    async dispose(options = {}) {
        if (this.closed) {
            return;
        }
        await this[resourceClient].request("resource.dispose", {}, { target: { resourceId: this.id }, ...options });
        this.#close("disposed", this.#complete, Date.now());
    }
    [inspect.custom]() {
        return `Resource { id: '${this.id}', kind: '${this.kind}', state: '${this.#state}', sequence: ${this.#lastSequence}, complete: ${this.#complete} }`;
    }
    #accept(message) {
        if (message.type === "resource.closed") {
            this.#close(message.reason, message.complete, message.closedAtUnixMs);
            return;
        }
        if (message.sequence <= this.#lastSequence) {
            return;
        }
        if (message.sequence !== this.#lastSequence + 1) {
            this.#complete = false;
        }
        this.#lastSequence = message.sequence;
        const value = message.value;
        if (!value || typeof value !== "object" || Array.isArray(value)) {
            this.#close("invalid_event_payload", false, Date.now());
            return;
        }
        const raw = value;
        const event = {
            sequence: message.sequence,
            method: typeof raw.method === "string" ? raw.method : message.event,
            params: raw.params && typeof raw.params === "object" && !Array.isArray(raw.params)
                ? raw.params
                : {},
            sessionId: typeof raw.sessionId === "string" ? raw.sessionId : null,
            complete: message.complete,
            artifact: parseArtifactDescriptor(raw.artifact),
        };
        this.#complete &&= message.complete;
        this.#history.push(event);
        if (this.#history.length > 512) {
            this.#history.shift();
        }
        for (const listener of this.#listeners) {
            listener(event);
        }
        for (const waiter of [...this.#waiters]) {
            if (waiter.predicate(event)) {
                waiter.resolve(event);
            }
        }
    }
    #close(reason, complete, closedAtUnixMs) {
        if (this.closed) {
            return;
        }
        this.#state = "closed";
        this.#closeReason = reason;
        this.#closedAtUnixMs = closedAtUnixMs;
        this.#complete &&= complete;
        this.#unsubscribe();
        const error = new ABError({
            kind: "resource_closed",
            stage: "sdk.resource",
            message: `resource ${this.id} closed: ${reason}`,
            details: { complete: this.#complete },
        });
        for (const waiter of [...this.#waiters]) {
            waiter.reject(error);
        }
        this.#listeners.clear();
    }
    #assertOpen() {
        if (this.closed) {
            throw new ABError({
                kind: "resource_closed",
                stage: "sdk.resource",
                message: `resource ${this.id} is closed: ${this.#closeReason ?? "unknown"}`,
            });
        }
    }
}
export class NetworkObserver extends Resource {
    waitForRequest(predicate = () => true, options = {}) {
        return this.waitFor((event) => event.method === "Network.requestWillBeSent" && predicate(event), options);
    }
    waitForResponse(predicate = () => true, options = {}) {
        return this.waitFor((event) => event.method === "Network.responseReceived" && predicate(event), options);
    }
    async responseBody(eventOrRequestId, options = {}) {
        const requestId = typeof eventOrRequestId === "string"
            ? eventOrRequestId
            : String(eventOrRequestId.params.requestId ?? "");
        if (!requestId) {
            throw new TypeError("responseBody requires a Network event with params.requestId");
        }
        const sessionId = typeof eventOrRequestId === "string"
            ? options.sessionId
            : eventOrRequestId.sessionId;
        if (!sessionId) {
            throw new TypeError("responseBody requires the Network event sessionId");
        }
        const timeoutMs = options.timeoutMs ?? 30_000;
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (options.signal?.aborted)
                throw cancelledError(this.id);
            try {
                const value = await this.command("responseBody", { requestId, sessionId }, {
                    timeoutMs: Math.max(1, deadline - Date.now()),
                    ...(options.signal === undefined ? {} : { signal: options.signal }),
                });
                return {
                    ...value,
                    artifact: value.artifact ? new Artifact(this[resourceClient], value.artifact) : null,
                };
            }
            catch (error) {
                if (!(error instanceof ABError) || error.kind !== "network_body_pending")
                    throw error;
            }
            await new Promise((resolve) => setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))));
        }
        throw new ABError({
            kind: "timeout",
            stage: "sdk.resource.response_body",
            message: `response body ${sessionId}:${requestId} did not reach a terminal Rust-owned state within ${timeoutMs}ms`,
        });
    }
}
export class ConsoleObserver extends Resource {
    waitForMessage(predicate = () => true, options = {}) {
        return this.waitFor((event) => (event.method === "Runtime.consoleAPICalled" || event.method === "Log.entryAdded") && predicate(event), options);
    }
}
export class DialogWatcher extends Resource {
    #lastOpenedSequence = 0;
    async waitForDialog(options = {}) {
        const event = await this.waitFor((candidate) => candidate.method === "Page.javascriptDialogOpening"
            && candidate.sequence > this.#lastOpenedSequence, options);
        this.#lastOpenedSequence = event.sequence;
        return new Dialog(this, parseDialogInfo(event.params));
    }
}
export class Dialog {
    id;
    rootTargetId;
    sessionId;
    type;
    message;
    url;
    defaultPrompt;
    hasBrowserHandler;
    #watcher;
    #closed = false;
    #accepted = null;
    #userInput = null;
    #closeReason = null;
    #unsubscribe;
    constructor(watcher, info) {
        this.#watcher = watcher;
        this.id = info.id;
        this.rootTargetId = info.rootTargetId;
        this.sessionId = info.sessionId;
        this.type = info.type;
        this.message = info.message;
        this.url = info.url;
        this.defaultPrompt = info.defaultPrompt;
        this.hasBrowserHandler = info.hasBrowserHandler;
        this.#unsubscribe = watcher.onEvent((event) => {
            if (event.method === "Page.javascriptDialogClosed"
                && event.params.dialogId === this.id) {
                this.#accepted = typeof event.params.result === "boolean" ? event.params.result : null;
                this.#userInput = typeof event.params.userInput === "string" ? event.params.userInput : null;
                this.#closeReason = typeof event.params.reason === "string" ? event.params.reason : null;
                this.#markClosed();
            }
        });
    }
    get closed() {
        return this.#closed;
    }
    get accepted() {
        return this.#accepted;
    }
    get userInput() {
        return this.#userInput;
    }
    get closeReason() {
        return this.#closeReason;
    }
    accept(promptText, options = {}) {
        this.#assertOpen();
        return this.#watcher.command("accept", {
            dialogId: this.id,
            sessionId: this.sessionId,
            ...(promptText === undefined ? {} : { promptText }),
        }, options);
    }
    dismiss(options = {}) {
        this.#assertOpen();
        return this.#watcher.command("dismiss", { dialogId: this.id, sessionId: this.sessionId }, options);
    }
    [inspect.custom]() {
        return `Dialog { id: '${this.id}', type: '${this.type}', closed: ${this.#closed} }`;
    }
    #markClosed() {
        if (this.#closed) {
            return;
        }
        this.#closed = true;
        this.#unsubscribe?.();
        this.#unsubscribe = null;
    }
    #assertOpen() {
        if (this.#closed) {
            throw new ABError({
                kind: "stale_dialog",
                stage: "sdk.dialog.identity",
                message: `dialog ${this.id} is no longer open`,
            });
        }
    }
}
export class DownloadWatcher extends Resource {
    #lastStartedSequence = 0;
    async waitForDownload(options = {}) {
        const event = await this.waitFor((candidate) => candidate.method === "download.started"
            && candidate.sequence > this.#lastStartedSequence, options);
        this.#lastStartedSequence = event.sequence;
        return new Download(this, parseDownloadInfo(event.params, this[resourceClient]));
    }
    async downloads(options = {}) {
        const records = await this.command("downloads", {}, options);
        return records.map((record) => new Download(this, parseDownloadInfo(record, this[resourceClient])));
    }
}
export class Download {
    guid;
    targetId;
    frameId;
    url;
    suggestedFilename;
    createdAtUnixMs;
    #watcher;
    #path;
    #receivedBytes;
    #totalBytes;
    #state;
    #reason;
    #artifact;
    #updatedAtUnixMs;
    #unsubscribe;
    constructor(watcher, info) {
        this.#watcher = watcher;
        this.guid = info.guid;
        this.targetId = info.targetId;
        this.frameId = info.frameId;
        this.url = info.url;
        this.suggestedFilename = info.suggestedFilename;
        this.createdAtUnixMs = info.createdAtUnixMs;
        this.#path = info.path;
        this.#receivedBytes = info.receivedBytes;
        this.#totalBytes = info.totalBytes;
        this.#state = info.state;
        this.#reason = info.reason;
        this.#artifact = info.artifact;
        this.#updatedAtUnixMs = info.updatedAtUnixMs;
        this.#unsubscribe = watcher.onEvent((event) => {
            if (event.method === "download.updated" && event.params.guid === this.guid) {
                this.#update(parseDownloadInfo(event.params, watcher[resourceClient]));
            }
        });
        if (this.finished) {
            this.#releaseListener();
        }
    }
    get path() {
        return this.#path;
    }
    get receivedBytes() {
        return this.#receivedBytes;
    }
    get totalBytes() {
        return this.#totalBytes;
    }
    get state() {
        return this.#state;
    }
    get reason() {
        return this.#reason;
    }
    get artifact() {
        return this.#artifact;
    }
    get updatedAtUnixMs() {
        return this.#updatedAtUnixMs;
    }
    get finished() {
        return this.#state !== "inProgress";
    }
    async refresh(options = {}) {
        const state = await this.#watcher.command("downloadState", { guid: this.guid }, options);
        this.#update(parseDownloadInfo(state, this.#watcher[resourceClient]));
        return this;
    }
    async waitForFinished(options = {}) {
        if (!this.finished) {
            const event = await this.#watcher.waitFor((candidate) => candidate.method === "download.updated"
                && candidate.params.guid === this.guid
                && candidate.params.state !== "inProgress", options);
            this.#update(parseDownloadInfo(event.params, this.#watcher[resourceClient]));
        }
        return this;
    }
    async waitForCompleted(options = {}) {
        await this.waitForFinished(options);
        if (this.#state !== "completed" || !this.#artifact || !this.#path) {
            throw new ABError({
                kind: "download_failed",
                stage: "sdk.download.complete",
                message: `download ${this.guid} ended as ${this.#state}: ${this.#reason ?? "no reason reported"}`,
                details: { guid: this.guid, state: this.#state, reason: this.#reason },
            });
        }
        return this;
    }
    [inspect.custom]() {
        return `Download { guid: '${this.guid}', state: '${this.#state}', receivedBytes: ${this.#receivedBytes}, totalBytes: ${this.#totalBytes} }`;
    }
    #update(info) {
        if (info.guid !== this.guid) {
            throw new ABError({
                kind: "protocol_error",
                stage: "sdk.download.identity",
                message: `download update for ${info.guid} cannot update ${this.guid}`,
            });
        }
        this.#path = info.path;
        this.#receivedBytes = info.receivedBytes;
        this.#totalBytes = info.totalBytes;
        this.#state = info.state;
        this.#reason = info.reason;
        this.#artifact = info.artifact?.id === this.#artifact?.id ? this.#artifact : info.artifact;
        this.#updatedAtUnixMs = info.updatedAtUnixMs;
        if (this.finished) {
            this.#releaseListener();
        }
    }
    #releaseListener() {
        this.#unsubscribe?.();
        this.#unsubscribe = null;
    }
}
export class FileChooserWatcher extends Resource {
    waitForChooser(options = {}) {
        return this.waitFor((event) => event.method === "Page.fileChooserOpened", options);
    }
}
export class InitScriptRegistration extends Resource {
    instances(options = {}) {
        return this.command("instances", {}, options);
    }
    async waitForInstance(predicate = () => true, options = {}) {
        const current = (await this.instances(options)).find((instance) => instance.state === "ready" && predicate(instance));
        if (current) {
            return current;
        }
        const event = await this.waitFor((candidate) => {
            if (candidate.method !== "initScript.instanceReady") {
                return false;
            }
            const instance = candidate.params.instance;
            return instance?.state === "ready" && predicate(instance);
        }, options);
        return event.params.instance;
    }
    send(instance, name, value = null, options = {}) {
        return this.command("command", {
            instanceId: typeof instance === "string" ? instance : instance.id,
            name,
            value,
        }, options);
    }
}
function cancelledError(resourceId) {
    return new ABError({
        kind: "cancelled",
        stage: "sdk.resource.wait",
        message: `waiting on resource ${resourceId} was cancelled`,
    });
}
function parseArtifactDescriptor(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return null;
    }
    const artifact = value;
    if (typeof artifact.id !== "string"
        || typeof artifact.path !== "string"
        || typeof artifact.sha256 !== "string"
        || typeof artifact.bytes !== "number"
        || typeof artifact.mediaType !== "string"
        || typeof artifact.encoding !== "string"
        || typeof artifact.createdAtUnixMs !== "number"
        || typeof artifact.expiresAtUnixMs !== "number") {
        return null;
    }
    return {
        id: artifact.id,
        path: artifact.path,
        sha256: artifact.sha256,
        bytes: artifact.bytes,
        mediaType: artifact.mediaType,
        encoding: artifact.encoding,
        createdAtUnixMs: artifact.createdAtUnixMs,
        expiresAtUnixMs: artifact.expiresAtUnixMs,
    };
}
function parseDownloadInfo(value, client) {
    const requiredString = (field) => {
        const entry = value[field];
        if (typeof entry !== "string") {
            throw downloadProtocolError(field);
        }
        return entry;
    };
    const requiredNumber = (field) => {
        const entry = value[field];
        if (typeof entry !== "number" || !Number.isFinite(entry) || entry < 0) {
            throw downloadProtocolError(field);
        }
        return entry;
    };
    return {
        guid: requiredString("guid"),
        targetId: requiredString("targetId"),
        frameId: requiredString("frameId"),
        url: requiredString("url"),
        suggestedFilename: requiredString("suggestedFilename"),
        path: value.path === null ? null : requiredString("path"),
        receivedBytes: requiredNumber("receivedBytes"),
        totalBytes: requiredNumber("totalBytes"),
        state: requiredString("state"),
        reason: value.reason === null ? null : requiredString("reason"),
        artifact: value.artifact === null ? null : new Artifact(client, requiredDownloadArtifact(value.artifact)),
        createdAtUnixMs: requiredNumber("createdAtUnixMs"),
        updatedAtUnixMs: requiredNumber("updatedAtUnixMs"),
    };
}
function requiredDownloadArtifact(value) {
    const artifact = parseArtifactDescriptor(value);
    if (!artifact) {
        throw downloadProtocolError("artifact");
    }
    return artifact;
}
function downloadProtocolError(field) {
    return new ABError({
        kind: "protocol_error",
        stage: "sdk.download.event",
        message: `download state omitted or invalidated ${field}`,
    });
}
function parseDialogInfo(value) {
    const required = (field) => {
        const entry = value[field];
        if (typeof entry !== "string") {
            throw new ABError({
                kind: "protocol_error",
                stage: "sdk.dialog.event",
                message: `dialog opening event omitted ${field}`,
            });
        }
        return entry;
    };
    return {
        id: required("id"),
        rootTargetId: required("rootTargetId"),
        sessionId: required("sessionId"),
        type: required("type"),
        message: required("message"),
        url: required("url"),
        defaultPrompt: required("defaultPrompt"),
        hasBrowserHandler: value.hasBrowserHandler === true,
    };
}
//# sourceMappingURL=index.js.map