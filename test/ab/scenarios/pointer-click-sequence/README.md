# Pointer click sequence

## Origin

During a whole-owner review of AB pointer actions, the same semantic double
click was executed through Codex Browser and current-source AB against one
browser event recorder. Codex Browser produced two button pairs, two `click`
events with details 1 and 2, then `dblclick` detail 2. AB inherited
agent-browser's single-pair implementation: it emitted only `click` detail 2
and `dblclick` detail 2, silently omitting the first activation.

Playwright and Puppeteer independently implement click count as a sequence of
press/release pairs. This scenario preserves that browser input contract; it is
not a site selector, timing allowance, or evaluator-specific shortcut.

## Invariants

- `doubleClick()` dispatches two trusted `mousedown`/`mouseup` pairs.
- The page receives `click` detail 1 before `click` detail 2.
- `dblclick` follows the second click with detail 2.
- A single public action reports the normal `cdp.pointer` mechanism.

The dialog lifecycle test separately owns interruption while a button is held.
Together they keep multi-click sequencing and pending release from diverging.
