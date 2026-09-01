import { writeFile } from "node:fs/promises";
import type {
  BrowserEvent,
  NetworkObserver,
  Tab,
} from "../../sdk/ts/src/index.ts";

type Headers = Record<string, unknown>;

type RequestRecord = {
  key: string;
  observer: NetworkObserver;
  request: BrowserEvent;
  response?: BrowserEvent;
  finished?: BrowserEvent;
  failed?: BrowserEvent;
  redirect: boolean;
};

export type HarRecorderOptions = {
  bodyRetentionBytes?: number;
  bodyMemoryBytes?: number;
  maxBodyBytes?: number;
  cdpBufferBytes?: number;
  settleTimeoutMs?: number;
  bodyReadConcurrency?: number;
};

export type HarBodyFailure = {
  url: string;
  sessionId: string | null;
  requestId: string | null;
  kind: string;
  stage: string;
  message: string;
};

export type HarAttachmentFailure = {
  targetId: string;
  message: string;
};

export type HarWriteResult = {
  entries: number;
  complete: boolean;
  bodyFailures: readonly HarBodyFailure[];
  attachmentFailures: readonly HarAttachmentFailure[];
  targets: readonly string[];
  lateAttachedTargets: readonly string[];
};

type HarEntryBuild = {
  entry: Record<string, unknown> | null;
  bodyFailure: HarBodyFailure | null;
};

/** Records WebArena-Verified-compatible HAR through AB's Rust-owned CDP resource. */
export class ABHarRecorder {
  readonly #observers = new Map<string, NetworkObserver>();
  readonly #events = new Map<string, Map<number, BrowserEvent>>();
  readonly #unsubscribe = new Map<string, () => void>();
  readonly #lateAttachedTargets = new Set<string>();
  readonly #attachmentFailures: HarAttachmentFailure[] = [];
  readonly #bodyRetentionBytes: number;
  readonly #bodyMemoryBytes: number;
  readonly #maxBodyBytes: number;
  readonly #cdpBufferBytes: number;
  readonly #settleTimeoutMs: number;
  readonly #bodyReadConcurrency: number;

  private constructor(options: HarRecorderOptions) {
    this.#bodyRetentionBytes = options.bodyRetentionBytes ?? 256 * 1024 * 1024;
    this.#bodyMemoryBytes = options.bodyMemoryBytes ?? 16 * 1024 * 1024;
    this.#maxBodyBytes = options.maxBodyBytes ?? 8 * 1024 * 1024;
    this.#cdpBufferBytes = options.cdpBufferBytes ?? 100 * 1024 * 1024;
    this.#settleTimeoutMs = options.settleTimeoutMs ?? 5_000;
    this.#bodyReadConcurrency = options.bodyReadConcurrency ?? 16;
    if (!Number.isInteger(this.#bodyReadConcurrency) || this.#bodyReadConcurrency <= 0) {
      throw new TypeError("bodyReadConcurrency must be a positive integer");
    }
  }

  static async start(
    tabs: Tab | readonly Tab[],
    options: HarRecorderOptions = {},
  ): Promise<ABHarRecorder> {
    const values = Array.isArray(tabs) ? tabs : [tabs];
    if (values.length === 0) throw new TypeError("ABHarRecorder requires at least one tab");
    const recorder = new ABHarRecorder(options);
    try {
      await recorder.addTabs(values, { late: false });
      return recorder;
    } catch (error) {
      await recorder.dispose().catch(() => undefined);
      throw error;
    }
  }

  async addTabs(
    tabs: Tab | readonly Tab[],
    options: { late?: boolean } = {},
  ): Promise<void> {
    const values = Array.isArray(tabs) ? tabs : [tabs];
    for (const tab of values) {
      if (this.#observers.has(tab.id)) continue;
      const observer = await tab.observeNetwork({
        bodyRetentionBytes: this.#bodyRetentionBytes,
        bodyMemoryBytes: this.#bodyMemoryBytes,
        maxBodyBytes: this.#maxBodyBytes,
        cdpBufferBytes: this.#cdpBufferBytes,
        bodyStorage: "artifact",
        bodyCapture: "text",
      });
      const events = new Map<number, BrowserEvent>();
      const unsubscribe = observer.onEvent((event: BrowserEvent) => events.set(event.sequence, event));
      for (const event of observer.events) events.set(event.sequence, event);
      this.#observers.set(tab.id, observer);
      this.#events.set(tab.id, events);
      this.#unsubscribe.set(tab.id, unsubscribe);
      if (options.late ?? true) this.#lateAttachedTargets.add(tab.id);
    }
  }

  markAttachmentFailure(targetId: string, error: unknown): void {
    this.#lateAttachedTargets.add(targetId);
    this.#attachmentFailures.push({
      targetId,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  async write(path: string): Promise<HarWriteResult> {
    const observers = [...this.#observers.values()];
    const openObservers = observers.filter((observer) => !observer.closed);
    await Promise.all(openObservers.map((observer) => observer.refresh()));
    const pending = collectRecords(observers, this.#events);
    const settleFailures = await this.#settle(pending);
    await Promise.all(openObservers.filter((observer) => !observer.closed).map((observer) => observer.refresh()));
    const records = collectRecords(observers, this.#events);
    const builds = await mapConcurrent(
      [...records.values()],
      this.#bodyReadConcurrency,
      (record) => this.#entry(
        record,
        record.finished || record.failed ? null : settleFailures.get(record.key) ?? null,
      ),
    );
    const filtered = builds
      .map((build) => build.entry)
      .filter((entry): entry is Record<string, unknown> => entry !== null);
    const bodyFailures = builds
      .map((build) => build.bodyFailure)
      .filter((failure): failure is HarBodyFailure => failure !== null);
    const lateAttachedTargets = [...this.#lateAttachedTargets];
    const complete = observers.every((observer) => observer.complete)
      && bodyFailures.length === 0
      && this.#attachmentFailures.length === 0
      && lateAttachedTargets.length === 0;
    const har = {
      log: {
        version: "1.2",
        creator: { name: "AB", version: "0.1.0" },
        pages: [],
        entries: filtered,
      },
    };
    await writeFile(path, `${JSON.stringify(har, null, 2)}\n`);
    return {
      entries: filtered.length,
      complete,
      bodyFailures,
      attachmentFailures: [...this.#attachmentFailures],
      targets: [...this.#observers.keys()],
      lateAttachedTargets,
    };
  }

  async dispose(): Promise<void> {
    const observers = [...this.#observers.values()];
    for (const unsubscribe of this.#unsubscribe.values()) unsubscribe();
    this.#observers.clear();
    this.#events.clear();
    this.#unsubscribe.clear();
    await Promise.all(observers.map((observer) => observer.dispose()));
  }

  async #settle(records: ReadonlyMap<string, RequestRecord>): Promise<Map<string, HarBodyFailure>> {
    const failures = new Map<string, HarBodyFailure>();
    const pending = [...records.values()].filter((record) => expectsResponseBody(record)
      && !record.observer.closed
      && !record.finished
      && !record.failed);
    await Promise.all(pending.map(async (record) => {
      const requestId = stringValue(record.request.params.requestId);
      const sessionId = record.request.sessionId;
      if (!requestId) return;
      try {
        await record.observer.waitFor(
          (event) => event.sessionId === sessionId
            && event.params.requestId === requestId
            && (event.method === "Network.loadingFinished" || event.method === "Network.loadingFailed"),
          { timeoutMs: this.#settleTimeoutMs },
        );
      } catch (error) {
        const request = record.request.params.request as Record<string, unknown> | undefined;
        failures.set(record.key, {
          url: stringValue(request?.url) ?? "",
          sessionId,
          requestId,
          kind: "network_body_incomplete",
          stage: "har.settle",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }));
    return failures;
  }

  async #entry(record: RequestRecord, lifecycleFailure: HarBodyFailure | null): Promise<HarEntryBuild> {
    const request = record.request.params.request as Record<string, unknown> | undefined;
    if (!request || typeof request.url !== "string") {
      return { entry: null, bodyFailure: null };
    }
    const response = record.response?.params.response as Record<string, unknown> | undefined;
    const requestHeaders = headerEntries(request.headers);
    const responseHeaders = headerEntries(response?.headers);
    const mimeType = stringValue(response?.mimeType) ?? headerValue(responseHeaders, "content-type") ?? "";
    const postData = stringValue(request.postData);
    let body: { text?: string; encoding?: "base64" } = {};
    let bodyFailure: HarBodyFailure | null = lifecycleFailure;
    if (!record.observer.closed && record.response && record.finished && expectsResponseBody(record)) {
      try {
        const captured = await record.observer.responseBody(record.response, { timeoutMs: 5_000 });
        if (captured.body !== null) {
          body = captured.base64Encoded
            ? { text: captured.body, encoding: "base64" }
            : { text: captured.body };
        } else if (captured.artifact) {
          try {
            const bytes = await captured.artifact.read();
            body = captured.base64Encoded
              ? { text: Buffer.from(bytes).toString("base64"), encoding: "base64" }
              : { text: new TextDecoder().decode(bytes) };
          } finally {
            await captured.artifact.dispose();
          }
        }
      } catch (error) {
        bodyFailure = bodyFailureFrom(error, request.url, record);
      }
    }
    const wallTime = numberValue(record.request.params.wallTime);
    const startedDateTime = wallTime === undefined
      ? new Date().toISOString()
      : new Date(wallTime * 1_000).toISOString();
    const requestTimestamp = numberValue(record.request.params.timestamp) ?? 0;
    const endTimestamp = numberValue(record.finished?.params.timestamp)
      ?? numberValue(record.failed?.params.timestamp)
      ?? numberValue(record.response?.params.timestamp)
      ?? requestTimestamp;
    const elapsedMs = Math.max(0, (endTimestamp - requestTimestamp) * 1_000);
    const responseStatus = numberValue(response?.status) ?? (record.failed ? 0 : -1);
    const responseBodySize = numberValue(record.finished?.params.encodedDataLength) ?? -1;
    return { entry: {
      startedDateTime,
      time: elapsedMs,
      request: {
        method: stringValue(request.method) ?? "GET",
        url: request.url,
        httpVersion: protocolVersion(response),
        cookies: [],
        headers: requestHeaders,
        queryString: queryEntries(request.url),
        ...(postData === undefined ? {} : {
          postData: {
            mimeType: headerValue(requestHeaders, "content-type") ?? "application/octet-stream",
            text: postData,
          },
        }),
        headersSize: -1,
        bodySize: postData === undefined ? 0 : Buffer.byteLength(postData),
      },
      response: {
        status: responseStatus,
        statusText: stringValue(response?.statusText) ?? stringValue(record.failed?.params.errorText) ?? "",
        httpVersion: protocolVersion(response),
        cookies: responseCookies(responseHeaders),
        headers: responseHeaders,
        content: {
          size: responseBodySize,
          mimeType,
          ...body,
        },
        redirectURL: headerValue(responseHeaders, "location") ?? "",
        headersSize: -1,
        bodySize: responseBodySize,
      },
      cache: {},
      timings: { send: -1, wait: -1, receive: elapsedMs },
      _ab: {
        sessionId: record.request.sessionId,
        requestId: record.request.params.requestId,
        complete: record.request.complete
          && (record.response?.complete ?? true)
          && (record.finished?.complete ?? record.failed?.complete ?? true),
        ...(bodyFailure === null ? {} : { bodyError: bodyFailure }),
      },
    }, bodyFailure };
  }
}

function bodyFailureFrom(error: unknown, url: string, record: RequestRecord): HarBodyFailure {
  const value = error && typeof error === "object"
    ? error as { kind?: unknown; stage?: unknown; message?: unknown }
    : {};
  return {
    url,
    sessionId: record.request.sessionId ?? null,
    requestId: stringValue(record.request.params.requestId) ?? null,
    kind: stringValue(value.kind) ?? "unknown",
    stage: stringValue(value.stage) ?? "har.responseBody",
    message: stringValue(value.message) ?? String(error),
  };
}

function collectRecords(
  observers: readonly NetworkObserver[],
  capturedEvents: ReadonlyMap<string, ReadonlyMap<number, BrowserEvent>>,
): Map<string, RequestRecord> {
  const records = new Map<string, RequestRecord>();
  const active = new Map<string, { key: string; hop: number }>();
  for (const observer of observers) {
    const events = [...(capturedEvents.get(observer.targetId)?.values() ?? observer.events)]
      .sort((left, right) => left.sequence - right.sequence);
    for (const event of events) {
      const requestId = stringValue(event.params.requestId);
      if (!requestId) continue;
      const baseKey = `${observer.targetId}:${event.sessionId ?? "root"}:${requestId}`;
      if (event.method === "Network.requestWillBeSent") {
        const previous = active.get(baseKey);
        const redirectResponse = event.params.redirectResponse;
        if (previous && redirectResponse && typeof redirectResponse === "object") {
          const record = records.get(previous.key);
          if (record) {
            record.redirect = true;
            record.response = redirectResponseEvent(event, requestId, redirectResponse);
            record.finished = redirectFinishedEvent(event, requestId);
          }
        }
        const hop = (previous?.hop ?? -1) + 1;
        const key = `${baseKey}:${hop}`;
        records.set(key, { key, observer, request: event, redirect: false });
        active.set(baseKey, { key, hop });
        continue;
      }
      const current = active.get(baseKey);
      const record = current ? records.get(current.key) : undefined;
      if (!record) continue;
      if (event.method === "Network.responseReceived") record.response = event;
      if (event.method === "Network.loadingFinished") record.finished = event;
      if (event.method === "Network.loadingFailed") record.failed = event;
    }
  }
  return records;
}

function expectsResponseBody(record: RequestRecord): boolean {
  if (record.redirect) return false;
  if (!record.response) return false;
  const request = record.request.params.request as Record<string, unknown> | undefined;
  const response = record.response.params.response as Record<string, unknown> | undefined;
  const status = numberValue(response?.status);
  if (stringValue(request?.method) === "HEAD" || status === 204 || status === 304) return false;
  const headers = headerEntries(response?.headers);
  const mimeType = stringValue(response?.mimeType) ?? headerValue(headers, "content-type") ?? "";
  return shouldCaptureBody(record.response.params.type, mimeType);
}

function redirectResponseEvent(
  event: BrowserEvent,
  requestId: string,
  response: object,
): BrowserEvent {
  return {
    ...event,
    method: "Network.responseReceived",
    params: {
      requestId,
      loaderId: event.params.loaderId,
      timestamp: event.params.timestamp,
      type: event.params.type,
      response,
    },
  };
}

function redirectFinishedEvent(event: BrowserEvent, requestId: string): BrowserEvent {
  return {
    ...event,
    method: "Network.loadingFinished",
    params: {
      requestId,
      timestamp: event.params.timestamp,
      encodedDataLength: 0,
    },
  };
}

function headerEntries(value: unknown): Array<{ name: string; value: string }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value as Headers).map(([name, entry]) => ({ name, value: String(entry) }));
}

function headerValue(headers: Array<{ name: string; value: string }>, name: string): string | undefined {
  return headers.find((entry) => entry.name.toLowerCase() === name)?.value;
}

function responseCookies(headers: Array<{ name: string; value: string }>): Array<{ name: string; value: string }> {
  return headers
    .filter((header) => header.name.toLowerCase() === "set-cookie")
    .map((header) => {
      const [pair = ""] = header.value.split(";", 1);
      const separator = pair.indexOf("=");
      return separator < 0
        ? { name: pair, value: "" }
        : { name: pair.slice(0, separator), value: pair.slice(separator + 1) };
    });
}

function queryEntries(url: string): Array<{ name: string; value: string }> {
  try {
    return [...new URL(url).searchParams].map(([name, value]) => ({ name, value }));
  } catch {
    return [];
  }
}

function protocolVersion(response: Record<string, unknown> | undefined): string {
  const protocol = stringValue(response?.protocol);
  if (!protocol) return "HTTP/1.1";
  if (protocol === "h2") return "HTTP/2.0";
  if (protocol === "h3") return "HTTP/3.0";
  return protocol.toUpperCase().startsWith("HTTP/") ? protocol.toUpperCase() : protocol;
}

function shouldCaptureBody(resourceType: unknown, mimeType: string): boolean {
  return resourceType === "Document"
    || resourceType === "XHR"
    || resourceType === "Fetch"
    || mimeType.includes("json")
    || mimeType.startsWith("text/");
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await operation(values[index]!);
    }
  }));
  return results;
}
