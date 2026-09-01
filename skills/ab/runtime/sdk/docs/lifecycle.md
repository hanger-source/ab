# Browser and task lifecycle

AB has three deliberately different lifetimes:

1. The Node.js Agent client lasts for one interactive task or managed JavaScript kernel.
2. The Rust daemon is shared by compatible clients and stays hidden behind `connect()`.
3. The headed Chrome and its fixed AB profile survive client and daemon replacement.

Do not collapse these into one "browser process" lifetime. `agent.disconnect()` releases only the current client's server-owned objects. It does not close Chrome or erase the profile.

Socket closure is the authoritative server cleanup boundary. `agent.disconnect()` closes the client transport first; Rust then releases every observation, artifact, element, CDP session, and Resource owned by that client. Locally cached presentation objects are discarded afterward and cannot make a completed transport disconnect fail merely because an individual dispose request is no longer reachable.

## Start a task

Connect once and enumerate before creating state:

```js
const { connect } = await import("<ab-skill-root>/scripts/ab-client.mjs");
const agent = await connect();
let tabs = await agent.tabs.list();
```

Keep the same managed JavaScript kernel for follow-up expressions. `connect()` is idempotent within that process and returns the same pending or connected Agent facade until it is disconnected.

Record task ownership locally:

```js
const openedByTask = new Set();
let tab = tabs.find(t => t.url.startsWith("https://example.com/"));
if (!tab) {
  tab = await agent.tabs.open("https://example.com/");
  openedByTask.add(tab.id);
}
```

An existing tab is user or previous-task state. Do not close, reload, navigate, or submit through it merely because its URL looks relevant. First decide that the current task actually needs to reuse it.

## During a task

Each wrapped tab owns an independent last-presented AX baseline. Switching `tab` variables does not transfer short refs. Run `tab.ax.write("state")` on the newly selected tab before using `tab.ax.click("e…")`.

Keep resource handles in variables and pair every creation with deterministic cleanup:

```js
const resources = [];
const network = await tab.observeNetwork();
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

If the JavaScript kernel is interrupted or reset, its socket closure causes Rust to release that client's resources. Chrome and ordinary tabs remain. Start a new kernel, call `connect()`, list tabs again, and rebuild local variables from browser facts.

Never assume a JavaScript object from a dead process is recoverable. Never replay a mutation solely because the process ended while awaiting it. Reconnect, observe the current page, and decide from the actual state; a dispatched mutation may have completed.

## Concurrent tasks

The daemon can serve multiple clients, but tab state is shared browser state. Separate clients must not both mutate the same tab without higher-level coordination. Resource ownership prevents one client from disposing another client's observer; it does not serialize business intent across clients.

Use different tabs for independent tasks. If a task must take over an existing tab, make that choice explicit and keep its mutations scoped to that target.
