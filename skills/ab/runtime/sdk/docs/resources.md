# Resource lifecycle

AB resources are client-owned server objects. They buffer and sequence browser events in Rust, report completeness, and close automatically when their SDK connection disappears. Explicit disposal is still required so domain consumers and event buffers are released promptly.

## Network

```ts
const resource = await tab.observeNetwork({
  bodyRetentionBytes: 256 * 1024 * 1024,
  bodyMemoryBytes: 32 * 1024 * 1024,
  maxBodyBytes: 8 * 1024 * 1024,
  cdpBufferBytes: 100 * 1024 * 1024,
  bodyStorage: "auto",
  bodyCapture: "all",
});
const request = await resource.waitForRequest(predicate, options);
const response = await resource.waitForResponse(predicate, options);
const body = await resource.responseBody(response, options);
if (body.artifact) {
  const bytes = await body.artifact.read();
  await body.artifact.dispose();
}
await resource.assertComplete(options);
await resource.dispose(options);
```

Network event parameters preserve the corresponding CDP event payload. `responseBody()` uses the exact event `sessionId + requestId`; it never asks a root target to guess an OOPIF request. Its readiness wait polls the Rust-owned body state, so an older terminal event outside the SDK's bounded presentation history cannot create a false timeout. Chrome's renderer-independent durable buffer, AB's lifetime retention, inline memory, per-body maximum, and artifact storage mode are separate limits. Memory pressure spills to the verified ArtifactStore rather than silently shortening the observer's history. Retention eviction and unavailable Chrome bodies remain explicit errors, not truncated data.

## Console

```ts
const resource = await tab.observeConsole();
const event = await resource.waitForMessage(predicate, options);
```

The stream includes `Runtime.consoleAPICalled`, `Runtime.exceptionThrown`, and `Log.entryAdded`.

## Dialogs

```ts
const dialogs = await tab.watchDialogs();
const opened = await dialogs.waitForDialog(options);
await dialogs.accept(promptText?, options);
// or await dialogs.dismiss(options)
```

Opening a dialog can pause page JavaScript. Open the watcher before the click that may create it.

## Downloads and file choosers

```ts
const downloads = await tab.watchDownloads();
const started = await downloads.waitForDownload(options);
const completed = await downloads.waitForCompleted(options);
const bytes = await completed.artifact?.read();
await completed.artifact?.dispose();

const choosers = await tab.watchFileChoosers();
const chooser = await choosers.waitForChooser(options);
```

`waitForDownload()` identifies the start. The completed progress event carries the same verified `Artifact` handle used by screenshots and large network bodies; the suggested filename remains on `Download`. Do not treat the start event as a completed file. Downloads are saved in AB's private artifacts directory, owned by the current client, and released when that client disconnects. Copy a file to a caller-owned destination before disconnecting when it must persist; AB does not silently promote temporary artifacts into durable user files. File chooser events identify the frame and backend node; use a typed locator `setFiles()` when the input element is directly addressable.

## Init scripts

```ts
const registration = await tab.addInitScript({
  name: "order-monitor",
  world: "isolated", // default; use "main" only when page globals must be patched
  frames: "all",     // or "top"
  args: [{ channel: "orders" }],
  source: `
    const config = args[0];
    ab.onCommand((name, value) => {
      if (name === "read") return { url: location.href, config, value };
      throw new Error("unknown command: " + name);
    });
    ab.onCleanup(() => observer.disconnect());
    const observer = new MutationObserver(() => ab.emit("changed", location.href));
    observer.observe(document, { subtree: true, childList: true });
  `,
});
try {
  const instance = await registration.waitForInstance();
  const current = await registration.send(instance, "read", { request: 1 });
  const changed = await registration.waitFor(
    event => event.method === "initScript.event" && event.params.event === "changed",
  );
  await tab.navigate(url);
} finally {
  await registration.dispose();
}
```

`source` is an async function body with `ab` and `args` in scope. `ab.emit()` sends page events to the Rust-owned resource buffer, `ab.onCommand()` receives `registration.send()`, and `ab.onCleanup()` registers deterministic instance cleanup.

Registration covers the current document and future documents. Each instance exposes exact frame, session, execution-context, and document-generation identity plus `starting | ready | error | disposed` state. Navigation disposes the old document instance instead of floating it to the new document. Disposing stops future injection and invokes cleanup handlers in every live instance; it does not guess how to reverse arbitrary page effects that the script produced outside those handlers.

## Generic event consumption

Every event resource inherits:

```ts
resource.onEvent(listener): () => void
resource.waitFor(predicate, options)
resource.command(name, params, options)
resource.complete
resource.closed
resource.closeReason
resource.dispose(options)
```

If `complete` becomes false, the stream lost events. Do not infer absence from that resource's history.
