# Forms and structured input

Use the page's semantic identity before CSS or coordinates. For a changing form, write AX state and act on refs. For a stable repeated workflow, create Locators from labels, roles, placeholders, or test ids.

## Inventory controls before mutating

On an unfamiliar structured form, do not discover widget behavior by attempting `fill()` on every field. Observe once, turn stable labels and buttons into Locators, and inspect properties that change the action plan:

```js
await tab.ax.write("state");
const origin = tab.playwright.getByRole("textbox", { name: "From:", exact: true });
// The presented state showed the unnamed date input as the third textbox.
const departure = tab.playwright.getByRole("textbox").nth(2);
const search = tab.playwright.getByRole("button", { name: "Search", exact: true });

const [originState, departureState] = await Promise.all([
  origin.inspect({ attributes: ["aria-autocomplete", "placeholder"] }),
  departure.inspect({ attributes: ["aria-label", "placeholder", "readonly"] }),
]);
const departureIsReadonly = departureState.readOnly;
const originAutocompleteHint = originState.attributes["aria-autocomplete"];
```

`inspect()` is one typed Rust/CDP read for the selected element. It also returns tag/input type, text, value, visibility, enabled/checked state, readonly/contenteditable state, bounds, and exactly the requested attributes. Use it instead of a chain of `getAttribute()`, `isEnabled()`, `inputValue()`, and `boundingBox()` calls when the decision needs several facts. Attribute inspection is a hint, not a negative proof: jQuery UI and other page code can create an autocomplete after initial render without an `aria-autocomplete` attribute.

Choose the first Locator from facts the observation actually proves. AX renders role and accessible name, not the HTML source of that name. Therefore `textbox "From:"` maps directly to `getByRole("textbox", { name: "From:", exact: true })`; it does not justify guessing `getByLabel("From:")`. After `inspect()` confirms `placeholder: "From:"`, `getByPlaceholder("From:")` is also exact. Keep `getByLabel()` for a label/control relationship the page actually exposes.

Use Locators for these stable controls even in a one-off task. Reserve short AX refs for options that only exist inside a newly opened autocomplete list, datepicker, token chooser, or menu. This avoids carrying an old observation across a popup rerender.

## Text fields

`fill()` replaces the current value and is the normal choice for inputs and textareas. `type()` emits keyboard input and is appropriate when the page depends on per-key behavior. `clear()` is explicit when empty state itself matters.

```js
await tab.playwright.getByLabel("Email", { exact: true }).fill("agent@example.com", { write: "diff" });
await tab.playwright.getByLabel("Search").type("quarterly report", { delayMs: 25 });
await tab.playwright.getByRole("button", { name: "Save", exact: true }).click({ write: "diff" });
```

Do not log or echo secret values after entry. If a framework rerenders the field, resolve the Locator again or take a fresh AX state; do not keep an old element handle by default.

## Choices

Use `check()` / `uncheck()` for checkbox state and `selectOption()` for native select values:

```js
await tab.playwright.getByLabel("Send a copy").check({ write: "diff" });
await tab.playwright.getByLabel("Region").selectOption("ap-southeast-1", { write: "diff" });
```

Custom comboboxes are interactive widgets, not native selects. Observe their roles and use click/type/press against the controls the page actually exposes.

Before toggling, inspect current state when duplicate mutation matters. A blind `click()` on a checkbox can invert an already-correct value; `check()` and `uncheck()` express the intended final state.

## Autocomplete fields

Autocomplete entry is a commit protocol, not a text assignment:

1. Use the stable field Locator to type the query.
2. Wait for a semantic option to appear; the Agent Locator presents a fresh full AX state when that wait succeeds.
3. Select the exact displayed business value from that observation.
4. Discard all refs from the suggestion observation.
5. Read `inputValue()` from the stable Locator and verify the committed value.

```js
const destination = tab.playwright.getByRole("textbox", { name: "To:", exact: true });
const committed = await destination.fillAndSelectSuggestion(
  "White River, VT",
  "White River, VT",
  { expectedValue: "White River, VT", timeoutMs: 4_000 },
);
const committedDestination = committed.committedValue;
```

`data.field` is the input action's runtime outcome. It detects semantic combobox/datalist signals and common widget-owned signals such as jQuery UI, reads the settled input value, and lets the post-action observation include the generated popup. Do not treat a pre-action null attribute as stronger evidence. Do not continue to the next popup-backed control until the committed value is visible. Text remaining in the input does not prove the page accepted a suggestion.

Use `fillAndSelectSuggestion()` when the expected displayed suggestion can be named before the popup appears, such as a city, code, product, or person substring. It selects only a matching ref newly introduced after the fill, so identical text already present in the instruction is excluded. Keep the lower-level five-step protocol when the correct option cannot be known until the popup is observed. Ambiguous new matches fail instead of silently choosing the first.

An action-produced diff is captured immediately after input dispatch. It may contain a suggestion that appeared synchronously, but it does not promise that delayed autocomplete, timer, request, or SPA work has completed. Do not insert a blind sleep and do not assume the fill diff owns the popup; use the composed AX-revision operation or wait for another explicit page fact.

## Readonly and popup-backed dates

A readonly text input is normally the trigger for a datepicker or another owned widget. Do not call `fill()`, try alternate date strings, or mutate it through `evaluate()`. Click the stable Locator, then operate the popup from a fresh observation:

```js
const date = tab.playwright.getByRole("textbox").nth(2);
if ((await date.inspect()).readOnly) {
  await date.click();
  // Navigate month/year controls when necessary, then click the exact day
  // using a ref from the Locator click's presented popup observation.
  await tab.ax.click("<fresh-day-ref>");
  const committedDate = await date.inputValue();
}
```

Popup selection can rerender or replace the underlying frame. Never use a submit-button ref captured before the popup opened. Keep submit as a Locator and let it resolve the current node after the popup closes.

## Submit and validation

Submitting can navigate, open a dialog, trigger a download, or update inline validation. Prepare the relevant observer before submission. Afterward, verify a business-facing result such as a confirmation heading, record state, validation message, or completed download—not merely the action's return value.

Do not silently bypass disabled controls, overlay interception, or validation with `evaluate()`. Those are page facts that often indicate missing input or an unsafe step.

## Uploads

Prefer `setFiles()` on an addressable file input:

```js
await tab.playwright.getByLabel("Attachment").setFiles("/absolute/path/report.pdf", { write: "diff" });
```

Verify the exact absolute path before the call. For a chooser-driven control, open `watchFileChoosers()` before clicking and use the emitted frame/backend-node identity. Do not replace a missing file with a similarly named path.

## Drag and drop

Use `source.dragTo(target)` when both ends have semantic identities. Both Locators must belong to the same browser and tab; both AX refs must come from explicit observations and still be current. Verify the resulting order or destination from a new observation.

## Multi-step form pattern

1. Observe the current step and inventory stable controls, readonly state, and autocomplete semantics before mutation. Build the first Locators from the displayed AX role/name; do not infer label, placeholder, or test-id provenance from the accessible name. If START begins a countdown, do this before START when the controls already exist behind its cover, with an explicit short timeout on each preflight read.
2. Fill one coherent group of ordinary text fields with stable Locators.
3. For each autocomplete or popup control, open it, re-observe, choose one exact option, verify the committed value, and discard popup refs.
4. Re-observe after controls that conditionally change the form.
5. Prepare watchers for the final action.
6. Announce and perform the consequential submission through a fresh-resolving Locator.
7. Verify the resulting application state.

Do not cache refs across wizard steps or document changes.
