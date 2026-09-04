import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { ABError } from "../errors/index.js";
import { BUILD_ID, PROTOCOL_VERSION, SDK_VERSION, } from "../protocol.js";
import { launchRuntime, readRuntimeStartupState, resolveRuntimeBinary, } from "../runtime/native.js";
import { socketPath } from "../runtime/paths.js";
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const MAX_RESOURCE_BACKLOG = 4096;
const MAX_TRACE_EVENTS = 8192;
export class ProtocolClient {
    ready;
    #socket;
    #pending = new Map();
    #resourceListeners = new Map();
    #resourceBacklog = new Map();
    #traceHistory = [];
    #traceListeners = new Set();
    #traceDropped = 0;
    #buffer = Buffer.alloc(0);
    #closed = false;
    #closing = false;
    #onClose;
    constructor(socket, ready) {
        this.#socket = socket;
        this.ready = ready;
        socket.on("data", (chunk) => this.#accept(chunk));
        socket.on("error", (error) => this.#failAll(error));
        socket.on("close", () => this.#failAll(new ABError({
            kind: "transport_closed",
            stage: "sdk.socket",
            message: "AB daemon connection closed",
        })));
        socket.unref();
    }
    static async connect(provider, timeoutMs = 30_000, signal) {
        const path = socketPath(provider);
        const deadline = Date.now() + timeoutMs;
        let socket;
        if (!existsSync(path)) {
            socket = await launchAndWaitForSocket(provider, path, deadline, signal);
        }
        else {
            try {
                socket = await openSocket(path);
            }
            catch (error) {
                if (!isRecoverableConnectError(error)) {
                    throw error;
                }
                socket = await launchAndWaitForSocket(provider, path, deadline, signal);
            }
        }
        let ready;
        try {
            ready = await handshake(socket, remainingTimeout(deadline), signal);
        }
        catch (error) {
            socket.destroy();
            if (!requestsDaemonHandover(error)) {
                throw error;
            }
            await waitForDaemonRelease(path, remainingTimeout(deadline), signal);
            socket = await launchAndWaitForSocket(provider, path, deadline, signal);
            try {
                ready = await handshake(socket, remainingTimeout(deadline), signal);
            }
            catch (retryError) {
                socket.destroy();
                throw retryError;
            }
        }
        return new ProtocolClient(socket, ready);
    }
    get connected() {
        return !this.#closed && !this.#closing;
    }
    onClose(callback) {
        this.#onClose = callback;
    }
    subscribeResource(resourceId, listener) {
        const listeners = this.#resourceListeners.get(resourceId) ?? new Set();
        listeners.add(listener);
        this.#resourceListeners.set(resourceId, listeners);
        const backlog = this.#resourceBacklog.get(resourceId);
        if (backlog) {
            this.#resourceBacklog.delete(resourceId);
            for (const message of backlog) {
                listener(message);
            }
        }
        return () => {
            const current = this.#resourceListeners.get(resourceId);
            current?.delete(listener);
            if (current?.size === 0) {
                this.#resourceListeners.delete(resourceId);
            }
        };
    }
    traceSnapshot(filter = {}) {
        const events = this.#traceHistory.filter((event) => (filter.traceId === undefined || event.traceId === filter.traceId)
            && (filter.requestId === undefined || event.requestId === filter.requestId));
        return {
            events,
            dropped: this.#traceDropped,
            complete: this.#traceDropped === 0,
        };
    }
    subscribeTrace(listener) {
        this.#traceListeners.add(listener);
        return () => this.#traceListeners.delete(listener);
    }
    clearTraceHistory() {
        this.#traceHistory.length = 0;
        this.#traceDropped = 0;
    }
    async request(method, params, options = {}) {
        if (this.#closed || this.#closing) {
            throw new ABError({
                kind: "transport_closed",
                stage: "sdk.request",
                message: "AB client is disconnected",
            });
        }
        const id = randomUUID();
        const traceId = randomUUID();
        const timeoutMs = options.timeoutMs ?? 30_000;
        if (options.signal?.aborted) {
            throw new ABError({
                kind: "cancelled",
                stage: "sdk.request.before_dispatch",
                message: `${method} was cancelled before dispatch`,
                retryable: true,
                context: {
                    requestId: id,
                    traceId,
                    method,
                    ...(options.target ? { target: options.target } : {}),
                },
            });
        }
        const deadlineUnixMs = Date.now() + timeoutMs;
        const message = {
            type: "request",
            id,
            method,
            trace: { traceId },
            ...(options.target ? { target: options.target } : {}),
            params,
            deadlineUnixMs,
        };
        this.#socket.ref();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.#sendCancel(id);
                this.#pending.delete(id);
                this.#unrefWhenIdle();
                reject(new ABError({
                    kind: "timeout",
                    stage: "sdk.request.wait",
                    message: `${method} exceeded ${timeoutMs}ms`,
                    context: {
                        requestId: id,
                        traceId,
                        method,
                        ...(options.target ? { target: options.target } : {}),
                    },
                }));
            }, timeoutMs + 500);
            const onAbort = options.signal
                ? () => this.#sendCancel(id)
                : undefined;
            if (onAbort) {
                options.signal.addEventListener("abort", onAbort, { once: true });
            }
            this.#pending.set(id, {
                resolve: (value) => resolve(value),
                reject,
                timer,
                ...(options.signal ? { signal: options.signal } : {}),
                ...(onAbort ? { onAbort } : {}),
            });
            this.#socket.write(encodeFrame(message), (error) => {
                if (!error) {
                    return;
                }
                const pending = this.#pending.get(id);
                if (pending) {
                    this.#clearPending(pending);
                    this.#pending.delete(id);
                    pending.reject(error);
                    this.#unrefWhenIdle();
                }
            });
        });
    }
    async disconnect() {
        if (this.#closed || this.#closing) {
            return;
        }
        if (this.#pending.size > 0) {
            this.#closing = true;
            this.#closed = true;
            this.#socket.end();
            this.#failAll(new ABError({
                kind: "client_disconnected",
                stage: "sdk.disconnect",
                message: "AB client disconnected while operations were in flight",
            }));
            return;
        }
        const release = this.request("client.release", {}, { timeoutMs: 30_000 });
        this.#closing = true;
        try {
            // Graceful disconnect is an acknowledged ownership boundary: the call
            // resolves only after Rust has released this client's resources and
            // target leases. Abrupt EOF remains the crash-cleanup fallback. See
            // docs/evidence/20260902__client-target-ownership-and-popup-expectation__@codex.md.
            await release;
        }
        finally {
            this.#closed = true;
            this.#socket.end();
            this.#failAll(new ABError({
                kind: "client_disconnected",
                stage: "sdk.disconnect",
                message: "AB client disconnected",
            }));
        }
    }
    #accept(chunk) {
        this.#buffer = Buffer.concat([this.#buffer, chunk]);
        while (this.#buffer.length >= 4) {
            const length = this.#buffer.readUInt32BE(0);
            if (length === 0 || length > MAX_FRAME_BYTES) {
                this.#failAll(new ABError({
                    kind: "protocol_error",
                    stage: "sdk.frame.length",
                    message: `invalid daemon frame length ${length}`,
                }));
                this.#socket.destroy();
                return;
            }
            if (this.#buffer.length < length + 4) {
                return;
            }
            const bytes = this.#buffer.subarray(4, length + 4);
            this.#buffer = this.#buffer.subarray(length + 4);
            let message;
            try {
                message = JSON.parse(bytes.toString("utf8"));
            }
            catch (error) {
                this.#failAll(error instanceof Error ? error : new Error(String(error)));
                this.#socket.destroy();
                return;
            }
            if (message.type === "response") {
                this.#acceptResponse(message);
            }
            else if (message.type === "stage") {
                this.#acceptTrace(message);
            }
            else if (message.type === "resource.event" || message.type === "resource.closed") {
                this.#acceptResource(message);
            }
        }
    }
    #acceptResponse(response) {
        const pending = this.#pending.get(response.id);
        if (!pending) {
            return;
        }
        this.#clearPending(pending);
        this.#pending.delete(response.id);
        if (response.outcome.status === "success") {
            pending.resolve(response.outcome.result);
        }
        else if (response.outcome.status === "error") {
            pending.reject(new ABError(response.outcome.error));
        }
        else {
            pending.reject(new ABError({
                kind: "protocol_error",
                stage: "sdk.response",
                message: `response ${response.id} has an unknown outcome`,
            }));
        }
        this.#unrefWhenIdle();
    }
    #acceptResource(message) {
        const listeners = this.#resourceListeners.get(message.resourceId);
        if (listeners?.size) {
            for (const listener of listeners) {
                listener(message);
            }
            return;
        }
        const backlog = this.#resourceBacklog.get(message.resourceId) ?? [];
        if (backlog.length >= MAX_RESOURCE_BACKLOG) {
            const error = new ABError({
                kind: "resource_transport_overflow",
                stage: "sdk.resource.backlog",
                message: `resource ${message.resourceId} produced events before a consumer attached`,
            });
            this.#failAll(error);
            this.#socket.destroy(error);
            return;
        }
        backlog.push(message);
        this.#resourceBacklog.set(message.resourceId, backlog);
    }
    #acceptTrace(event) {
        if (this.#traceHistory.length >= MAX_TRACE_EVENTS) {
            this.#traceHistory.shift();
            this.#traceDropped += 1;
        }
        this.#traceHistory.push(event);
        for (const listener of this.#traceListeners) {
            listener(event);
        }
    }
    #unrefWhenIdle() {
        if (this.#pending.size === 0 && !this.#closed) {
            this.#socket.unref();
        }
    }
    #sendCancel(requestId) {
        if (this.#closed || !this.#pending.has(requestId)) {
            return;
        }
        this.#socket.write(encodeFrame({
            type: "cancel",
            id: randomUUID(),
            requestId,
        }));
    }
    #clearPending(pending) {
        clearTimeout(pending.timer);
        if (pending.signal && pending.onAbort) {
            pending.signal.removeEventListener("abort", pending.onAbort);
        }
    }
    #failAll(error) {
        if (!this.#closed) {
            this.#closed = true;
        }
        for (const pending of this.#pending.values()) {
            this.#clearPending(pending);
            pending.reject(error);
        }
        this.#pending.clear();
        this.#onClose?.();
    }
}
async function handshake(socket, timeoutMs, signal) {
    socket.ref();
    const ready = new Promise((resolve, reject) => {
        let buffer = Buffer.alloc(0);
        const timer = setTimeout(() => {
            cleanup();
            reject(new ABError({
                kind: "timeout",
                stage: "handshake.wait",
                message: `AB handshake exceeded ${timeoutMs}ms`,
            }));
        }, timeoutMs);
        const onData = (chunk) => {
            buffer = Buffer.concat([buffer, chunk]);
            if (buffer.length < 4) {
                return;
            }
            const length = buffer.readUInt32BE(0);
            if (length === 0 || length > MAX_FRAME_BYTES || buffer.length < length + 4) {
                return;
            }
            try {
                const message = JSON.parse(buffer.subarray(4, length + 4).toString("utf8"));
                if (message.type === "client.rejected") {
                    if (!message.error) {
                        throw new Error("AB daemon rejected the client without an error");
                    }
                    throw new ABError(message.error);
                }
                if (message.type !== "client.ready") {
                    throw new Error(`expected client.ready, received ${String(message.type)}`);
                }
                cleanup();
                resolve(message);
            }
            catch (error) {
                cleanup();
                reject(error instanceof Error ? error : new Error(String(error)));
            }
        };
        const onError = (error) => {
            cleanup();
            reject(error);
        };
        const onClose = () => {
            cleanup();
            reject(new ABError({
                kind: "transport_closed",
                stage: "handshake.socket",
                message: "AB daemon closed the socket during handshake",
            }));
        };
        const onAbort = () => {
            cleanup();
            socket.destroy();
            reject(new ABError({
                kind: "cancelled",
                stage: "handshake.cancel",
                message: "AB connection was cancelled",
            }));
        };
        function cleanup() {
            clearTimeout(timer);
            socket.off("data", onData);
            socket.off("error", onError);
            socket.off("close", onClose);
            signal?.removeEventListener("abort", onAbort);
        }
        socket.on("data", onData);
        socket.on("error", onError);
        socket.on("close", onClose);
        signal?.addEventListener("abort", onAbort, { once: true });
        socket.write(encodeFrame({
            type: "client.hello",
            protocolVersion: PROTOCOL_VERSION,
            sdkVersion: SDK_VERSION,
            buildId: BUILD_ID,
        }));
    });
    const result = await ready;
    socket.unref();
    return result;
}
function encodeFrame(value) {
    const body = Buffer.from(JSON.stringify(value), "utf8");
    if (body.length > MAX_FRAME_BYTES) {
        throw new Error(`AB frame exceeds ${MAX_FRAME_BYTES} bytes`);
    }
    const frame = Buffer.allocUnsafe(body.length + 4);
    frame.writeUInt32BE(body.length, 0);
    body.copy(frame, 4);
    return frame;
}
function openSocket(path, signal) {
    return new Promise((resolve, reject) => {
        const socket = new Socket();
        const onConnect = () => {
            cleanup();
            resolve(socket);
        };
        const onError = (error) => {
            cleanup();
            socket.destroy();
            reject(error);
        };
        const onAbort = () => {
            cleanup();
            socket.destroy();
            reject(new ABError({
                kind: "cancelled",
                stage: "sdk.socket.connect",
                message: "AB socket connection was cancelled",
            }));
        };
        const cleanup = () => {
            socket.off("connect", onConnect);
            socket.off("error", onError);
            signal?.removeEventListener("abort", onAbort);
        };
        socket.once("connect", onConnect);
        socket.once("error", onError);
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) {
            onAbort();
            return;
        }
        socket.connect(path);
    });
}
async function launchAndWaitForSocket(provider, path, deadline, signal) {
    const baseline = await readRuntimeStartupState(provider);
    const binary = await resolveRuntimeBinary();
    launchRuntime(binary, provider);
    const startup = await waitForRuntimeReady(provider, baseline?.startupId ?? null, deadline, signal);
    return waitForSocket(provider, path, remainingTimeout(deadline), signal, startupSignature(startup));
}
async function waitForRuntimeReady(provider, baselineStartupId, deadline, signal) {
    while (Date.now() < deadline) {
        if (signal?.aborted) {
            throw new ABError({
                kind: "cancelled",
                stage: "sdk.startup.wait",
                message: "AB startup wait was cancelled",
            });
        }
        const state = await readRuntimeStartupState(provider);
        if (state && state.startupId !== baselineStartupId) {
            if (state.state === "failed" && state.error) {
                throw new ABError(state.error);
            }
            if (state.state === "ready") {
                return state;
            }
        }
        await delay(25);
    }
    throw new ABError({
        kind: "daemon_start_timeout",
        stage: "sdk.startup.wait",
        message: "AB runtime did not publish a new ready state or structured failure before the deadline",
    });
}
async function waitForSocket(provider, path, timeoutMs, signal, startupBaseline = null) {
    const deadline = Date.now() + timeoutMs;
    let lastError;
    while (Date.now() < deadline) {
        if (signal?.aborted) {
            throw new ABError({
                kind: "cancelled",
                stage: "sdk.socket.wait",
                message: "AB connection was cancelled",
            });
        }
        try {
            return await openSocket(path, signal);
        }
        catch (error) {
            lastError = error;
            if (!isRecoverableConnectError(error)) {
                throw error;
            }
            await throwNewStartupFailure(provider, startupBaseline);
            await delay(50);
        }
    }
    await throwNewStartupFailure(provider, startupBaseline);
    throw new ABError({
        kind: "daemon_start_timeout",
        stage: "sdk.socket.wait",
        message: `AB daemon did not accept connections at ${path}`,
        details: lastError instanceof Error ? lastError.message : lastError,
    });
}
async function throwNewStartupFailure(provider, baseline) {
    const state = await readRuntimeStartupState(provider);
    if (state?.state === "failed"
        && state.error
        && startupSignature(state) !== baseline) {
        throw new ABError(state.error);
    }
}
function startupSignature(state) {
    return state === null ? null : JSON.stringify(state);
}
async function waitForDaemonRelease(path, timeoutMs, signal) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (signal?.aborted) {
            throw new ABError({
                kind: "cancelled",
                stage: "sdk.daemon.handover",
                message: "AB daemon handover was cancelled",
            });
        }
        if (!existsSync(path))
            return;
        try {
            const socket = await openSocket(path);
            socket.destroy();
        }
        catch (error) {
            if (isRecoverableConnectError(error))
                return;
            throw error;
        }
        await delay(25);
    }
    throw new ABError({
        kind: "daemon_handover_timeout",
        stage: "sdk.daemon.handover",
        message: `previous AB daemon did not release ${path}`,
    });
}
function requestsDaemonHandover(error) {
    if (!(error instanceof ABError) || error.kind !== "daemon_version_mismatch") {
        return false;
    }
    const details = error.details;
    return Boolean(details
        && typeof details === "object"
        && "handoverAllowed" in details
        && details.handoverAllowed === true);
}
function remainingTimeout(deadline) {
    return Math.max(1, deadline - Date.now());
}
function isRecoverableConnectError(error) {
    const code = error?.code;
    return code === "ENOENT" || code === "ECONNREFUSED";
}
//# sourceMappingURL=index.js.map