# Background-tab popup pointer action

## Browser boundary

This scenario combines three independently owned browser facts without asking
one implementation to infer the others: Chrome throttles page-owned animation
clocks in a background source tab, a trusted click activates a native
`target="_blank"` link, and browser auto-attach pauses the new target until
session initialization resumes it.

The reusable boundary was confirmed on a public GitHub issue and is recorded in
`docs/evidence/20260902__action-resource-ownership__@codex.md`. This local page
does not preserve any account, site URL, label, or business workflow.

## Pressure dimensions

- The semantic source anchor is in a real background tab.
- A bounded page probe proves that the hidden document's
  `requestAnimationFrame` does not run, rather than merely assuming the tab is
  inactive.
- BrowserOwner acquires the one headed input surface and activates the explicit
  source target; the action still performs visibility, stability, content-quad,
  and hit-target checks before one trusted pointer dispatch.
- Native `target="_blank"` activation creates a cross-origin child while
  browser-level auto-attach pauses that target at startup.
- The source action requests no post-action observation; child initialization
  proceeds independently through SessionManager.

## Invariants

- Pointer stability is owned by Rust/CDP timing and does not wait for a page rAF.
- The source is hidden when the caller starts the action; BrowserOwner makes
  that exact target the active input surface, and the action completes inside
  the caller's five-second deadline.
- A normal action does not acquire file chooser interception. Chooser identity
  is covered separately by the explicit watcher resource scenario.
- The application receives exactly one trusted activation; the runtime never
  replays the click to manufacture success.
- The child target is published only after it has a navigated URL and readable
  AX heading.
- The profile endpoint is requested exactly once.

The five-second deadline is a regression boundary for a deterministic
pre-dispatch owner stall, not a general page-performance promise. This is an
integration pressure case: pointer, Resource, popup, and observation behavior
remain verified by their own owner-specific scenarios.
