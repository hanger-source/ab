# Animated surface dismissal

## Origin

Some component libraries keep a dialog and its accessible subtree mounted while a finite CSS exit animation runs. Input dispatch has already succeeded, but an observation captured in the same task sees the departing dialog rather than the document that becomes actionable a few frames later. On an unfamiliar application this makes the Agent reuse stale refs or repeat an action that already succeeded.

## Invariants

- A mutation that requests a post-action observation waits for finite rendering transitions and DOM mutation quietness within a bounded runtime window.
- Dismissing an animated active surface returns the actionable document state, not the still-mounted exit frame.
- The action transaction owns this observation; callers do not need a second snapshot or a site-specific delay.
- Surface replacement identity and diff semantics remain intact when the active dialog returns to the document.
- Actions with `observe: "none"` do not pay the observation-settle cost.

The deterministic page reduces the interaction shape without retaining the private application URL, labels, credentials, or component selectors. It does not claim that arbitrary application background work or infinite animations become globally idle.
