# Diagnostics

AB has no status/start/stop CLI. Diagnose through the same SDK and exact runtime files.

## Connection failures

- `AB Skill installation is incomplete`: `scripts/ab-client.mjs` cannot find its packaged native runtime. Stop; do not search source, `.d.ts`, npm, or another checkout for a substitute.
- `chrome_not_found`: configure the exact Google Chrome executable in AB's product config.
- `profile_in_use_unmanaged`: another process owns the fixed AB profile without a usable AB-managed CDP endpoint. Do not switch to a temporary profile.
- `daemon_version_mismatch` or `daemon_version_in_use`: another SDK/runtime build is active. Do not force-kill it or add compatibility behavior.
- `daemon_start_timeout`: the exact launched runtime did not publish a new ready or structured failed startup state before the deadline; inspect the AB daemon log under its Application Support data root.
- `transport_closed` at `handshake.socket`: the selected product daemon closed before returning a structured handshake result. Do not continue with an undefined `agent` and do not loop retries. Report the exact `kind`, `stage`, and message; the runtime must be diagnosed or fixed outside the browser task.

`browser.documentation("diagnostics")` is unavailable until connection succeeds. This reference is the authoritative pre-connection equivalent; a connection failure never requires inspecting implementation files.

## Browser state failures

- `stale_document`: the bound ref or element belongs to an earlier document; take a new AX snapshot or resolve a new Locator target.
- `ref_not_found`: the requested ref does not belong to that explicit observation; inspect that state rather than guessing a replacement ref.
- `stale_viewport`: take a new screenshot and use its new `viewportId`.
- `resource_incomplete`: the observer lost events; recreate it before the operation whose events matter.
- `outcome_unknown`: caller wait ended after a side effect was dispatched. Rust continues the underlying operation and retains the same-tab lane until terminal; observe the current page before any retry.

## Deliberate low-level inspection

```ts
const cdp = await tab.dev.cdp();
try {
  const metrics = await cdp.send("Performance.getMetrics");
  metrics
} finally {
  await cdp.dispose();
}
```

Use CDP only to inspect a fact or invoke a browser primitive with no typed AB API. Do not rebuild normal clicking, filling, waiting, snapshotting, or resource observation from ad hoc CDP calls.

## Preserve structured evidence

```js
try {
  await operation();
} catch (error) {
  console.error({
    name: error?.name,
    kind: error?.kind,
    stage: error?.stage,
    message: error?.message,
    retryable: error?.retryable,
    context: error?.context,
    details: error?.details,
  });
}
```

Do not reduce a failure to `Error: failed`. `kind` is the stable class, `stage` identifies the ownership boundary, `context` correlates the exact request/trace/target and low-level cause, and `details` contains operation-specific lifecycle facts. `retryable` is descriptive only; AB never retries automatically.

## Request trace

```js
const traceId = error?.context?.traceId;
const trace = browser.diagnostics.snapshot({ traceId });
console.log(trace.complete, trace.dropped, trace.events);
```

Each event carries `traceId`, `requestId`, `method`, `target`, `name`, `sequence`, `timestampUnixMs` and bounded `detail`. A normal request has ordered `dispatched` and `settled` stages. An interrupted mutation additionally emits `operation.settled` after the underlying operation reaches terminal; its `settled` stage describes the caller's `outcome_unknown`, not rollback. `complete:false` means older local trace events were evicted; it must not be presented as a complete history. Trace detail deliberately omits params, page content, form values, cookies, authorization and network bodies.

Use `browser.diagnostics.onTrace(listener)` only when future timing matters, and unsubscribe deterministically. `browser.diagnostics.clear()` clears this client process's local history; it does not restart or mutate the daemon or Chrome.

## Documentation and operation failures

- `documentation_required`: call the exact `details.topic`, read the presented guidance, then retry. There is no public Core bypass.
- `agent_observation_required`: present AX state on that exact wrapped tab.
- `timeout`: a mechanical condition missed its deadline; it is not proof of rollback.
- `cancelled`: use `stage` to distinguish before-dispatch from in-flight cancellation.
- `serialization_failed`: reduce evaluate input/result to a bounded supported value.
- `observation_consistency_error`: retry a fresh atomic capture after document/frame/viewport state settles.
- strict Locator zero/multiple match: refine identity or readiness; do not silently pick or switch to JavaScript. A `strict_violation` prints bounded `details.candidates` with stable indices, frame, role/name/text, visibility and bounded attributes. Use those observed facts to add semantic/ancestor/frame/visibility scope. If multiple candidates remain intentionally valid, use `all()` plus `inspect()` and only then choose `nth(index)` from the reported index.
- actionability/hit-target failure: inspect overlays, visibility, disabled state, and current UI.

If documentation presentation itself fails, its topic is not marked read. Repair the Presenter rather than pretending the guidance was consumed.

## Resource and artifact failures

- `resource_closed`: inspect `closeReason`; recreate only for a genuinely new observation window.
- `resource_transport_overflow`, `resource_incomplete`, or a gap: history cannot prove absence.
- `download_failed`: a start did not reach completed artifact state.
- `artifact_corrupt`: byte length or SHA-256 verification failed; do not use the artifact.

## Diagnose without a CLI

Current client state is `browser.connected`; browser/daemon identity is `browser.identity`; tab state comes from `browser.tabs.list()` and `tab.refresh()`; resource state comes from the resource object and `refresh()`. AB intentionally exposes no status command.

## Retry decision

1. Pure read before dispatch: repeat against refreshed identity.
2. Waiter timeout with complete observer: refine the predicate or report the absent event.
3. Stale identity: obtain a new explicit identity.
4. Mutation before dispatch: reconsider from current intent.
5. Mutation after dispatch or `outcome_unknown`: observe whether it already happened.
6. Incomplete resource: recreate before a safe trigger; never infer absence.
7. Install/version/product error: stop the browser task and report structured diagnostics.
