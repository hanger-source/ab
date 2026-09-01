# Third-party notices

`ab-runtime` links modified native modules from
[agent-browser](https://github.com/vercel-labs/agent-browser), version 0.35.1,
upstream commit `fbd046c23a2c1156891bda294aaaee715c23b3f1`, under the Apache License 2.0.

The complete retained source is distributed in this repository at
`server/rust/agent-browser`. AB uses its CDP, Chrome, AX snapshot/ref and
interaction modules; it does not run the upstream CLI, MCP, chat, dashboard or
daemon product shell.
