# Network observation

Open `tab.resources.network()` before the action that emits traffic. The Rust resource owns domain leases, event sequencing, completeness, Chrome buffering, AB retention, memory spilling, and cleanup across the tab's current sessions.

Request and response events preserve their originating `sessionId + requestId`. `responseBody()` uses that exact pair, including OOPIF traffic. It never asks the root target to guess which request is meant.

Large bodies use verified artifacts. Per-body and total budgets are explicit; eviction, unavailable bodies, gaps, and closed streams are errors or state, never silent truncation. Check `assertComplete()` before inferring that an event did not happen.

## Observe before triggering

```js
await browser.documentation("network");
const network = await tab.resources.network({
  bodyRetentionBytes: 256 * 1024 * 1024,
  bodyMemoryBytes: 32 * 1024 * 1024,
  maxBodyBytes: 8 * 1024 * 1024,
  cdpBufferBytes: 100 * 1024 * 1024,
  bodyStorage: "auto",
  bodyCapture: "all",
});
try {
  await tab.playwright.getByRole("button", { name: "Refresh", exact: true }).click();
  const response = await network.waitForResponse(
    event => String(event.params.response?.url ?? "").includes("/api/orders"),
    { timeoutMs: 20_000 },
  );
  const body = await network.responseBody(response);
  if (body.artifact) {
    const bytes = await body.artifact.read();
    // Decode according to body.base64Encoded and the task's content contract.
    await body.artifact.dispose();
  }
  await network.assertComplete();
} finally {
  await network.dispose();
}
```

The observer contains buffered and future events. A waiter does not consume history. Predicates run in the Node process over untrusted CDP event data; keep them deterministic and bounded.

## Event identity

Use the `BrowserEvent` returned by `waitForResponse()` when requesting its body. It carries both request id and originating session. Passing only a request id requires an explicit `sessionId` and is easier to misuse.

Redirects and retries can produce multiple events for a logical URL. Filter using the facts the task actually needs: URL, method, resource type, status, initiator, or frame/session identity. Do not treat the first substring match as authoritative when several requests are plausible.

## Bodies and budgets

`responseBody()` waits on the exact Rust-owned body state keyed by `sessionId + requestId`; it does not depend on the terminal event remaining in the SDK's bounded presentation history. Small bodies return inline. Larger bodies return the common verified `Artifact` handle in `artifact` with `body === null`; call `artifact.read()` to verify and obtain its bytes, then `artifact.dispose()` when finished. `bytes` is the captured size and `base64Encoded` describes how CDP represented the captured payload.

The limits have separate ownership. `cdpBufferBytes` controls Chrome's renderer-independent durable-message buffer, so completed response bodies can survive a process-changing navigation. `bodyRetentionBytes` controls how much completed response data remains addressable over the observer lifetime. `bodyMemoryBytes` limits inline daemon memory; `auto` spills large bodies and additional pressure to verified artifacts, while `artifact` stores every retained body there. `maxBodyBytes` rejects an individual oversized response. `bodyCapture: "text"` captures only documents, XHR/fetch, text, and JSON; asking `responseBody()` for an excluded binary response fails explicitly. Use `all` when binary bodies are part of the task. A body evicted from retention or unavailable from Chrome is an explicit state/error. Choose limits from the intended observation lifetime and payload class; do not claim partial data is complete.

## Completeness

Call `assertComplete()` before concluding that no matching request occurred. A gap can result from resource or transport backlog. If incomplete, dispose, open a fresh observer, and decide whether repeating the trigger is safe.

Network success does not by itself prove rendered UI or business success. Join it with the appropriate page observation when the user's outcome is visible state.
