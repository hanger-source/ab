# Explicit CDP sessions

Use `await tab.cdp()` only to inspect a browser-protocol fact or invoke a primitive that AB has not promoted to a typed API. `send(method, params)` targets the tab's current root session; dispose the session when finished.

Do not rebuild normal AX capture, Locator resolution, actionability, input, navigation, downloads, or resource observation from ad-hoc CDP calls. Those AB surfaces carry document, frame, session, artifact, cancellation, and ownership rules that a raw command does not reproduce.

For OOPIF-sensitive diagnostics, first inspect `tab.frames()` and `tab.realms()`. Never assume a backend node id, request id, or execution context id is globally unique across sessions.

## Session use

```js
await agent.documentation("cdp");
const cdp = await tab.cdp();
try {
  await cdp.send("Performance.enable");
  const metrics = await cdp.send("Performance.getMetrics");
  metrics;
} finally {
  await cdp.dispose();
}
```

`CDPSession` is a server-owned, client-owned Resource, not a second transport or browser owner. `dispose()` releases that exact session and every CDP domain it acquired; client disconnect and target close perform the same cleanup.

`Domain.enable` and `Domain.disable` are not sent around the runtime. AB routes them through the same session + domain lease manager used by typed observers. Two CDPSessions can share a domain without one session disabling it for the other, and disposing a raw session cannot disable a domain still owned by a typed Resource. Enable parameters apply when the first owner enables the domain.

Use protocol method names and parameters from the Chrome version actually launched by AB. Do not assume a Playwright or Selenium compatibility layer.

## Root and child sessions

`tab.cdp()` targets the current root session. `frame.cdp()` targets the Chrome target that owns that captured frame. A cross-origin frame can have a different target/session; enumerate frames first and choose explicitly.

Do not pass a backend node id, execution context id, request id, or loader id between sessions without its owning identity. Identical numeric/string ids can exist in different CDP sessions.

## Good low-level uses

- inspect performance, security, layout, or protocol state not exposed by Core;
- invoke a bounded browser primitive with no typed AB API;
- collect evidence for an AB runtime defect;
- compare a typed result against the underlying browser fact.

## Uses that remain typed

Do not implement ordinary click/fill/keyboard, AX trees, screenshots, navigation waiting, file upload, downloads, dialogs, network body ownership, init-script binding, or frame discovery with ad hoc CDP. The typed surfaces preserve ownership, cancellation, artifact verification, actionability, and multi-session routing.

If a CDP experiment proves a generally useful primitive, promote it into the protocol/runtime/SDK rather than leaving repeated raw commands in Agent task code.

CDP event subscription is not exposed by `CDPSession`; use typed resources for supported event streams. Do not poll a protocol method in a tight loop to imitate one.
