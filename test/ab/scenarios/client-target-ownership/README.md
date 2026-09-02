# Client target ownership and popup inheritance

## Browser boundary

AB deliberately shares one persistent Chrome and default profile across SDK
clients. The shared browser must not imply shared mutation authority.

This scenario keeps one real SDK client connected while a second process tries
to acquire the same live target. It then opens a real `target=_blank` child from
the owned source and finally disconnects the owner so a fresh client can acquire
the preserved source target.

## Observable contract

- a tab created by `tabs.open()` is owned by that client;
- another active client can list it but receives `target_in_use` before any
  mutation or close is dispatched;
- a ready child page inherits the opener's client lease;
- the pre-armed popup expectation returns that exact child identity without a
  before/after `tabs.list()` diff;
- socket disconnect releases leases but preserves ordinary tabs, allowing a
  later client to acquire the source explicitly.

The scenario enters through the self-contained packaged Skill client, uses two
OS processes and a real Chrome target lifecycle. It does not assert registry
layout, fixed delays, site labels, or a test-only protocol.
The design argument is recorded in
`docs/evidence/20260902__client-target-ownership-and-popup-expectation__@codex.md`.
