# Asynchronous SPA navigation transaction

## Origin

A real public SPA exposed a three-way disagreement after a semantic link click: the browser had already changed its target URL, the Agent-facing tab list saw the destination, but `ActionResult.navigation` still read the previous frame URL and the post-action observation could be captured before the destination rendered. The same class of failure appears whenever a client-side router begins work from a trusted pointer event, fetches route data, then commits a same-document URL and view.

## Pressure dimensions

- The link is a real semantic anchor and must be activated through trusted CDP pointer input.
- Application code prevents default navigation, starts an asynchronous fetch, and commits with `history.pushState` only after the response.
- The root document generation remains unchanged, so navigation cannot be inferred from document replacement.
- Target URL, frame registry, event receiver, and post-action AX capture are separate runtime facts that must be ordered by one action transaction.

## Invariants

- Pointer preparation may retry, but the event stream used to classify effects begins at the one actual input dispatch and contains no preparation-time traffic.
- The action transaction observes the asynchronous same-document commit without a site-specific sleep or a second input dispatch.
- `ActionResult.navigation.afterUrl`, `browser.tabs.get().url`, and the returned observation describe the same destination state.
- Same-document navigation changes URL but not document generation.
- The returned observation contains the destination content rather than the route-loading intermediate state.

The local page is a deterministic reduction of the browser lifecycle boundary. It is not a benchmark and does not claim that arbitrary timers or application business work are globally complete; callers still wait for the explicit business fact they need.
