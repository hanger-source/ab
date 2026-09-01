# Page observation

## Separate state acquisition from presentation

`tab.ax.get()` returns a typed object for code. It does not print page text and does not advance the short-ref baseline. `tab.ax.write()` goes through the Presenter; a successful `write("state")` or `write("both")` makes exactly that observation's refs available to Agent short-ref actions.

Core `snapshot()` always remains explicit:

```js
const state = await tab.ax.snapshot({ mode: "full", frames: "all" });
state.text
await state.ref("e4").click({ observe: "diff" });
```

There is no implicit latest AX state in Rust, no `ax.click(index)`, and no ref relocation. A ref means one observation, frame, document generation, and backend node.

`frames` is either `"all"` or `{ root: frameId }`. A root scope captures that exact frame and its descendant frame subtree; it excludes siblings, ancestors, and other branches. Obtain current identities from `tab.dev.frames()` and never use an array index as a frame scope. A diff must use the same frame root as its baseline.

## Completeness

Interactive mode removes most non-interactive text; full mode does not. `surface: "active"` scopes a modal or full-viewport fixed editor to its exact DOM subtree; when no such layer exists it resolves to the document. `surface: "document"` deliberately exposes the complete document surface. Both can be bounded by depth or characters. Before inferring absence, inspect:

- `complete` and `truncated`;
- `sources.ax/dom/layout/piercedDom/refsCovered`;
- `sources.frameCount/capturedFrameCount`, `sessionCount`, and `backendNodeCount` when multi-frame coverage matters;
- `sources.gaps`, with exact frame/session/source/reason identities for every omitted boundary.
- `sources.surface`, so a covered document is not confused with the current active UI.

`complete: false` is a usable partial observation, not permission to assume the missing frame is empty. Read `sources.gaps`, refresh once if the topology was changing, and otherwise report the unsupported or unavailable boundary.

## Atomic AX plus pixels

Use `tab.observe({ ax, screenshot: true })` or Agent `get/write("both")`. Rust captures AX/DOM/layout and pixels in one transaction, then checks document generation, frame topology, viewport, scroll, and DPR again. Any identity change rejects the whole operation with `observation_consistency_error`; AB never returns a state from one page moment and a screenshot from another.

## Diff

Diff is always explicit through `diffFrom` or an action's `observe: "diff"` plus an existing baseline observation. Within that explicit same-document comparison, Rust reuses an existing `eN` when the current ref has the same frame, document generation, and backend-node identity; genuinely new nodes receive non-conflicting refs. This prevents an insertion near the top of a large page from renumbering every later ref and turning a local change into a fake full-page diff. It does not create an implicit latest state, relocate a disappeared node, or carry identity across document replacement.

The runtime then reuses agent-browser's Myers line diff for compact model-visible text and separately reports changed, added, and removed actionable refs. It does not infer whether the user's business goal succeeded. Across document replacement it reports replacement and presents the bounded new state instead of matching lookalike nodes.

## What an AX state contains

An `AXState` is an owned observation object with an observation id, tab/document identity, rendered text, structured refs, source/completeness metadata, and an optional semantic diff. Every ref carries role, accessible name, frame, document generation, backend node, and optional bounds.

The Node inspect view intentionally shows metadata rather than dumping untrusted page text. Use `tab.ax.write()` when content should become model-visible, or read `state.text` deliberately in code.

## Choose capture mode and bounds

```js
await tab.ax.write("state", {
  mode: "full",
  surface: "active",
  frames: "all",
  maxDepth: 18,
  maxChars: 24_000,
  includeUrls: false,
});
```

The Agent facade defaults to full mode on the active surface because model-visible observations must include task instructions, status text, and other non-interactive context beside the actually reachable refs. Interactive mode is an explicit compact action-only surface once the surrounding context is already known. Core `tab.ax.snapshot()` remains explicit and defaults to interactive mode on the document surface. `maxDepth` and `maxChars` control presentation cost; they do not change the underlying page.

When the answer may lie outside a bounded state, narrow by navigation/section or request a larger/full state. Do not treat truncation as negative evidence. `includeUrls` can expose sensitive or noisy query parameters; enable it only when URL targets matter.

## Ref lifecycle and presentation baseline

Each short id such as `e12` belongs to exactly one observation. Agent `write()` stores the successfully presented `AXState` as that tab's current baseline. Meaningful rerender, navigation, frame replacement, or a stale action requires a new state. Never search a new state for the same numeric ref and assume continuity.

Presentation must succeed before the baseline advances. If the Presenter throws, AB disposes the new state and keeps the previous successfully shown state. `write("screenshot")` does not change AX baseline. `write("both")` changes it only after both text and screenshot are presented.

## Atomic observation ownership

```js
await browser.documentation("screenshot");
const page = await tab.ax.get("both");
try {
  page.state?.text;
  page.screenshot?.viewportId;
} finally {
  await page.state?.dispose();
  await page.screenshot?.dispose();
}
```

The transaction validates before/after document generation, sorted frame topology, viewport, scroll offset, DPR, and layout identity. A mismatch rejects the capture instead of returning mismatched components.

## Diff interpretation

A diff is useful for understanding immediate UI reaction, but it is not a success oracle. A confirmation can appear before rollback; a canvas/network change may produce no semantic diff; document replacement is not fine-grained; incomplete states cannot prove unchanged content outside coverage. Verify the application fact appropriate to the user's goal.
