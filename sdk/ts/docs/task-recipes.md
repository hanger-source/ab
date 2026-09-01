# Task recipes

## Short-countdown episode

Before START, read only the operation topics the episode is likely to need, build stable Locators for controls already present, and preflight them with short deadlines. If pixels may be required, load `screenshot` documentation before the clock starts.

Use one managed JavaScript cell for each already-determined timed sequence. If it yields a running cell id, wait on that exact cell with the shortest practical MCP yield. Tool yield is not an AB timeout.

Inside a countdown of roughly one minute or less, the default Agent action diff reuses the already presented baseline and captures only the post-action AX state. When several consecutive operations are already determined and no intermediate model decision is needed, suppress those intermediate observations and take one bounded fresh state at the next decision point:

```js
await start.click({ write: "none", timeoutMs: 2_000 });
await tab.ax.write("state", { timeoutMs: 2_000, maxChars: 24_000 });
```

Repeat only when the next choice requires new page state. Put consecutive, already-determined Locator operations in one JavaScript cell with `write: "none"`; mechanically verify committed field values inside the expression and return to the model only at the first genuinely new decision or final result. If the dispatch returns `outcome_unknown`, do one bounded observation to determine whether it happened; never replay it from the error alone.

These recipes combine AB primitives into complete Agent loops. They are patterns, not permission to perform actions outside the user's request.

## Explore an unfamiliar page

```js
await tab.ax.write("state", { maxChars: 24_000 });
// Choose a displayed ref from the presented state.
await tab.ax.click("e7", { write: "diff" });
await tab.ax.write("state");
```

Start with the Agent facade's full AX state so page instructions and status text are visible with the refs. Use interactive mode only as a deliberate compact view after the surrounding context is known. Do not begin with `querySelector` exploration.

## Repeated stable workflow

```js
const row = tab.getByRole("row").filter({ hasText: "Order 1042", visible: true });
await row.locator(tab.getByRole("button", { name: "Open", exact: true })).click({ write: "diff" });
await tab.getByRole("heading", { name: "Order 1042", exact: true }).count();
```

Locators are immutable query plans and resolve at use time. Keep the business identity in the query instead of depending on the current AX ref number.

## Submit and verify a form

```js
await tab.getByLabel("Email", { exact: true }).fill("agent@example.com");
await tab.getByRole("button", { name: "Save", exact: true }).click({ write: "diff" });
await tab.waitFor({ text: "Saved", timeoutMs: 15_000 });
await tab.ax.write("state");
```

The final observation, not the successful click call, proves the visible result.

## Autocomplete plus datepicker form

```js
await tab.ax.write("state");
const from = tab.getByRole("textbox", { name: "From:", exact: true });
const to = tab.getByRole("textbox", { name: "To:", exact: true });
// The presented state showed the unnamed date input as the third textbox.
const date = tab.getByRole("textbox").nth(2);
const submit = tab.getByRole("button", { name: "Search", exact: true });

// Inspect widget shape in one typed read; do not learn readonly state by failing fill().
const [fromState, toState, dateState] = await Promise.all([
  from.inspect({ attributes: ["aria-autocomplete", "placeholder"], timeoutMs: 1_500 }),
  to.inspect({ attributes: ["aria-autocomplete", "placeholder"], timeoutMs: 1_500 }),
  date.inspect({ attributes: ["aria-label", "placeholder", "readonly"], timeoutMs: 1_500 }),
]);
const dateIsReadonly = dateState.readOnly;

await from.fillAndSelectSuggestion(
  "POU",
  "POU",
  { expectedValue: "POU", timeoutMs: 4_000, write: "none" },
);

await to.fillAndSelectSuggestion(
  "HNM",
  "HNM",
  { expectedValue: "HNM", timeoutMs: 4_000, write: "none" },
);

if (dateIsReadonly) {
  await date.click();
  await tab.ax.click("<fresh-exact-day-ref>");
  await date.inputValue();
}

// This Locator resolves after the popup rerenders; an old AX ref does not.
await submit.click({ write: "diff" });
```

The airport names and ref ids above are placeholders for values actually shown by the current page observation. An action-produced diff is immediate and may precede delayed popup work. The invariant is the sequence: stable AgentLocator, explicit semantic option wait, newly presented full state, exact option, committed-value check, then a fresh-resolving submit AgentLocator.

## Observe a request caused by UI

```js
await agent.documentation("network");
const network = await tab.observeNetwork();
try {
  await tab.getByRole("button", { name: "Refresh", exact: true }).click();
  const response = await network.waitForResponse(
    event => String(event.params.response?.url ?? "").includes("/api/orders"),
    { timeoutMs: 20_000 },
  );
  const body = await network.responseBody(response);
  await network.assertComplete();
} finally {
  await network.dispose();
}
```

Open the observer before the trigger and preserve event session identity.

## Visual-only control

Use this after a bounded semantic observation or inspection establishes that the visible intended control has no usable identity. It is a deliberate surface change, not a retry of a failed semantic click. If the pixels still do not distinguish the intended control or its consequence, stop rather than guess.

```js
await agent.documentation("screenshot");
const shot = await tab.ax.get("screenshot");
// Open shot.path with the host image viewer and choose coordinates from those pixels.
await tab.cua.click({ x: 320, y: 180, viewportId: shot.viewportId });
await shot.dispose();
await tab.ax.write("state");
```

Take a new screenshot after scrolling, resizing, navigation, or layout change.

## Visual editor under a modal or fullscreen surface

When the intended content appears only as static text and has no action ref, inspect `state.sources.surface`. If it is `active`, do not select a covered control or hidden render iframe from the underlying document. Capture the active semantic state and pixels atomically:

```js
await agent.documentation("screenshot");
const page = await tab.ax.get("both");
// Open page.screenshot.path with the host image viewer and choose the visible target.
await tab.cua.click({
  x: 480,
  y: 220,
  viewportId: page.screenshot.viewportId,
  clickCount: 2,
  observe: "diff",
});
await page.state.dispose();
await page.screenshot.dispose();
```

The coordinates are examples only. Choose them from the presented screenshot. After the editor opens, use its newly exposed textbox, dialog, or contenteditable ref; never mutate the static preview through `evaluate()`.

Treat an embedded visual editor and its containing business form as separate commit boundaries. Once the visible editor dialog is open, stop toggling the covered outer builder. Fill the dialog-owned textbox or visible contenteditable surface, read back the edited value or visible text, and activate the dialog's own Save/Submit control. Wait for that dialog to close and the edited preview to appear before activating the outer page/form Save. Verify the application's final success state; an inner editor save alone does not prove the business object was persisted.

## Read-modify-write state change

For “increase/decrease/add/remove” tasks, first read the exact current value from the identified row/control, compute the requested result once, then fill the result and verify it from a fresh observation. The requested delta is never the replacement value.

```js
const quantity = row.getByRole("textbox", { name: "Quantity", exact: true });
const before = Number(await quantity.inputValue());
const after = before + requestedIncrease;
await quantity.fill(String(after), { write: "none" });
if (Number(await quantity.inputValue()) !== after) throw new Error("quantity did not commit");
```

Keep the row identity and control identity explicit. Do not read one row and write another after sorting, filtering, or rerender.

## Repeated mutation across filtered rows

First filter the grid and establish the exact business identities of all intended rows. Keep that identity set in the retained Node session; checkbox selection alone is not durable identity.

A bulk-action menu does not prove that the requested field is editable in bulk. Open one candidate bulk form, observe its visible fields, and use it only when the exact requested field is present. If the field is absent, leave without submitting and switch immediately to each row's edit workflow; do not spend the task window probing nearby bulk actions.

For each identified row:

1. open its edit action and include any child tab in the task-owned tab set;
2. verify the row/product identity from a fresh AX state;
3. locate the exact field, read its current value, and compute the requested mutation;
4. fill the computed value, read it back, save, and wait for visible success;
5. record that business identity as completed before returning to the grid or next child tab.

For wording such as “received N”, “add N”, or “increase by N”, the result is `current + N` independently for every row. Never fill `N` merely because several selected rows started with the same value. Stop rather than submitting a bulk form that would add a new inventory source, clear unspecified fields, or write a default zero when the task only authorizes quantity changes.

## Cross-origin frame

```js
await agent.documentation("frames");
const frames = await tab.frames();
const checkout = frames.find(frame => frame.url.includes("payments.example"));
if (!checkout) throw new Error("payment frame not present");
await tab.getByLabel("Card number").inFrame(checkout.id).fill("…");
```

Select a frame by inspected identity. Never guess that an iframe is same-origin or belongs to the root CDP session.

## Download lifecycle

```js
await agent.documentation("downloads");
const downloads = await tab.watchDownloads();
try {
  await tab.getByRole("link", { name: "Download report", exact: true }).click();
  const download = await downloads.waitForDownload();
  const completed = await download.waitForCompleted({ timeoutMs: 60_000 });
  completed.artifact;
} finally {
  await downloads.dispose();
}
```

Started and completed are different states. Preserve the completed artifact before disconnect when the caller needs it later.

## Resume after interruption

Reconnect, enumerate tabs, select the target from URL/title and a fresh observation, then inspect whether the intended result already exists. Recreate observers and local handles. Never rerun the last mutation solely because the previous JavaScript kernel disappeared.
