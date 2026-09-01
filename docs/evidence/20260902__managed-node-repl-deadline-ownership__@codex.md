# 托管 Node REPL 与 AB Deadline 所有权

## 触发现象

真实登录 SPA 的 detail-to-profile 导航中，一个 Agent 在同一调用里执行短 ref click 并请求完整 post-action AX state。页面已经进入目标地址，但托管 JavaScript Tool 在 30 秒时报告 `js execution timed out; kernel reset, rerun your request`。重新导入 Skill client 后，原 Chrome、tab、登录态和目标 URL 仍然存在，只有该 Tool 的 JavaScript bindings 丢失。

这个现象不是站点规则，也不能说明 pointer input 失败。它暴露的是两个独立 owner 使用了相同默认 deadline：

```text
Node REPL timeout_ms = 30_000
AB request timeoutMs = 30_000
```

外层 deadline 抢先时，Codex native Node REPL 终止并重建 kernel；AB daemon 与 Chrome 是独立进程，所以继续存活。Agent 因此看不到 AB 本应返回的结构化 `timeout`、`outcome_unknown` 或 post-action observation failure。

## 排除的错误归因

`write: "state"` 不承诺等待页面达到通用 network-idle 或业务稳定。当前 Rust ActionTransaction 的动作信号等待最多 2 秒，post-action rendering settle 最多 450ms；之后才执行 observation capture。完整 AX capture、CDP 响应或 SDK request 可以继续消费同一个 AB request deadline，但不能把整段描述成“点击后等待网络安静”。

这也不是 Qwen Node REPL 的超时行为。项目内 Apache-2.0 Qwen implementation 默认允许 10 分钟，且 timeout/cancellation 只停止当前 cell、保留 kernel。复现宿主使用的是 Codex native `node_repl` binary；该 binary 的公开 Tool description 明确给出 30 秒默认值并在执行超时时重置 kernel。

## 合同

三个时间参数属于不同层：

- Tool `timeout_ms`：整个 JavaScript cell 的外层执行期限；
- AB `timeoutMs`：单个 connect、action、observation、wait 或 resource operation 的内层期限；
- Tool `yield_time_ms`：何时把仍在运行的 cell 交还为可等待 id，不延长任何 deadline。

托管执行必须满足：

```text
outer cell deadline
  >= sum(sequential inner AB deadlines)
  + structured-return/presentation reserve
```

一个使用 AB 默认 30 秒的普通单操作 cell，外层使用至少 60 秒。一个 cell 内存在多个已决定的顺序操作时，每个操作使用显式 `timeoutMs`，外层按其总和再留 10 秒；若中间需要 Agent 判断，就在该点结束 cell，而不是把后续未知工作一起包进同一个 deadline。

这个规则的目的不是让慢操作无限等待。内层 AB 仍按原 deadline 结束并保留取消、`outcome_unknown` 和 side-effect reconciliation 语义；外层只负责给它足够时间把真实结果送回 Agent。若 mutation 的结果仍不确定，恢复后读取当前 tab 状态，不能自动重放。

## 公共 Skill 变化

主 Skill 现在把 Qwen 描述为“宿主尚无兼容 Node REPL 时的公开实现”，不再假定 Codex 以外的所有宿主都必然使用 Qwen。已经提供兼容 managed Node REPL 的宿主继续使用自身选定的 Tool，不能同时注册第二个 kernel。

主 Skill 与 bootstrap topic 都要求 Agent 在 Tool call 上显式设置外层 `timeout_ms`。这条规则位于 Node REPL/AB 组合边界，不修改 Rust ActionTransaction、AX capture、Pointer Action、站点等待或浏览器 profile 生命周期。

## 明确拒绝

- 不缩短 AB 默认 deadline 来给宿主默认值偷偷让路；
- 不把 action `write` 删除或强制拆成站点专用序列；
- 不延长 Rust 的 signal settle 或 rendering settle；
- 不增加 URL、selector、用户名、页面组件或 benchmark task 特例；
- 不修改 DSH、Codex 或其他宿主的安装目录；
- 不用 kernel 重置后的页面已导航，倒推原 mutation 可以安全重放。
