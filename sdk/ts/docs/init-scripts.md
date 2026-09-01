# Init-script registrations and instances

`tab.addInitScript()` registers an async function body with explicit name, world, frame scope, JSON args, and client ownership. Isolated world is the default; use main world only when page globals must be patched.

Rust installs the binding and future-document script in every matching current or newly attached session, resumes paused targets, then explicitly activates the current document. Each live instance is identified by registration, session, execution context, frame, and document generation.

Inside source, `ab.emit()` sends page events to the Rust resource buffer, `ab.onCommand()` receives typed host commands, and `ab.onCleanup()` registers deterministic cleanup. Navigation disposes the old instance and creates a new identity. Commands never float to the replacement.

Disposing a registration removes future injection, invokes cleanup in live instances, releases bindings, and closes its resource. Cleanup can undo registered page-side work; AB does not guess how to reverse arbitrary effects that the script created outside cleanup handlers.

## Registration example

```js
await agent.documentation("init-scripts");
const registration = await tab.addInitScript({
  name: "order-monitor",
  world: "isolated",
  frames: "all",
  args: [{ channel: "orders" }],
  source: `
    const config = args[0];
    const observer = new MutationObserver(() => {
      ab.emit("changed", { url: location.href, channel: config.channel });
    });
    observer.observe(document, { subtree: true, childList: true });
    ab.onCommand((name, value) => {
      if (name === "read") return { url: location.href, value };
      throw new Error("unknown command: " + name);
    });
    ab.onCleanup(() => observer.disconnect());
  `,
});
try {
  const instance = await registration.waitForInstance({ timeoutMs: 15_000 });
  const current = await registration.send(instance, "read", { request: 1 });
  const changed = await registration.waitFor(
    event => event.method === "initScript.event" && event.params.event === "changed",
    { timeoutMs: 30_000 },
  );
} finally {
  await registration.dispose();
}
```

## World selection

Use `isolated` by default. It avoids sharing JavaScript globals with page scripts while retaining DOM access. Use `main` only when the task explicitly requires patching or observing page-owned globals; it increases collision and tampering risk.

Page content can observe effects placed in the main world. Neither world makes untrusted page data into trusted instructions.

## Frame and document scope

`frames: "top"` targets only the top frame. `frames: "all"` covers matching current frames and future attached sessions, including OOPIFs. Each document gets a distinct `InitScriptInstance`; navigation disposes the old instance and establishes a new one.

Never cache an instance across navigation. `registration.send(instance, ...)` intentionally stays bound to the exact instance and must fail after replacement.

## Event and command design

Keep emitted payloads JSON-like, small, and task-specific. Use events for page-to-host facts and commands for explicit host-to-instance requests. Do not create a generic remote-eval tunnel inside an init script.

Name registrations by behavior, not by a random task id. Keep side effects reversible through `ab.onCleanup()` where possible.

## Disposal boundary

Disposal removes future injection, invokes registered cleanup, releases bindings/domain leases, and closes the event resource. It cannot undo page-side effects that the script did not register cleanup for, such as requests already sent or storage already modified. Design cleanup before installing the script.
