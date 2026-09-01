# OOPIF session registry and resource routing

## Origin

This scenario exercises a top document with both same-process and out-of-process iframe nesting in both directions. A full-suite run exposed a race where an OOPIF target and realm remained live but its `FrameState` disappeared: the parent session's delayed `Page.frameDetached(reason=swap)` removed a frame already owned by the new child session.

## Pressure and path

- root page → same-origin frame → OOPIF;
- root page → OOPIF → same-origin nested frame;
- target auto-attach and frame/realm discovery during navigation;
- frame-scoped Locator, AX, evaluate, and CDP calls;
- dynamic network, console, file chooser, and init-script resources across sessions;
- shared CDP domain leases and cleanup after a child session detaches.

## Invariants

- The registry exposes the root and all four child frames with the correct parent relationships.
- A frame detach event may remove only a frame currently owned by the same CDP session; a stale parent-session swap event cannot delete the child session's live frame.
- Frame, realm, Locator, AX ref, CDP, Resource, and init-script identities agree on their owning session and document.
- Closing or detaching a child session closes its resources without damaging the root target or sibling sessions.

The page is a deterministic local topology. The runtime fix uses existing session ownership; it does not special-case hostnames, frame URLs, or this fixture's labels.
