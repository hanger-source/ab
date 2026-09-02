# Explicit page wait boundaries

## Origin

Agent actions, page waits, and observations are separate public responsibilities. `waitForURL()` observes a readable URL postcondition. `waitForLoadState()` observes the lifecycle of the document current when the request reaches the Runtime; it does not anticipate a later navigation or imply application/business completion.

This scenario protects that boundary directly instead of encoding timing from a public website. The local server withholds a parser-blocking script for a newly navigated document. Navigation is requested with `waitUntil: "none"`, the destination URL becomes observable, and `DOMContentLoaded` must remain pending until the server releases the script.

## Invariants

- `navigate(..., { waitUntil: "none" })` can return before the new document reaches `DOMContentLoaded`.
- `waitForURL()` reads the destination URL independently of document readiness.
- `waitForLoadState("domcontentloaded")` does not resolve while the current document is parser-blocked.
- Releasing the blocking resource allows the same wait to resolve and exposes the completed document.
- No arbitrary sleep, site-specific helper, repeated navigation, or raw CDP is used to manufacture the result.

The scenario deliberately does not introduce `expectNavigation(action)`. Event-safe action/navigation composition is a separate contract and must not be approximated by an after-the-fact waiter.
