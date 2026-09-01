# SDK bootstrap and persistence

## Installed runtime

The Skill entry point is a self-contained Node.js ESM client. Import it by the absolute directory containing the active `SKILL.md`:

```js
const { connect } = await import("<ab-skill-root>/scripts/ab-client.mjs");
const agent = await connect();
```

Do not import `@hanger-source/ab/agent` from the task working directory. Node package resolution is deliberately not part of the Skill contract. `ab-client.mjs` selects the native runtime packaged with the same Skill and privately launches it only when its current-user Unix socket is unavailable.

The Skill client owns the product paths. It always binds the current user's fixed AB runtime directory, application-data directory, and `chrome-profile`; inherited `AB_RUNTIME_DIR`, `AB_DATA_DIR`, `AB_PROFILE_DIR`, or `AB_CHROME_PATH` development variables do not redirect Agent browser work. Programmatic Core SDK tests may use those variables, but the installed Agent Skill may not.

If the client or packaged runtime is missing, the Skill installation is incomplete. Stop with that exact diagnosis; do not inspect source, `.d.ts`, workspace `node_modules`, or another global package to guess a replacement.

AB intentionally has no start, stop, restart, daemon, status, or profile CLI. The lifecycle is part of `connect()`:

- an existing matching daemon is reused;
- an idle mismatched daemon yields to the exact SDK build;
- a mismatched daemon with another client or dispatched mutation fails explicitly;
- Chrome persists independently of the Node process;
- a replacement daemon reattaches only the Chrome identity owned by AB's fixed profile.

There is one AB-specific headed Chrome profile. Cookies and storage survive Node sessions and Agent tasks. AB does not attach to the user's ordinary Chrome profile and does not switch to a temporary profile when the fixed profile is unavailable.

## Persistent JavaScript session

For an interactive task, use one Node REPL MCP Tool. It keeps one dedicated JavaScript kernel alive across Tool calls, so `agent`, tabs, observations, and resources remain available without generating a new script for every operation. Ending or resetting that kernel does not end Chrome.

Host selection is explicit:

- **Codex:** use the built-in `node_repl` already exposed by Codex. Do not launch or register `host/node-repl` as a duplicate;
- **other Agent hosts:** configure the Apache-2.0 Qwen `node-repl-mcp` as a standard stdio MCP server before invoking this Skill. Use a pinned installed package or the built `host/node-repl/dist/index.js`; the Skill does not install or start it;
- **host without MCP support:** use a normal Node.js ESM file for a reproducible batch. An ordinary terminal REPL is a diagnostic fallback, not the interactive Agent contract.

Both managed hosts must expose persistent top-level bindings and the `nodeRepl.write()` / `nodeRepl.emitImage()` content API. The host owns JavaScript cell parsing, top-level await, module loading, cancellation and MCP content framing. It does not own Chrome, CDP, AB observations or browser resources.

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

`chrome.source` says whether this runtime launched or reattached the AB-owned Chrome. It does not make the profile temporary or caller-owned.

When `connect()` launches a runtime, the SDK waits for that exact startup attempt to publish `ready` or a structured `failed` state before opening the protocol socket. A bound Unix socket is not treated as browser readiness. Profile ownership and Chrome launch failures therefore surface with their Rust `kind` and `stage`, rather than being rewritten as a generic startup timeout.

When a different packaged build connects to an idle daemon, the old daemon can yield its socket and the new build reattaches the same managed Chrome. Handover is refused while another client or dispatched mutation makes replacement unsafe. Do not kill the daemon or remove socket/profile files to solve normal handover.

## Managed Node REPL pattern

Call the persistent JavaScript Tool repeatedly. The first cell imports the version-matched client by absolute path:

```js
const { connect } = await import("<ab-skill-root>/scripts/ab-client.mjs");
const agent = await connect();
let tabs = await browser.tabs.list();
nodeRepl.write(tabs);
```

AB uses the selected host's mature Node REPL MCP server; it does not implement another JavaScript parser or browser server. If a cell outlives the Tool's yield interval, keep its returned cell id and use that provider's wait or cancel Tool. Never submit another cell while one is active. Tool yield, JavaScript execution timeout and AB operation `timeoutMs` are separate limits.

Use a `.mjs` file for a non-interactive reproducible batch. Both forms use the same SDK and Rust daemon.

## Custom Presenter

A host can provide typed `presentText` and `presentImage` functions to `connect({ presenter })`. Documentation is marked read only after text presentation succeeds. AX baseline and screenshot use follow the same success boundary. Do not implement a Presenter that silently discards content while reporting success.
