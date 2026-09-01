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

Single-target operations are strict. Zero matches can be retried inside the deadline while the exact document remains valid. Multiple matches are an error unless the caller uses `nth/first/last`, `all()`, or `count()` deliberately. Locator action retry may re-resolve before dispatch; it never repeats the input dispatch.

## Bound-node mechanics

AX refs and ElementHandles never relocate. Rust can recheck attachment, visibility, stability, geometry, hit target, and scroll state for the same node. Navigation or frame/document replacement returns stale rather than resolving a similar element.

## After the action

Use `observe: "diff"` when the immediate semantic delta is useful. A Core Locator, ElementHandle, or CUA caller must pass `baseline`, which is an existing `AXState` or observation id from the same tab; an `AXRef` already owns its observation and supplies that identity automatically. Omit `observation` to inherit the baseline's exact capture shape. Supplying a different mode, surface, frame scope, depth, character budget, or URL policy is rejected before input dispatch because those two states do not form a meaningful diff. `observe: "state"` requests only the post-action state and needs no baseline. Rust never captures a hidden pre-action snapshot. The post-action capture runs after browser input dispatch, but it does not guess when later timers, requests, animations, autocomplete results, or SPA work have reached the business state the caller needs. Wait for that explicit semantic, lifecycle, or resource fact before relying on later state. A timeout before input dispatch is retryable; a cancellation or transport loss after dispatch can return `outcome_unknown`, which must be inspected before any retry.

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
result.fileChooser        // pre-armed chooser fact; complete=false means absence is unproven
result.observationOutcome // completed, skippedDialog, failed, or notRequested
result.lastStage
result.observation        // AXState when observe:"diff" or observe:"state" completed safely
```

`ActionResult` proves which browser mechanism ran and what browser facts were observed around it. It never proves that a save, purchase, deletion, login, or other business outcome succeeded. Verify that outcome from the rendered application state or an explicitly prepared resource.

Input dispatch and the optional post-action observation are separate outcomes. Once dispatch has completed, a failed AX capture does not erase the `ActionResult` or turn the mutation into an unknown dispatch. `observationOutcome.status === "failed"` retains the exact observation error; `skippedDialog` means the page is blocked by the dialog reported in the same result. The Agent facade presents this trusted status instead of inventing a diff. Keep the previous short-ref baseline, handle a reported dialog if present, then explicitly observe current state before another mutation.

`observe: "diff"` is one server-side target-lane transaction: Rust resolves the caller's explicit baseline, arms browser event observers, dispatches once, and captures only the post-action state. This removes the former full-page pre-capture from the mutation's deadline and prevents a request from timing out before its click while later clicking in the background. For the resulting same-document observation, unchanged frame/document/backend-node identities keep their baseline `eN`; genuinely new nodes receive non-conflicting refs, so the model-visible diff is not inflated by positional renumbering.

In `@hanger-source/ab/agent`, `tab.playwright` builders return `Locator`. Its mutations default to `write: "diff"` and reuse both the identity and exact capture shape of the last successfully presented observation. If no state has been presented yet, the first mutation requests one post-action `state` instead of inventing a baseline. The Presenter renders the compact Myers text diff and adopts the same `ActionResult.observation` object as the next per-tab short-ref baseline; it does not capture another snapshot. `{ write: "none" }` preserves the current baseline; `{ write: "state" }` requests and presents one post-action full state. Agent short-ref and Locator actions accept `write`, not Core `observe` or `baseline`; passing those Core-only fields fails before dispatch instead of being silently overridden. Core `@hanger-source/ab` continues to return ordinary Locator with explicit observation ownership and no presentation side effect.

Agent `Locator.waitFor()` composes the existing Rust semantic wait with Agent presentation. After the requested attached/detached/visible/hidden fact succeeds, it presents a fresh full state by default and advances the short-ref baseline. Pass `{ write: "none" }` when code only needs synchronization. Core `Locator.waitFor()` remains a pure wait.

## AX short refs versus explicit refs

Agent short refs are available only after the Presenter successfully displays `write("state")` or `write("both")` on that exact wrapped tab:

```js
await tab.ax.write("state");
await tab.ax.fill("e3", "Ada", { write: "diff" });
await tab.ax.click("e8", { write: "diff" });
```

`write: "diff"` presents an action-produced semantic delta and moves the short-ref baseline to that returned observation. `write: "state"` requests and presents the post-action full state inside the same action transaction; it does not perform a second SDK snapshot. `write: "none"` performs no presentation and preserves the previous baseline; use it only when another explicit verification follows.

An `interactive` baseline deliberately excludes ordinary static text, so its inherited diff cannot prove a newly rendered paragraph, total, or confirmation message. Use `write: "state"` on the consequential action, or explicitly wait for the business fact and then write full state, when that static result must be visible. AB does not silently switch capture modes after dispatch.

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

`fill()` and `type()` return typed `data.field`: the requested text, settled `inputValue`, `matchesRequestedText`, `popupBacked`, detection `signals`, and `next`. Rust reads the live node after dispatch. `matchesRequestedText` is an exact boolean for `fill()` and `type(..., { clear: true })`, and `null` for append typing. Agent presentation emits a trusted warning when a control truncates or normalizes replacement text; inspect `inputValue` before submitting. Popup-backed inputs receive a bounded settle window before the post-action observation is captured. When `next === "selectSuggestion"`, use the newly presented popup state and select the exact suggestion before continuing. A pre-action `aria-autocomplete: null` does not override this runtime outcome.

`field.fillAndSelectSuggestion(query, suggestionText, { expectedValue, exact?, suggestionExact? })` composes that protocol when the expected suggestion text is known. It captures an AX baseline, fills without presentation, finds the matching newly presented actionable ref in the next revision, clicks that exact ref, reads the field again, and fails if selection is ambiguous or the committed value does not match. This does not require the widget to expose `role="option"`; Agent mode presents only the final selection observation while the result retains the matched suggestion identity.

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

Rust may wait for and recheck the same intended target before dispatch. It may re-resolve a Locator while the document identity remains applicable. It never repeats an input dispatch to manufacture success.

After a failure:

1. preserve `kind` and `stage`;
2. observe the current page;
3. determine whether the document, target identity, visibility, or business state changed;
4. choose a new explicit operation only from that evidence.
