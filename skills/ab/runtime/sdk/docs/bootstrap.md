# SDK bootstrap and persistence

## Installed runtime

The Skill entry point is a self-contained Node.js ESM client. Import it by the absolute directory containing the active `SKILL.md`:

```js
const { connect } = await import("<ab-skill-root>/scripts/ab-client.mjs");
const agent = await connect();
```

Do not import `@hanger-source/ab/agent` from the task working directory. Node package resolution is deliberately not part of the Skill contract. `ab-client.mjs` selects the native runtime packaged with the same Skill and privately launches it only when its current-user Unix socket is unavailable.

The Skill client owns the product paths. It binds the current user's AB runtime base, application-data directory, and managed `chrome-profile`; inherited `AB_RUNTIME_DIR`, `AB_DATA_DIR`, `AB_PROFILE_DIR`, or `AB_CHROME_PATH` development variables do not redirect Agent browser work. Programmatic Core SDK tests may use those variables, but the installed Agent Skill may not. An explicitly selected external provider derives a separate runtime socket from the endpoint origin.

If the client or packaged runtime is missing, the Skill installation is incomplete. Stop with that exact diagnosis; do not inspect source, `.d.ts`, workspace `node_modules`, or another global package to guess a replacement.

AB intentionally has no start, stop, restart, daemon, status, or profile CLI. The lifecycle is part of `connect()`:

- an existing matching daemon is reused;
- an idle mismatched daemon yields to the exact SDK build;
- a mismatched daemon with another client or dispatched mutation fails explicitly;
- the selected Chrome persists independently of the Node process;
- a managed replacement daemon reattaches only the Chrome identity owned by AB's fixed profile;
- an external runtime connects only the explicitly supplied browser-level WebSocket endpoint.

There is one AB-specific headed Chrome profile for the default managed provider. Cookies and storage survive Node sessions and Agent tasks. AB does not switch to a temporary profile when the fixed profile is unavailable.

## User's running Chrome

For “connect to my Chrome”, select `user` before the first connection:

```js
const agent = await connect({ provider: { kind: "user" }, timeoutMs: 60_000 });
```

The SDK identifies the current user's regular Google Chrome process on macOS, excludes processes using custom user-data directories (including AB's managed profile), and discovers its loopback TCP listener. No profile file access, browser-id, copied login data, extension, or manually supplied address is required. Multiple candidate browsers or listening ports fail explicitly rather than selecting one arbitrarily. The `user` provider uses the external runtime and its target ownership rules; `identity.chrome.source` is `external`.

Chrome 144+ supports enabling remote debugging in the existing browser at `chrome://inspect/#remote-debugging`. In approval mode, `/json/*` returns 404 by design and the browser WebSocket path is `/devtools/browser`, with no GUID. AB requests that connection once and Chrome displays the permission prompt. Tell the user to approve it; keep waiting on the original JavaScript cell. Do not create duplicate connection attempts while consent is pending. A conventional debugging server is identified by its `/json/version` browser endpoint instead.

Use an outer Tool timeout of at least 90 seconds for the 60-second connection deadline. Connection errors are actionable:

- `user_chrome_not_running`: ask the user to open their regular Chrome; AB does not launch it.
- `user_chrome_debugging_disabled`: ask the user to enable the setting at `chrome://inspect/#remote-debugging`, then connect again.
- `user_chrome_ambiguous`: report the ambiguity; do not choose another browser or port.
- `user_chrome_discovery_failed`: report the local process/listener/discovery failure from the error.
- `user_chrome_permission_denied`: Chrome rejected the request; the user must allow a subsequent request if they want to connect.
- `user_chrome_connection_timeout`: check for the pending Chrome permission prompt; do not repeatedly reconnect.

No `user` failure launches or falls back to managed Chrome. Do not restart the user's browser or request full disk access to repair this flow.

## Explicit endpoint

Use `external` when the caller supplies a specific local or remote browser-level WebSocket endpoint:

```js
const agent = await connect({
  provider: {
    kind: "external",
    webSocketUrl: "ws://127.0.0.1:9222/devtools/browser/<browser-id>",
  },
});
```

Use the endpoint supplied by the caller. The external provider does not launch Chrome, copy a profile, attach all tabs, fall back to managed Chrome, or share the managed runtime socket. Do not make an Agent discover or read `DevToolsActivePort` to fulfill a request for the user's regular Chrome; use `user` instead.

## Persistent JavaScript session

For an interactive task, use one Node REPL MCP Tool. It keeps one dedicated JavaScript kernel alive across Tool calls, so `agent`, tabs, observations, and resources remain available without generating a new script for every operation. Ending or resetting that kernel does not end Chrome.

Host selection is explicit:

- **Codex:** use the built-in `node_repl` already exposed by Codex. Do not launch or register `host/node-repl` as a duplicate;
- **another Agent host with a compatible managed Node REPL:** use the Tool selected by that host, including when it packages the Codex native runtime; do not register a second kernel beside it;
- **another Agent host without one:** configure the Apache-2.0 Qwen `node-repl-mcp` as a standard stdio MCP server before invoking this Skill. Use a pinned installed package or the built `host/node-repl/dist/index.js`; the Skill does not install or start it;
- **host without MCP support:** use a normal Node.js ESM file for a reproducible batch. An ordinary terminal REPL is a diagnostic fallback, not the interactive Agent contract.

A compatible managed host must expose persistent top-level bindings, the `nodeRepl.write()` / `nodeRepl.emitImage()` content API, an outer execution timeout, and a way to wait for a yielded cell without starting another one. The host owns JavaScript cell parsing, top-level await, module loading, cancellation and MCP content framing. It does not own Chrome, CDP, AB observations or browser resources.

Qwen's local server can be configured by any MCP client after `host/node-repl` has been built:

```jsonc
{
  "mcpServers": {
    "node-repl": {
      "command": "node",
      "args": ["/absolute/path/to/ab/host/node-repl/dist/index.js"],
      "cwd": "/the/agent/workspace"
    }
  }
}
```

The equivalent published-package entry is `@qwen-code/node-repl-mcp`; pin its version in a real installation rather than downloading an unbounded latest version during a task. Node.js 22 or newer is required by the current Qwen component. Bun is the repository development package manager, not a runtime prerequisite for a user of `ab`.

## Presenter boundary

The default Presenter selects its public host channel at connection time:

- inside the managed Node REPL, AX/documentation text uses `nodeRepl.write()` and verified screenshot bytes use `nodeRepl.emitImage()`, producing standard MCP text/image content blocks;
- in an ordinary Node process, text and screenshot artifact metadata go to stdout, and the Agent opens the verified path with its host image viewer;
- a caller may still provide an explicit typed `Presenter` to `connect()`.

AB does not depend on Codex Browser's private response writer. Codex's built-in Node REPL and the open-source Qwen Node REPL are interchangeable only at this public content/session contract; their implementation, Tool names and release identity remain host concerns.

## Exact installation layout

The installed Skill is one versioned unit:

```text
skills/ab/
├── SKILL.md
├── references/
├── scripts/ab-client.mjs
└── runtime/
    ├── manifest.json
    ├── sdk/
    └── native/darwin-arm64/bin/ab-runtime
```

The manifest, packaged SDK, and native build share one protocol/build identity. Mixing a client from one installation with a native executable from another is unsupported. The public npm package is a separate delivery form; an Agent following this Skill always uses the absolute Skill client even if `ab` is installed in the current project.

## Connection and browser identity

`connect()` resolves only after protocol handshake and browser ownership are established:

```js
const agent = await connect({ timeoutMs: 30_000 });
browser.identity;
// clientId, daemonId, browserGeneration, chrome.source, chrome.pid
```

`chrome.source` is `launched` or `reattached` for managed Chrome and `external` for a caller-supplied endpoint. External Chrome has no AB-owned pid, so `chrome.pid` is `null`.

When `connect()` launches a runtime, the SDK waits for that exact startup attempt to publish `ready` or a structured `failed` state before opening the protocol socket. A bound Unix socket is not treated as browser readiness. Profile ownership and Chrome launch failures therefore surface with their Rust `kind` and `stage`, rather than being rewritten as a generic startup timeout.

When a different packaged build connects to an idle daemon, the old daemon can yield its socket and the new build reattaches the same managed Chrome. Handover is refused while another client or dispatched mutation makes replacement unsafe. Do not kill the daemon or remove socket/profile files to solve normal handover.

## Managed Node REPL pattern

Call the persistent JavaScript Tool repeatedly. The first cell imports the version-matched client by absolute path:

```js
const { connect } = await import("<ab-skill-root>/scripts/ab-client.mjs");
const agent = await connect();
let tabs = await agent.tabs.list();
nodeRepl.write(tabs);
```

AB uses the selected host's mature Node REPL MCP server; it does not implement another JavaScript parser or browser server. If a cell outlives the Tool's yield interval, keep its returned cell id and use that provider's wait or cancel Tool. Never submit another cell while one is active. Tool yield, JavaScript execution timeout and AB operation `timeoutMs` are separate limits.

The Tool call must set its outer `timeout_ms` later than every AB deadline that the cell can consume. An AB operation with no explicit `timeoutMs` uses 30 seconds, so a single ordinary browser cell uses at least `timeout_ms: 60_000`. If one cell deliberately performs several sequential AB calls, give each an explicit `timeoutMs` and set the outer deadline to at least their sum plus 10 seconds, or end the cell at the next point that requires an Agent decision. `yield_time_ms` does not extend either deadline; it only returns a running cell id for later waiting.

This ordering preserves AB's structured terminal result. Codex's native Node REPL resets its JavaScript kernel when the outer execution deadline wins; Qwen's implementation retains the kernel on its own timeout, but that implementation difference is not an excuse to run equal inner and outer deadlines. If a mutation still ends with `outcome_unknown`, reconnect or inspect the current tab before considering any replay.

Use a `.mjs` file for a non-interactive reproducible batch. Both forms use the same SDK and Rust daemon.

## Custom Presenter

A host can provide typed `presentText` and `presentImage` functions to `connect({ presenter })`. Documentation is marked read only after text presentation succeeds. AX baseline and screenshot use follow the same success boundary. Do not implement a Presenter that silently discards content while reporting success.
