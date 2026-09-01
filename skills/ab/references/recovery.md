# Failure recovery

Recover from browser facts, not from repeated guesses. AB errors carry stable `kind`, `stage`, `message`, and optional `details`; preserve these fields when reporting a failure.

## Decide whether an operation was dispatched

- `cancelled` at `before_dispatch`: no browser mutation was sent.
- `cancelled` after dispatch applies only to a pure operation; Rust stops that operation and it is mechanically retryable against refreshed identity.
- `outcome_unknown`: a side-effecting caller stopped waiting after dispatch. Rust keeps the underlying browser operation and target lane alive until its real terminal state; never replay it automatically.
- `transport_closed`: reconnect, list tabs, and inspect the target. Do not continue using the old Agent object.

Reads can usually be repeated after reconnecting. Mutations require state-based reconciliation.

An `ActionResult` with `observationOutcome.status === "failed"` is different from `outcome_unknown`: browser input dispatch completed, but the requested post-action AX capture did not. Do not repeat the mutation. Read `observationOutcome.error`, then capture a fresh state or use the prepared Resource that represents the intended result. `skippedDialog` likewise means dispatch completed and the dialog in the same result must be handled before AX capture can continue.

For an interrupted mutation, the request trace first records caller `settled` with `outcome_unknown`, then `operation.settled` when the underlying browser operation reaches its real terminal state. A following action on the same tab waits behind that operation. The terminal trace helps diagnosis; the rendered application state still decides whether the user's business outcome occurred.

## Identity failures

| Error fact | Meaning | Recovery |
| --- | --- | --- |
| `agent_observation_required` | no state was successfully presented for short refs | `tab.ax.write("state")` |
| `ref_not_found` | the ref is not in that explicit observation | inspect that state or present a new one; do not guess a nearby id |
| `stale_document` | document generation changed | discard refs/handles/frame assumptions and observe again |
| `stale_viewport` | coordinates belong to older pixels | capture a new screenshot and use its `viewportId` |
| `stale_dialog` | the dialog already closed or was replaced | inspect page state; do not accept/dismiss another dialog by assumption |
| `resource_disposed` | the client object no longer owns a live server object | create a new object only if the task still needs it |
| `action_intercepted` | the event-time pointer target was another element and AB blocked the wrong-target attempt before application handlers | observe the active surface, resolve the overlay or changed layout, then issue a new explicit action from fresh identity |

## Locator failures

A strict Locator failure is evidence about the query or page, not a request to fall back to JavaScript.

- zero matches: refresh/observe, check frame scope, name, role, and readiness;
- multiple matches: add semantic scope, `filter()`, `locator()`, `and()`, or an intentional `nth()`;
- not visible, disabled, unstable, or not actionable: inspect overlays, current UI and whether the target is still moving; do not bypass the action boundary with DOM JavaScript;
- detached during action: re-resolve the Locator after the rerender.

Only use CSS when the page lacks a stable semantic identity. Only use evaluate/CDP when the desired operation is genuinely outside the typed surface.

## Observation failures

If atomic `both` capture returns `observation_consistency_error`, the document, frame topology, viewport, scroll, DPR, or layout identity changed during capture. Retry a fresh atomic capture after the page settles; do not combine an old AX state with a new screenshot.

If `complete` is false or `truncated` is true, narrow the question or request a larger/full observation. Do not infer absence from incomplete coverage.

## Resource failures

If a stream has `gap`, `complete === false`, `resource_transport_overflow`, or `resource_incomplete`, its history cannot prove that an event was absent. Dispose it, open a new observer before repeating the relevant trigger, and state when repeating the trigger itself would be consequential.

A timed-out waiter only says that no matching event was observed within its interval. Inspect `resource.events`, `resource.complete`, and the browser state before concluding the application failed.

## Escalation sequence

1. Preserve the structured error.
2. Refresh tab metadata and obtain a new bounded AX state.
3. Reconcile whether the intended side effect already occurred.
4. Load `browser.documentation("diagnostics")` for runtime-specific failures.
5. Use typed frame/resource inspection.
6. Use an explicit CDP session only for a remaining low-level fact.

Do not inspect `.d.ts` or implementation source to guess ordinary usage. A missing public operation is a product boundary to report, not an invitation to fabricate one.
