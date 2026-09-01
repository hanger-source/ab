# Paused popup target initialization

## Origin

On the signed-in Xiaohongshu note detail page, the author name is an ordinary
semantic anchor with `target="_blank"`. A fresh AB AX ref dispatched one trusted
pointer click, but the action consumed the full 30-second request deadline. The
source-page observation then failed and Chrome retained a page target whose URL
and title were both empty. AB never published that child through `tabs.list()`.

The daemon had auto-attached the new page with
`waitForDebuggerOnStart: true`. Its session was removed without ever reaching
`attach ready`. Page initialization awaited domain setup and debugger resume as
separate serial phases, so a paused target could block the opener's click before
the resume command was issued or acknowledged.

This local page is a deterministic reduction of that browser target lifecycle.
It does not stand in for the Xiaohongshu workflow; the authenticated page is the
origin evidence, while this scenario keeps the independently reproducible CDP
boundary in the suite.

## Pressure dimensions

- A trusted click reaches an ordinary author link and its handler opens a real
  top-level page with `window.open`, matching the child-target boundary observed
  on the authenticated application.
- Browser-level auto-attach pauses the new target before its first navigation.
- Page, Runtime, and Network domains must be initialized without preventing the
  matching `Runtime.runIfWaitingForDebugger` command.
- The source action requests a post-dispatch AX state while the child target is
  initializing; the child lifecycle must not consume that observation budget.

## Invariants

- Domain initialization and debugger resume form one target-registration batch.
- The click dispatch and source observation complete within the caller's five
  second deadline.
- The child is published only after it is usable and exposes its navigated URL
  and AX heading.
- Exactly one profile request proves the fix does not replay the click.
