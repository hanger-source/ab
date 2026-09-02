# Agent action routing

## Pick the identity model before acting

| Surface | Use when | Identity |
|---|---|---|
| AX ref | The Agent just saw the target in an explicit observation | observation + ref + document + node |
| Locator | Stable semantic intent should resolve at action time | immutable query + target/frame scope |
| ElementHandle | Several operations must remain on one concrete node | server element id + frame/document/node |
| CUA | The useful target is visual or canvas-based | screenshot viewport + coordinates |
| evaluate | A page JavaScript fact is needed | selected tab/frame/realm |
| CDP | Diagnosing protocol state or using an unpromoted primitive | explicit target session |

These are not an automatic fallback chain. If an operation fails, state what identity or capability was missing before choosing another surface.

## Locator mechanics

Prefer semantic constructors. CSS is for pages without a stable semantic identity. Locator builders are immutable and do not query until a terminal operation.

Single-target operations are strict. Zero matches can be retried inside the deadline while the exact document remains valid. Multiple matches are an error unless the caller uses `nth/first/last`, `all()`, or `count()` deliberately. Locator action retry may re-resolve before dispatch. A semantic pointer attempt may be retried only when the capture-phase hit-target gate proved that its trusted button event reached the wrong node and blocked the entire event before application handlers; an attempt that reached the intended target is never replayed.

## Bound-node mechanics

AX refs and ElementHandles never relocate. Rust can recheck attachment, visibility, stability, geometry, hit target, and scroll state for the same node. Navigation or frame/document replacement returns stale rather than resolving a similar element.

## Active input surface

The tab in every action call is still explicit; AB never silently substitutes whichever tab happens to be selected. For pointer, keyboard, focus, and form-input operations, the Rust Browser Owner serializes access to headed Chrome's single reliable physical-input surface and activates that exact target immediately before dispatch. This makes an Agent action on a background tab behave like an action on the page it deliberately selected, while reads, observations, resource streams, popup discovery, navigation, uploads, DOM invocation, and DOM-only selection remain independently scheduled by target.

Activation is an action-scoped rendering/input responsibility, not evidence that the action's business result succeeded. The clicked page may itself navigate, open a popup, or lose focus; verify the resulting browser/application fact normally.

## After the action

Agent actions dispatch input and return action-owned facts. They do not capture or present AX state. Choose the next fact explicitly:

- use `tab.playwright.waitForURL()` or `waitForLoadState()` for browser lifecycle facts;
- use a Locator `waitFor()` or page-level `waitFor()` for a rendered element/text condition;
- inspect `result.targetChanges` for root-page targets opened or closed during the action; Agent mode presents non-empty changes automatically without switching tabs;
- prepare a Resource before the action when popup absence must fail, or for download, file chooser, dialog, network, or console events whose full lifecycle can be missed;
- use `tab.ax.write("diff")` when the next decision needs the semantic change since the last presented state, or `write("state")` when it needs complete current context.

`write("diff")` performs a new explicit observation against the last successfully presented state and inherits that state's exact capture shape. It is not part of the preceding mutation. A different mode, surface, frame scope, depth, character budget, or URL policy does not form a meaningful diff and is rejected. A timeout before input dispatch is retryable; a cancellation or transport loss after dispatch can return `outcome_unknown`, which must be inspected before any retry.

Core callers may still explicitly request `observe: "diff" | "state"`. A Core Locator, ElementHandle, or CUA caller using `observe: "diff"` must pass a same-tab `baseline`; an `AXRef` already owns its observation identity. This is a deliberate library-level action-and-observation transaction, not the Agent default. It uses bounded effect/render settlement before capture but still does not promise arbitrary timer, persistent polling, remote autocomplete, or business completion.

Do not use evaluate to bypass actionability or stale identity. Do not reuse CUA coordinates after navigation, scroll, resize, or DPR change.

AX refs, Locators, ElementHandles, and CUA return the same Rust-produced `ActionResult` for mutations:

```js
const baseline = await coreTab.ax.snapshot({ mode: "full", surface: "active" });
const result = await coreTab.getByRole("button", { name: "Save" }).click({
  observe: "diff",
  baseline,
});
result.target             // exact browser identity plus backend node or viewport coordinates
result.dispatchMechanism  // actual CDP pointer, keyboard, form, file-input, or DOM path
result.timing             // start, end, duration
result.navigation         // before/after URL and whether it changed
result.document           // before/after document generation and whether it changed
result.dialog             // pre-armed dialog fact and identity
result.targetChanges      // published root-page targets opened or closed during this action
result.observationOutcome // completed, skippedDialog, failed, or notRequested
result.lastStage
result.observation        // AXState when observe:"diff" or observe:"state" completed safely
```

`targetChanges.opened` carries immutable target id, exact opener id, URL/title metadata, and ownership after BrowserOwner has applied child-lease inheritance. `targetChanges.closed` carries exact root target ids. SessionManager remains the lifecycle owner; ActionTransaction only correlates these finite facts with the action. Agent presentation emits `AB_BROWSER_CHANGE` when either collection is non-empty, but never adopts the child as an implicit current tab. Target publication means its root CDP session is initialized and addressable; it does not imply the page `load` event or a stable application document. Resolve the child, wait for the exact lifecycle fact needed, then observe it.

`ActionResult` proves which browser mechanism ran and what browser facts were observed around it. It never proves that a save, purchase, deletion, login, or other business outcome succeeded. Verify that outcome from the rendered application state or an explicitly prepared resource.

Input dispatch and optional Core post-action observation remain separate outcomes inside `ActionResult`. Once dispatch completed, a failed Core observation does not erase the action facts or turn the mutation into an unknown dispatch. In Agent mode, `observationOutcome.status` is normally `notRequested` because every AX-ref, Locator, composite form, and CUA mutation sends `observe: "none"` to Core. Agent action options reject `write`, `observe`, `baseline`, and `observation` before dispatch so old composite semantics cannot be selected accidentally.

Agent and Core `Locator.waitFor()` are pure waits. They prove only their requested attached/detached/visible/hidden condition and never present or advance AX state.

## AX short refs versus explicit refs

Agent short refs are available only after the Presenter successfully displays `write("state")` or `write("both")` on that exact wrapped tab:

```js
await tab.ax.write("state");
await tab.ax.fill("e3", "Ada");
await tab.ax.click("e8");
await tab.ax.write("diff");
```

Actions preserve the current short-ref baseline but do not claim it still describes the page. `write("diff")` takes and presents one new observation against that baseline, then adopts the new observation. Use it only when a delta answers the next decision; use `write("state")` for complete current context. An `interactive` baseline deliberately excludes ordinary static text, so its inherited diff cannot prove a newly rendered paragraph, total, or confirmation message. AB never silently switches capture modes.

`get("state")` returns an `AXState` without presenting it. Use its bound refs directly:

```js
const state = await tab.ax.get("state");
try {
  const submit = state.ref("e8");
  await submit.click({ observe: "diff" });
} finally {
  await state.dispose();
}
```

Do not pass a ref id obtained from `get()` to `tab.ax.click()`: it was never established as the Agent's presented baseline.

## Semantic Locator composition

Use the strongest stable identity exposed by the page:

```js
const dialog = tab.playwright.getByRole("dialog").filter({ visible: true });
const save = dialog.locator(tab.playwright.getByRole("button", { name: "Save", exact: true }));
const matchingCard = tab.playwright.locator("article").filter({
  has: tab.playwright.getByRole("heading", { name: "Quarterly report", exact: true }),
  hasText: "Ready",
  visible: true,
});
```

`filter`, `locator`, `and`, `or`, and `inFrame` build an immutable query plan. `nth()` is an intentional disambiguation, not a cure for an under-specified query. Before using it, prefer adding role/name, ancestor, frame, `has`, or `hasText` scope.

Use `count()` or `all()` when multiple results are the intended output. Reads and actions that require one element are strict.

When a single-target operation throws `strict_violation`, read the printed `error.details.candidates` before capturing unrelated page state. Candidate summaries are bounded and include the exact `nth()` index, frame, role/name/text, visibility and bounded DOM attributes. Prefer a semantic, ancestor, frame, `has`, `hasText`, or visibility refinement. When the page intentionally offers multiple equivalent valid targets, verify the candidates with `all()`/`inspect()` and use the observed index deliberately.

Typed readiness and state reads are available on Locator, AXRef, and ElementHandle: `inspect({ attributes? })`, `isVisible()`, `isEnabled()`, `isChecked()`, and `inputValue()`. `inspect()` batches the element's DOM/interaction facts in one Rust/CDP read; Locator additionally has `waitFor({ state })`. Use these instead of page JavaScript when the question is an element's mechanical UI state.

`fill()` and `type()` return typed `data.field`: the requested text, settled `inputValue`, `matchesRequestedText`, `popupBacked`, detection `signals`, and `next`. Rust reads the live node after dispatch. `matchesRequestedText` is an exact boolean for `fill()` and `type(..., { clear: true })`, and `null` for append typing. Agent presentation emits a trusted warning when a control truncates or normalizes replacement text; inspect `inputValue` before submitting. When `next === "selectSuggestion"`, wait for the popup fact and explicitly observe it before choosing a suggestion. A pre-action `aria-autocomplete: null` does not override this runtime outcome.

`field.fillAndSelectSuggestion(query, suggestionText, { expectedValue, exact?, suggestionExact? })` composes that protocol when the expected suggestion text is known. It captures an internal AX revision boundary, fills without presentation, finds the matching newly introduced actionable ref, clicks that exact ref, reads the field again, and fails if selection is ambiguous or the committed value does not match. This does not require the widget to expose `role="option"`; Agent mode returns the selection identity and committed value without presenting AX state.

## Action choice

- `fill(value)`: replace a form control value.
- `fillAndSelectSuggestion(query, suggestionText, { expectedValue, exact, suggestionExact })`: popup-backed fill, AX-revision suggestion selection, and committed-value verification.
- `type(text, { delayMs, clear })`: emit keyboard input for per-key behavior.
- `press(key)`: keyboard command such as `Enter`, `Escape`, or `Control+A`.
- `check()` / `uncheck()`: express desired checkbox state rather than toggling blindly.
- `selectOption(values)`: native select values.
- `setFiles(paths)`: addressable file input with verified absolute paths.
- `scrollIntoView()`: bring the same semantic node into view.
- `wheel(dx, dy)`: wheel relative to a bound semantic target.
- `dragTo(target)`: source and target identities from the same tab/client.
- `domInvoke(method, args)`: explicit DOM method invocation; it remains a mutation and returns `ActionResult`, never a hidden fallback for pointer actions.

Pure reads (`textContent`, `innerText`, `getAttribute`, `boundingBox`) and element screenshots return their typed values directly. Every mutation, including `domInvoke`, returns `ActionResult` on all three semantic target surfaces.

Clicking, typing, uploading, and dragging can have side effects. Announce the visible operation and verify its resulting application state.

## Element handles

Create an `ElementHandle` only when several operations must remain bound to the exact concrete node, for example reading attributes and then interacting with the same canvas element. A Locator normally better expresses a repeated workflow because it resolves against current state.

Dispose handles promptly. A handle becoming stale is a useful hard failure; never turn it into implicit relocation.

## Mechanical retry boundary

Rust may wait for and recheck the same intended target before dispatch. It may re-resolve a Locator while the document identity remains applicable. For semantic pointer input, visible/enabled/stable geometry, scroll, current content quad and event-time hit target belong to one action boundary. A wrong-target attempt is blocked at capture phase and may be retried safely; after the intended target receives the trusted button event, Rust never replays it to manufacture success.

After a failure:

1. preserve `kind` and `stage`;
2. observe the current page;
3. determine whether the document, target identity, visibility, or business state changed;
4. choose a new explicit operation only from that evidence.
