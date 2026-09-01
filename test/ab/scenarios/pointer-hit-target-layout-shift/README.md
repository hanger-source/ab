# Pointer hit target after layout shift

## Origin

The WebArena Magento review list exposed a real pointer race. A semantic `Edit`
link resolved to the correct backend node and click point, but moving the mouse
over the row changed its layout before `mousePressed`. AB reported a completed
CDP click even though the trusted button events landed on the surrounding table
cell. Repeating the action from a fresh observation then succeeded.

The same flow was repeated through Codex Browser's Playwright-backed locator
surface in three fresh tabs. Each first click activated the link. The comparison
isolated the difference to click-time hit-target handling rather than locator
resolution, AX identity, or site-specific selectors.

## Pressure dimensions

- The target is a real semantic anchor resolved by role and accessible name.
- A trusted `mousemove` reaches the target, then a page listener moves the
  target before the button events are dispatched.
- The original click point remains inside a non-actionable ancestor, so an
  implementation that treats `mousemove` as proof for the whole click silently
  reports success without activation.
- A safe retry is possible only when the mismatched button event is intercepted
  before it reaches page handlers.

## Invariants

- Click hit-target validation is driven by mouse/pointer button events, not by
  the preceding hover move.
- A button event that no longer targets the intended element is blocked before
  page code receives it.
- Pointer preparation may then resolve the same browser identity again and
  retry without replaying a side effect.
- The public action resolves only after one trusted anchor activation occurred.

This local page is a deterministic reduction of the browser input boundary. It
does not replace the official WebArena evaluator; it preserves the exact race
that the official complex page revealed.
