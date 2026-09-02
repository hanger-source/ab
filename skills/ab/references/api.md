# AB Agent and Core API

## Agent connection

```ts
import { connect } from "@hanger-source/ab/agent";

connect(options?: {
  timeoutMs?: number;
  signal?: AbortSignal;
  presenter?: Presenter;
}): Promise<Browser>

browser.identity
browser.connected
browser.diagnostics.snapshot({ traceId?, requestId? })
browser.diagnostics.onTrace(listener): () => void
browser.diagnostics.clear(): void
browser.disconnect(): Promise<void>
browser.documentation(topic?:
  | "core" | "bootstrap" | "tabs" | "observation" | "actions"
  | "screenshot" | "frames" | "evaluate" | "network"
  | "console-dialogs" | "downloads" | "init-scripts"
  | "resources" | "cdp" | "diagnostics"
): Promise<string>
```

`connect()` privately launches the matching native runtime only when the fixed Unix socket is unavailable. It never exposes daemon lifecycle commands. In a compatible managed Node REPL MCP host—Codex built-in or Qwen—the default Presenter emits bounded AX text and verified screenshot bytes as standard MCP content; in an ordinary Node process it writes text and screenshot artifact metadata to stdout. A host may inject another typed Presenter.

## Core connection

```ts
import { connect } from "@hanger-source/ab";

connect(options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<Browser>
```

Agent and Core use one transport and Rust runtime. `@hanger-source/ab/agent` is a typed facade, not a second browser implementation.

## Structured errors and traces

Every SDK request receives a request id and a separate correlation trace id. Runtime failures return an `ABError` with:

```ts
error.kind
error.stage
error.message
error.retryable
error.context // requestId, traceId, method, target, cdpMethod, cause
error.details
```

`retryable` only reports whether mechanically issuing the request again is safe; it never causes an automatic retry. In particular, `outcome_unknown` is not retryable because a side effect may already have happened.

```ts
const snapshot = browser.diagnostics.snapshot({ traceId: error.context?.traceId });
snapshot.events     // ordered dispatched/settled stages
snapshot.complete   // false if the bounded local history evicted events
snapshot.dropped
```

Trace stages contain identities, timing, method, target, status and error class, but never request params, cookies, authorization, form values, AX text or response bodies. `onTrace()` observes future stages; `clear()` only clears this SDK client's local history.

## Tabs

```ts
browser.tabs.list(options?)
browser.tabs.get(targetId, options?)
browser.tabs.acquire(targetId, options?)
browser.tabs.open(url?, { waitUntil?, timeoutMs?, signal? })

tab.refresh(options?)
tab.acquire(options?)
tab.goto(url, { waitUntil?, timeoutMs?, signal? })
tab.activate(options?)
tab.reload(options?)
tab.goBack(options?)
tab.goForward(options?)
tab.playwright.waitFor({ selector?, text?, state?: "attached" | "detached" | "visible" | "hidden", timeoutMs?, signal? })
tab.playwright.waitForURL(pattern, { timeoutMs?, signal? })
tab.playwright.waitForLoadState(state?: "domcontentloaded" | "load", { timeoutMs?, signal? })
tab.expectPopup(action, { timeoutMs?, signal? }) // Agent facade
tab.close(options?)
```

`Tab.id` is the Chrome target id and remains stable across navigation. `Tab.ownership` is `"available" | "owned" | "other"` relative to the current client. Discovery and read-only observation do not acquire a target. `tabs.open()` owns the created target; `tabs.acquire()`/`tab.acquire()` atomically claim an available existing target. Mutations require `owned` server-side and fail with `target_in_use` or `target_not_acquired` rather than switching targets. A task must not close a tab it did not create unless the user explicitly asked.

`Tab.active` is the activity snapshot captured when that `Tab` descriptor was returned; it is not a live selector and does not choose a later action target. `tab.activate()` only makes a tab visible. Pointer, keyboard, focus, and form-input actions already acquire the Rust Browser Owner's physical-input lease and activate the exact tab named by the call before dispatch.

## Agent AX observation and refs

```ts
tab.ax.get("state", options?): Promise<AXState>
tab.ax.get("screenshot", options?): Promise<Screenshot>
tab.ax.get("both", options?): Promise<PageObservation>

tab.ax.write("state", options?): Promise<AXState>
tab.ax.write("diff", options?): Promise<AXState>
tab.ax.write("screenshot", options?): Promise<Screenshot>
tab.ax.write("both", options?): Promise<{ state: AXState, screenshot: Screenshot }>

tab.ax.click(refId, options?)
tab.ax.doubleClick(refId, options?)
tab.ax.hover(refId, options?)
tab.ax.wheel(refId, deltaX, deltaY, options?)
tab.ax.fill(refId, value, options?)
tab.ax.type(refId, text, options?)
tab.ax.press(refId, key, options?)
tab.ax.focus(refId, options?)
tab.ax.clear(refId, options?)
tab.ax.check(refId, options?)
tab.ax.uncheck(refId, options?)
tab.ax.selectOption(refId, valueOrValues, options?)
tab.ax.setFiles(refId, pathOrPaths, options?)
tab.ax.dragTo(sourceRefId, targetRefId, options?)
tab.ax.scrollIntoView(refId, options?)
```

`get()` returns caller-owned typed data and never displays or changes the presented baseline. `write()` returns the exact typed object it presented; `write("state"|"diff"|"both")` advances the current Agent-session/tab baseline only after Presenter success, while `write("screenshot")` does not. `write("diff")` captures a new explicit state against the last presented state using the same capture shape. A short-ref action resolves that baseline locally, then sends explicit `observationId + refId` to Rust. No baseline means `agent_observation_required`; there is no server-global ref map or guessed replacement.

## Core AX state and refs

```ts
coreTab.ax.snapshot({
  mode?: "interactive" | "full",
  surface?: "active" | "document",
  frames?: "all" | { root: string },
  maxDepth?: number,
  maxChars?: number,
  diffFrom?: AXState | string,
  includeUrls?: boolean,
  timeoutMs?: number,
  signal?: AbortSignal,
})

state.text
state.refs()
state.ref("e7")
state.dispose(options?)

ref.click({ button?, clickCount?, observe?, observation?, timeoutMs?, signal? })
ref.doubleClick(options?)
ref.hover(options?)
ref.wheel(deltaX, deltaY, options?)
ref.fill(value, options?)
ref.type(text, { clear?, delayMs?, observe?, observation?, timeoutMs?, signal? })
ref.press(key, options?)
ref.focus(options?)
ref.clear(options?)
ref.check(options?)
ref.uncheck(options?)
ref.selectOption(valueOrValues, options?)
ref.setFiles(pathOrPaths, options?)
ref.dragTo(targetRef, options?)
ref.scrollIntoView(options?)
ref.textContent(options?)
ref.innerText(options?)
ref.getAttribute(name, options?)
ref.boundingBox(options?)
ref.isVisible(options?)
ref.isEnabled(options?)
ref.isChecked(options?)
ref.inputValue(options?)
ref.inspect({ attributes?, timeoutMs?, signal? })
ref.domInvoke(method, args?, options?)
ref.screenshot(options?)
```

Core has no implicit latest state or index action. `observe: "diff"` returns a new `AXState` in the action result. Refs never float to a newer document. Inspecting `AXState` in a Node.js REPL prints identity/completeness metadata only; read `state.text` explicitly or use Agent `write()` for model-visible content.

Every mutation surface accepts the same action observation contract:

```ts
type ActionOptions = {
  observe?: "diff" | "state" | "none";
  baseline?: AXState | string;
  observation?: {
    mode?: "interactive" | "full";
    surface?: "active" | "document";
    frames?: "all" | { root: string };
    maxDepth?: number;
    maxChars?: number;
    includeUrls?: boolean;
  };
};
```

When `observe:"diff"` is selected, Core callers pass an existing `baseline`; Rust captures only the post-action state and compares it to that explicit identity. `AXRef` supplies its owning observation automatically. When `observation` is omitted, the post-action capture inherits the baseline's exact shape; an explicitly conflicting shape is rejected before dispatch. `observe:"state"` captures only the post-action state. Both observation modes arm application-effect settlement before input dispatch. `observe:"none"` skips that settlement and capture while retaining action-owned navigation, dialog, and file-chooser reporting. `@hanger-source/ab/agent` actions always call Core with `observe:"none"`; post-action waits and observations are explicit Agent decisions. Core observation options remain available only through the Core entry point.

All AXRef, Locator, and ElementHandle mutations return the same `ActionResult`:

```ts
type ActionResult = {
  id: string;
  action: string;
  target: {
    source: "axRef" | "locator" | "elementHandle";
    targetId: string;
    sessionId: string;
    frameId: string;
    documentGeneration: string;
    backendNodeId: number;
    observationId?: string;
    refId?: string;
    elementId?: string;
  };
  dispatchMechanism: string;
  timing: { startedAtUnixMs: number; endedAtUnixMs: number; durationMs: number };
  navigation: { beforeUrl: string; afterUrl: string; changed: boolean };
  document: { beforeGeneration: string; afterGeneration: string; changed: boolean };
  dialog: { opened: boolean; dialog?: DialogInfo };
  pendingRelease: boolean;
  lastStage: string;
  data: unknown;
  observation: AXState | null;
};
```

The result reports action mechanics, not business success. File chooser identity and completeness belong to an explicit `FileChooserWatcher`, which must be created before the triggering action.

`textContent`, `innerText`, `getAttribute`, `boundingBox`, and `screenshot` are typed reads. `domInvoke` is an explicit mutation and returns `ActionResult<{ value?: T }>`; read its return value from `result.data.value`.

## Core atomic page observation

```ts
coreTab.observe({
  ax?: boolean | SnapshotOptions,
  screenshot?: boolean,
  fullPage?: boolean,
  scale?: "css" | "device",
  timeoutMs?: number,
  signal?: AbortSignal,
}): Promise<PageObservation>

view.state?: AXState
view.screenshot?: Screenshot
```

When AX and screenshot are both requested, Rust captures and validates them as one document/frame/viewport transaction. Agent `get/write("both")` uses this exact primitive; neither facade composes two calls client-side.

## Locators

`@hanger-source/ab/agent` returns `Locator` from every `tab.playwright` semantic builder. It has the same immutable composition and read methods as Core Locator. Agent mutations accept only mechanical action options; runtime JavaScript that passes `write`, `observe`, `baseline`, or `observation` fails before dispatch. Agent and Core `Locator.waitFor()` are pure waits and never present content. Use explicit page/Locator waits and `tab.ax.write("diff" | "state")` at the next model decision boundary.

```ts
tab.dev.mainFrame(options?)
tab.dev.frames(options?)

tab.playwright.locator(css)
tab.playwright.getByRole(role, { name?, exact? })
tab.playwright.getByText(text, { exact? })
tab.playwright.getByLabel(label, { exact? })
tab.playwright.getByPlaceholder(text, { exact? })
tab.playwright.getByAltText(text, { exact? })
tab.playwright.getByTitle(text, { exact? })
tab.playwright.getByTestId(value)

frame.locator(css)
frame.getByRole(role, { name?, exact? })
frame.getByText(text, { exact? })
frame.getByLabel(label, { exact? })
frame.getByPlaceholder(text, { exact? })
frame.getByAltText(text, { exact? })
frame.getByTitle(text, { exact? })
frame.getByTestId(value)

locator.filter({ has?, hasText?, exact?, visible? })
locator.locator(cssOrLocator)
locator.and(other).or(other).inFrame(frameId)
locator.nth(index).first().last()
locator.count(options?)
locator.all(options?)
locator.waitFor({
  state?: "attached" | "detached" | "visible" | "hidden",
  timeoutMs?,
  signal?,
})
locator.elementHandle(options?)
locator.click(options?)
locator.doubleClick(options?)
locator.hover(options?)
locator.wheel(deltaX, deltaY, options?)
locator.dragTo(targetLocator, options?)
locator.focus(options?)
locator.scrollIntoView(options?)
locator.fill(value, options?)
locator.type(text, options?)
locator.fillAndSelectSuggestion(query, suggestionText, { expectedValue?, exact?, suggestionExact?, timeoutMs?, signal? })
locator.press(key, options?)
locator.check(options?)
locator.uncheck(options?)
locator.clear(options?)
locator.selectOption(valueOrValues, options?)
locator.setFiles(pathOrPaths, options?)
locator.textContent(options?)
locator.innerText(options?)
locator.getAttribute(name, options?)
locator.boundingBox(options?)
locator.isVisible(options?)
locator.isEnabled(options?)
locator.isChecked(options?)
locator.inputValue(options?)
locator.inspect({ attributes?, timeoutMs?, signal? })
locator.domInvoke(method, args?, options?)
locator.screenshot(options?)
```

Locators are immutable query objects. A builder call does not touch the browser.

`fill()` and `type()` return `ActionResult<TextInputActionData>`. Its `data.field` contains `requestedText`, settled `inputValue`, `matchesRequestedText`, `popupBacked`, `signals`, and `next: "selectSuggestion" | "none"`. `matchesRequestedText` is `boolean` for replacement input and `null` for append typing. The same typed data is returned by Locator, AXRef, and ElementHandle input actions.

`fillAndSelectSuggestion()` returns `{ input, selection, suggestion, committedValue }`. It resolves `suggestionText` only among actionable refs newly introduced after the fill; `suggestion` preserves the chosen observation/ref/role/name identity. Core Locator keeps explicit `observe`; Agent Locator performs the composed operation without presenting an observation.

## Element handles

```ts
const element = await locator.elementHandle(options?);
const sameElement = await state.ref("e7").elementHandle(options?);

element.click(options?)
element.doubleClick(options?)
element.hover(options?)
element.wheel(deltaX, deltaY, options?)
element.dragTo(targetElement, options?)
element.focus(options?)
element.scrollIntoView(options?)
element.fill(value, options?)
element.type(text, options?)
element.press(key, options?)
element.check(options?)
element.uncheck(options?)
element.selectOption(valueOrValues, options?)
element.setFiles(pathOrPaths, options?)
element.textContent(options?)
element.innerText(options?)
element.getAttribute(name, options?)
element.boundingBox(options?)
element.isVisible(options?)
element.isEnabled(options?)
element.isChecked(options?)
element.inputValue(options?)
element.inspect({ attributes?, timeoutMs?, signal? })
element.domInvoke(method, args?, options?)
element.screenshot(options?)
element.dispose(options?)
```

An `ElementHandle` is server-owned and bound to one frame, document generation, and backend node. It never semantically relocates itself.

`inspect()` returns one `ElementInspection`: `tagName`, `roleAttribute`, `inputType`, requested `attributes`, `textContent`, `innerText`, `value`, `visible`, `enabled`, nullable `checked`, `readOnly`, `contentEditable`, and `bounds`. Locator resolves once for the whole inspection; AXRef and ElementHandle retain their existing exact-node identity.

## Artifacts, screenshots, and CUA

```ts
artifact.id
artifact.path
artifact.sha256
artifact.bytes
artifact.mediaType
artifact.encoding
artifact.createdAtUnixMs
artifact.expiresAtUnixMs
await artifact.read()    // reads the private file and verifies byte length + SHA-256
await artifact.dispose() // releases the server-owned artifact and removes its private file

const shot = await tab.screenshot({ fullPage?, scale?: "css" | "device", timeoutMs?, signal? });
shot.id         // server-owned artifact id
shot.path       // verified local PNG artifact path
shot.scale      // "css" or "device"
shot.cssViewport // { width, height, pageX, pageY, deviceScaleFactor }
shot.sha256     // expected digest checked by read()
shot.bytes      // expected byte length checked by read()
shot.artifact   // id/path/sha256/bytes/mediaType/encoding/createdAtUnixMs/expiresAtUnixMs
await shot.read() // verifies byte length and SHA-256
await shot.dispose() // releases the server-owned artifact and removes its private file
shot.viewportId
shot.width
shot.height

tab.cua.click({ x, y, viewportId, button?, clickCount?, timeoutMs?, signal? }): Promise<ActionResult<CuaActionData>>
tab.cua.move({ x, y, viewportId, timeoutMs?, signal? }): Promise<ActionResult<CuaActionData>>
tab.cua.wheel({ x, y, viewportId, deltaX?, deltaY?, timeoutMs?, signal? }): Promise<ActionResult<CuaActionData>>
tab.cua.drag({ from: { x, y }, to: { x, y }, viewportId, timeoutMs?, signal? }): Promise<ActionResult<CuaActionData>>
```

`Artifact` is the single SDK handle returned for server-owned screenshot, large network-body, and completed-download bytes. `Screenshot` extends it with exact viewport identity. Agent code normally uses `tab.ax.write("screenshot"|"both")` when pixels must be shown to the model, and `tab.ax.get("screenshot")` when code only needs the typed screenshot object. Coordinates always use the returned screenshot's exact `viewportId`.

## Frames, realms, evaluate, and CDP

```ts
tab.dev.frames(options?): Promise<Frame[]>
tab.dev.realms(options?): Promise<Realm[]>
tab.dev.evaluate(fn, ...args)

frame.evaluate(fn, ...args)
realm.evaluate(fn, ...args)

const cdp = await tab.dev.cdp();
await cdp.send(method, params?, options?);
await cdp.dispose(options?);
```

`Realm` retains `id`, `sessionId`, `executionContextId`, and `frameId` as one captured identity. `realm.evaluate()` hard-fails with `stale_realm` when that identity no longer resolves; execution-context ids are not globally unique across CDP sessions.

There is no generic engine-command escape hatch. Use typed AB operations; use an explicit `CDPSession` only for browser-protocol diagnostics or a primitive that AB has not promoted. Agent `tab.dev.cdp()` binds the root session; Core `tab.cdp()` and `frame.cdp()` retain their explicit flat API. CDP sessions and their domain leases are released by `dispose()`, client disconnect, or target close.

## Resources and init scripts

```ts
tab.resources.network({
  bodyRetentionBytes?,
  bodyMemoryBytes?,
  maxBodyBytes?,
  cdpBufferBytes?,
  bodyStorage?: "auto" | "artifact",
  bodyCapture?: "all" | "text",
  timeoutMs?,
  signal?,
}?): Promise<NetworkObserver>
tab.resources.console(options?): Promise<ConsoleObserver>
tab.resources.dialogs(options?): Promise<DialogWatcher>
tab.resources.downloads(options?): Promise<DownloadWatcher>
tab.resources.fileChoosers(options?): Promise<FileChooserWatcher>
tab.resources.popups(options?): Promise<PopupWatcher>

tab.resources.initScripts({
  name: string,
  source: string,
  world?: "main" | "isolated",
  frames?: "all" | "top",
  args?: JsonValue[],
}, options?): Promise<InitScriptRegistration>

registration.instances(options?): Promise<InitScriptInstance[]>
registration.waitForInstance(predicate?, options?): Promise<InitScriptInstance>
registration.send(instanceOrId, name, value?, options?)
registration.waitFor(predicate, options?)
registration.refresh(options?)
registration.assertComplete(options?)
registration.dispose(options?)

popupWatcher.waitForPopup(options?): Promise<PopupInfo>
popupWatcher.refresh(options?)
popupWatcher.assertComplete(options?)
popupWatcher.dispose(options?)
```

`PopupInfo` contains `targetId`, exact `openerId`, URL, title, and target type. Create the watcher before the triggering action; the Agent `tab.expectPopup(action)` method performs that ordering and resolves the ready child `Tab`.

Every resource is owned by the current SDK client and buffered in Rust with sequence and completeness state. An init-script instance is scoped to one `sessionId + executionContextId + documentGeneration`; commands never retarget an old instance after navigation or frame detach.

Core callers use the corresponding flat methods `coreTab.observeNetwork()`, `observeConsole()`, `watchDialogs()`, `watchPopups()`, `watchDownloads()`, `watchFileChoosers()`, and `addInitScript()`. Agent namespaces change discoverability, not Rust resource ownership or behavior.
