# Browser and task lifecycle

AB has three deliberately different lifetimes:

1. The Node.js Agent client lasts for one interactive task or managed JavaScript kernel.
2. The Rust daemon is shared by compatible clients and stays hidden behind `connect()`.
3. The headed Chrome and its fixed AB profile survive client and daemon replacement.

Do not collapse these into one "browser process" lifetime. `browser.disconnect()` releases only the current client's server-owned objects and target leases. It does not close Chrome or erase the profile.

With no operation in flight, graceful `browser.disconnect()` first asks Rust to release every Resource, observation, artifact, element, CDP session, and target lease owned by this client, waits for the acknowledgement, and then closes the transport. Its completion is therefore a usable handoff boundary for another client. Disconnect during an in-flight operation and abrupt socket closure use the interruption/EOF boundary so Rust can cancel or settle the operation before performing the same idempotent cleanup. Locally cached presentation objects are discarded afterward and cannot make a completed transport disconnect fail merely because an individual dispose request is no longer reachable.

## Start a task

Connect once and enumerate before creating state:

```js
const { connect } = await import("<ab-skill-root>/scripts/ab-client.mjs");
const agent = await connect();
let tabs = await agent.tabs.list();
```

Keep the same managed JavaScript kernel for follow-up expressions. `connect()` is idempotent within that process and returns the same pending or connected Agent facade until it is disconnected.

Select the target, acquire mutation authority, and separately record tabs created by this task:

```js
const openedByTask = new Set();
const candidate = tabs.find(t => t.url.startsWith("https://example.com/"));
let tab;
if (candidate) {
  tab = await agent.tabs.acquire(candidate.id);
} else {
  tab = await agent.tabs.open("https://example.com/");
  openedByTask.add(tab.id);
}
```

An existing tab is user or previous-task state. Do not acquire, reload, navigate, or submit through it merely because its URL looks relevant. First decide that the task actually needs it. `ownership: "other"` is an active conflict, not a retry hint. Acquiring an existing tab allows mutation while this client is alive; only creation by this task or explicit user direction allows cleanup by closing it.

## During a task

Each wrapped tab owns an independent last-presented AX baseline. Switching `tab` variables does not transfer short refs. `const state = await tab.ax.write("state")` returns the exact baseline established on the newly selected tab; do not call `get()` to recreate it before using `tab.ax.click("e…")`.

Keep resource handles in variables and pair every creation with deterministic cleanup:

```js
const resources = [];
const network = await tab.resources.network();
resources.push(network);
try {
  // Trigger and inspect the traffic.
} finally {
  await Promise.allSettled(resources.map(resource => resource.dispose()));
}
```

Observations, screenshots, element handles, resources, and CDP sessions are narrower than a tab. Navigation or rerender can invalidate some of them while the tab target remains alive.

## Finish a task

Dispose in this order:

1. event resources and init-script registrations;
2. element handles, observations, screenshots, and CDP sessions kept by user code;
3. only tabs recorded as task-created, when the task does not intentionally leave them open;
4. `agent.disconnect()`.

```js
for (const targetId of openedByTask) {
  const current = await agent.tabs.get(targetId).catch(() => null);
  if (current) await current.close();
}
await agent.disconnect();
```

Do not invent a daemon stop step. Chrome persistence is a product behavior, not leaked cleanup.

## Interruption and reconnection

If the JavaScript kernel is interrupted or reset, its socket closure causes Rust to release that client's resources and target leases. Chrome and ordinary tabs remain. Start a new kernel, call `connect()`, list tabs again, deliberately acquire the intended available target, and rebuild local variables from browser facts.

Never assume a JavaScript object from a dead process is recoverable. Never replay a mutation solely because the process ended while awaiting it. Reconnect, observe the current page, and decide from the actual state; a dispatched mutation may have completed.

## Concurrent tasks

The daemon can serve multiple clients and all may discover shared browser state. Rust grants mutation of each target to at most one active client. `tabs.open()` owns the new target, popup children inherit their opener's lease, and `tabs.acquire()` claims an available existing target. A conflicting client receives `target_in_use`; AB does not queue business intent, steal the target, or redirect the call.

Use different tabs for independent tasks. If a task must take over a preserved tab after its prior client disconnects, make that choice explicit with `tabs.acquire()` and keep mutations scoped to that target.
