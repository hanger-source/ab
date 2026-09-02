# Large document with a local mutation

## Interaction shape

The first Agent observation is capped at 24,000 characters while the page contains more than 400 actionable refs and more than 6,000 backend DOM nodes. Expanding one small section near the start of the page can otherwise produce a roughly 31,000-character “diff” when later refs are renumbered, even though the document and almost every element are unchanged.

This local page preserves that large-document interaction shape without depending on an external site or private data.

## Pressure and path

1. Open a headed Chrome tab containing hundreds of labeled controls and thousands of DOM nodes.
2. Present the Agent-facing full AX state with the normal 24,000-character budget.
3. Use a semantic Locator to toggle one small section near the beginning of the document.
4. Confirm the action returns without capturing or presenting state, then explicitly present the diff at the next decision boundary.
5. Present the same page in `interactive` mode, repeat the action, and request an explicit diff without passing a second capture shape.

## Invariants

- The initial state is genuinely truncated at the Agent output budget and still reports at least 400 refs and 6,000 backend nodes.
- The action performs no hidden pre- or post-action capture and does not advance the presented baseline.
- Explicit `ax.write("diff")` uses the successfully presented same-document observation as its baseline.
- Unchanged nodes retain their model-visible ref IDs by frame, document generation, and backend node identity.
- New nodes receive non-conflicting, usable IDs and appear as added refs.
- A local mutation produces a bounded local diff, not a page-sized ref-renumbering diff.
- An explicit Agent diff inherits the exact mode, surface, frame scope and output bounds of its presented baseline; an `interactive` baseline cannot silently become a `full` capture.
- The action completes within its public deadline through the ordinary Agent Locator API.

The action/wait/observation owner change that moved capture out of Agent mutations is recorded in
`docs/evidence/20260902__action-wait-observation-ownership-audit__@codex.md`.

The numeric scale is part of the reproduction, not a benchmark score. The assertions do not depend on a private site label, date picker, URL, or task answer.
