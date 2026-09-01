# Rust Browser Server boundary

## 唯一运行主链

```text
Agent
  -> TypeScript SDK
  -> Rust Browser Server
  -> CDP
  -> Chrome
```

目标运行时只有一个 Server，并且由 Rust 编译成原生可执行程序。没有 Node Server，没有 WASM engine，也没有 native/WASM 双构建。

TypeScript SDK 是客户端：它把 Codex-style 的 AX、locator、DOM/CUA、CDP 等易用 API 转成对 Rust Server 的请求。它不连接第二份浏览器、不计算第二份 snapshot，也不保存与 Rust Server 并行的 ref 或 Tab 状态。

## Rust Server 拥有的责任

- 启动或连接 Chrome，管理固定 profile 和 CDP 连接。
- 管理 Browser、Context、Tab、Frame、target 与 session 的真实身份和生命周期。
- 获取 AX/DOM observation，生成 snapshot、ref、revision 和 diff。
- 把 ref 解析到确定的 frame/node/坐标，执行 hit-test 与 action。
- 处理 dialog、download、network、console、OOPIF、断线和动作失败。
- 向 TypeScript SDK 返回结构化结果和稳定错误。

## 从 agent-browser 采用的实现主链

| 文件 | 采用价值 | 进入 Rust Server 时要处理的边界 |
|---|---|---|
| `snapshot.rs` | AX/DOM 合并、interactive 过滤、ref 分配和 compact render | 接入 Server 的 Tab/Frame/session owner |
| `element.rs` | `RefMap`、ref 到 node/object/坐标的解析 | 统一使用 Server 的 CDP client 与 revision 状态 |
| `interaction.rs` | 输入序列、hit-target、dialog 中断和动作后验证 | 保持原动作和验证语义，不在 TypeScript 侧另写动作路径 |
| `diff.rs` | snapshot 增量与截图 diff | 由 Rust Server 保存与页面 revision 绑定的基线 |
| `cdp/` | protocol types、client、target/session transport | 并入 Rust Server 的唯一 CDP 连接层 |
| `browser.rs`、`state.rs`、`daemon.rs` | profile、进程、session 和 daemon 生命周期 | 结合 AB 的隐藏 daemon、多 client 与固定 Unix socket 整理，不原样复制 CLI |

完整快照已包含 `build.rs`、CDP protocol JSON、`cli/src`、tests 和被 `include_str!` 引用的资源，因此可以从真实 Rust 构建链实现 Server。

## 明确不采用

- 不建立 Node Server。
- 不把 Rust 编译成 WASM。
- 不让 TypeScript SDK 重写 snapshot/ref/hit-test/action 算法。
- 不让 SDK 和 Rust Server 分别维护 Tab、Frame、ref 或 revision 状态。
- 不把 Codex Browser 的 proprietary service 或 AX WASM 复制进实现；只借鉴它的公开 API 语义和 Skill 编排。

## 第一条真实纵切

```text
TypeScript SDK.snapshot(tab)
  -> Rust Server 定位 tab/session
  -> Rust CDP client 获取 AX/DOM
  -> Rust snapshot/ref/revision
  -> SDK 返回 Agent 可读 observation

TypeScript SDK.click(ref)
  -> Rust Server 校验 revision 并解析 ref
  -> Rust hit-test
  -> Rust CDP input action
  -> 返回动作结果或明确失败
```

这条纵切成立的标准不是“Server 能启动”，而是固定 profile 的真实 Chrome 页面可以通过 SDK 得到稳定 snapshot/ref，并使用该 ref 完成动作；页面变化后旧 ref 会被 revision 机制明确拒绝，而不是由 SDK 重新猜 selector。
