# Icon-font accessible names

## Origin

A large Magento administration grid exposed a filter button as `\u{e605}Filters` in Chrome's accessibility tree because its visual icon came from a Unicode Private Use Area glyph. The Agent naturally selected the model-visible label `Filters`. Exact role lookup returned no match quickly, but Locator auto-wait retried until the outer RPC deadline replaced the useful `not_found` cause with a generic timeout.

## Invariants

- AX text and public ref metadata remove private-use icon glyphs while preserving the adjacent human label.
- An exact role Locator uses the same model-visible name as the AX observation and acts without exhausting its timeout.
- An unlabeled icon-only control remains addressable by ref but does not acquire a fabricated semantic name.
- A genuinely missing Locator keeps automatic waiting, then reports a Locator deadline with its final selector failure instead of a generic request deadline.

This scenario owns accessible-name agreement and terminal Locator diagnostics. It does not claim that arbitrary icon-only controls become semantically labeled; pages remain responsible for authoring labels for those controls.
