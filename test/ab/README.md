# AB live integration suite

These files are standalone real-Chrome processes, not `bun test` unit files. Run the default suite with:

```bash
bun run test:ab
```

The runner gives every case a separate runtime socket and data/profile directory, packages no fake browser, stops after the first failed boundary, and reports the retained temporary root for diagnosis.

Those isolated cases run Chrome headless by default. The installed Agent Skill does not set `AB_HEADLESS` and still owns a visible persistent-profile Chrome. A case that tests native-window behavior declares `headless: false`; the dialog lifecycle case already does so.

The default suite covers daemon/profile reuse, Node package and installed Skill client, profile locking, same-process frames and OOPIFs, dynamic Resource sessions, CDP session/domain ownership, observation/action identity, Locator semantics, cancellation, cross-tab scheduling, multi-tab HAR capture, and every retained complex scenario under `scenarios/`.

`scenarios/` is additive regression memory for distinct real Agent interaction shapes. Each scenario has its own fixture, runtime case, origin, pressure dimensions, and implementation-independent invariants; see `scenarios/README.md`.

Two cases are intentionally explicit rather than hidden inside the default green run:

```bash
bun test/ab/live-suite.ts --case dialog
bun test/ab/live-suite.ts --case version-handover
```

`dialog` remains a known headed-Chrome modal lifecycle failure: the existing reproduction can stop at the native modal. The runner terminates it after 15 seconds and reports failure; it must not be described as passed or allowed to block unrelated cases indefinitely.

`version-handover` requires `AB_OLD_RUNTIME_BINARY` and `AB_OLD_BUILD_ID` so it can prove an actual old-to-current handover. A second copy of the current binary is not valid evidence.

Passing this suite is runtime evidence only. It does not replace MiniWoB++, WebArena-Verified Hard, VisualWebArena, or the final unfamiliar-Agent-only-Skill acceptance.
