# Large document with a local mutation

## Origin

A signed-in production CRM page exposed this interaction shape: the first Agent observation was capped at 24,000 characters while the page contained more than 400 actionable refs and more than 6,000 backend DOM nodes. Expanding one small section near the start of the page then produced a roughly 31,000-character “diff” because later refs were renumbered, even though the document and almost every element were unchanged.

This local page preserves that shape without retaining the CRM URL, account data, or business content.

## Pressure and path

1. Open a headed Chrome tab containing hundreds of labeled controls and thousands of DOM nodes.
2. Present the Agent-facing full AX state with the normal 24,000-character budget.
3. Use a semantic Locator to toggle one small section near the beginning of the document.
4. Let the normal Agent action path capture and present its post-action diff.
5. Present the same page in `interactive` mode and repeat the default Agent action, without passing a second capture shape.

## Invariants

- The initial state is genuinely truncated at the Agent output budget and still reports at least 400 refs and 6,000 backend nodes.
- The action uses the explicitly presented same-document observation as its baseline; there is no hidden pre-action full capture.
- Unchanged nodes retain their model-visible ref IDs by frame, document generation, and backend node identity.
- New nodes receive non-conflicting, usable IDs and appear as added refs.
- A local mutation produces a bounded local diff, not a page-sized ref-renumbering diff.
- A default Agent diff inherits the exact mode, surface, frame scope and output bounds of its presented baseline; an `interactive` baseline cannot silently become a `full` post-action capture.
- The action completes within its public deadline through the ordinary Agent Locator API.

The numeric scale is part of the reproduction, not a benchmark score. The assertions do not depend on a private site label, date picker, URL, or task answer.
