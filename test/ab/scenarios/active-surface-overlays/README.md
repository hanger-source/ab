# Active surface overlays

## Origin

Real applications use several overlay shapes: a transparent full-viewport layer that contains no usable UI, a conventional fixed editor, and a full-page absolute backdrop whose parent ignores pointer input while an interactive child accepts it. Treating all three alike either hides the usable document or leaks covered controls into the Agent observation.

## Invariants

- An empty transparent overlay does not replace the document observation.
- A fixed full-viewport editor becomes the active surface and excludes covered document actions.
- An absolute high-z overlay with a non-interactive backdrop and a meaningful interactive child becomes the active surface.
- Document, content modal, and nested login modal each have a stable effective-surface identity. Moving between them is a surface replacement; a mutation inside the same content modal remains an incremental diff.
- A surface replacement returns the bounded current state and never encodes the transition as a deletion-plus-addition patch.
- Active-surface selection is derived from layout, hit testing, pointer behavior, and meaningful accessible content—not from fixture labels or a framework-specific selector.

This scenario owns surface selection and replacement identity only. Large-state truncation and same-document ref stability are covered by the neighboring large-document scenario.
