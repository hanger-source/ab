# Frames and realms

`tab.dev.frames()` exposes stable frame slots with target, parent, URL, owning CDP session, and current document generation. Cross-origin OOPIFs keep their own flattened CDP session; AB does not collapse their request, execution-context, or event identity into the top frame.

`tab.dev.realms()` exposes execution contexts with session, frame, origin, name, default/isolated kind, and document ownership. `frame.evaluate()` selects the current default realm for that exact frame. `realm.evaluate()` stays bound to the selected `realmId + sessionId + executionContextId + frameId` identity and becomes stale when that context is destroyed. An execution-context id is only unique inside its CDP session; AB never searches for it globally or falls back to the top frame.

Observation refs and init-script instances carry frame/document/session identity. Backend node ids are meaningful only together with their owning CDP session and document.

## Inspect topology before scoping

```js
await browser.documentation("frames");
const main = await tab.dev.mainFrame();
const frames = await tab.dev.frames();
frames.map(frame => ({
  id: frame.id,
  parentId: frame.parentId,
  url: frame.url,
  name: frame.name,
  sessionId: frame.sessionId,
  documentGeneration: frame.documentGeneration,
}));
```

Frame array order is not hierarchy or stability. Use `parentId` to construct topology and select a frame from current URL/name/parent facts. A frame id is a browser identity, not an array index.

## Scope a Locator

```js
const checkout = frames.find(frame => frame.url.startsWith("https://payments.example/"));
if (!checkout) throw new Error("checkout frame is not present");
await checkout.getByLabel("Card number").fill("…");
```

`tab.playwright.locator()` and `tab.playwright.getBy*()` query only the main frame. Use `frame.locator()` / `frame.getBy*()` or the equivalent explicit `inFrame(frame.id)` plan to enter a child frame. AB never guesses across frames. Do not start by evaluating `iframe.contentDocument`; it fails for cross-origin frames and erases CDP session identity.

## Frame evaluation

`frame.evaluate()` resolves the current default JavaScript realm for the exact captured frame and document generation:

```js
const heading = await checkout.evaluate(() => document.title);
```

If the frame navigated, the captured `Frame` is stale. Call `tab.dev.frames()` again and deliberately select the replacement.

## Realm evaluation

Use realms when the exact execution context matters:

```js
const realms = await tab.dev.realms();
const isolated = realms.find(realm => realm.frameId === checkout.id && !realm.isDefault);
if (isolated) {
  const value = await isolated.evaluate(() => globalThis.someInstrumentationValue);
}
```

A realm is intentionally narrower than a frame. It is destroyed on navigation or execution-context replacement. AB must not silently map an old realm object to a new context with a similar name.

## OOPIF identity rules

Cross-origin iframes may run in separate Chrome targets and CDP sessions. Therefore:

- pair backend node ids with the owning session and document;
- pair execution-context ids with the owning session and frame;
- pair Network request ids with `sessionId`;
- do not send a child-session primitive through a root `tab.dev.cdp()` and assume equivalence;
- treat frame topology changes during atomic observation as consistency failure;
- re-enumerate after navigation, process swap, or dynamic iframe replacement.

An AX state can contain refs from multiple frames, but each ref still carries its own frame/document/session route.
