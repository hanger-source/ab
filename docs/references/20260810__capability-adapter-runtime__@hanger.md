# Browser Capability Adapter Runtime

本档案研究浏览器原语怎样被组织成可复用的站点能力模块。它不研究自然语言规划、模型调用、提示词或任务记忆；重点是 adapter 的加载边界、浏览器会话注入、目标身份、并发、执行结果与运行时生命周期。

## OpenCLI 的定位

OpenCLI 同时提供两层能力：

```text
browser command / site adapter
  -> shared IPage runtime
  -> BrowserBridge -> local daemon -> extension -> existing Chrome profile
  -> CDPBridge -> direct CDP endpoint -> Electron / inspectable target
```

它不是 Playwright binding。扩展路径用 daemon 和 `chrome.debugger` 接管已有 Chrome profile；直接 CDP 路径自己维护 WebSocket request id、pending map、event listener 与 page wrapper。站点 adapter 是普通 TypeScript/JavaScript 模块，声明 command metadata，并在执行时得到同一个 `IPage`，因此 adapter 没有自己的浏览器协议实现。

源码入口：`src/runtime.ts`、`src/registry.ts`、`src/browser/bridge.ts`、`src/browser/cdp.ts`、`docs/developer/ts-adapter.md`。

## Profile 与目标身份

扩展为每个 browser profile 建立独立连接，daemon 用 `contextId` 路由。显式 profile 是硬要求，离线时失败；没有显式要求且连接了多个 profile 时返回 `profile_required`，不从多个候选中猜。持久化 default profile 只被当成 preference：它失效而仅有一个 profile 在线时，daemon 会改用唯一在线 profile，并记录 warning。这是 OpenCLI 的产品策略，不应被误写成普遍安全的路由规则。

跨 daemon/extension 的 page identity 是 CDP `targetId`。extension 内部维护 `targetId <-> tabId` 映射；cache miss 时用 `chrome.debugger.getTargets()` 全量刷新，仍找不到就以 stale page identity 硬失败。tab 关闭时映射被显式驱逐。

源码入口：`src/browser/profile.ts`、`src/daemon-utils.ts`、`src/daemon.ts`、`extension/src/identity.ts`。

## 两层租约不是同一个问题

OpenCLI 把浏览器资源归属和逻辑写操作互斥分成两层：

1. extension 的 `TargetLease` 把 `(surface, session)` 绑定到 owned tab 或 borrowed user tab，并记录 ownership、lifecycle、window role 和 preferred tab；
2. daemon 的 `SessionLeaseRegistry` 以 `(contextId, surface, session)` 为键，只仲裁 persistent adapter 的 write command。read、ephemeral session 和普通 browser surface 不被阻塞。

写租约跨越一个完整 CLI command run，而不是单次 `exec`。同一 runId 的短命令持续 heartbeat；另一 runId 同时写入时快速返回 `session_busy`，并给出持有者、PID 和持有时长。TTL 只回收死亡 holder；若 holder 仍有 pending work，即使超过 TTL 也不被抢占。

extension 的 tab/window/group 数字 id 只保存到 `chrome.storage.session`。它允许 MV3 worker 重启后恢复，但在 extension reload、update 或 browser restart 后清空；源码明确禁止把可能被复用的运行时 id 当成跨浏览器重启的 durable identity。startup recovery 完成前，alarm、tab/window remove 等会写 registry 的 handler 都等待 `workerReady`，避免空内存状态覆盖持久快照。

源码入口：`src/session-lease.ts`、`src/daemon.ts`、`extension/src/background.ts`；对应测试覆盖 concurrent writer、worker restart、idle alarm、stale local registry 和用户 tab 不被收编。

## 命令结果有三种确定性

daemon 和 extension 使用同一 command id 区分 transport retry 与新的语义尝试：

- 同 id 尚在 daemon pending 中时，重复请求附着到同一执行，不重复 dispatch；
- extension journal 中同 id 正在执行时，重复 delivery 复用同一 promise；完成且结果可记录时直接 replay；
- worker 在 `started` 与 `done` 之间死亡时返回 `command_lost`；结果过大未保存时返回 `result_evicted`；dispatch 后断线或 timeout 返回 `command_result_unknown`，并明确禁止盲目重跑写操作。

只有确定发生在页面代码执行前的 attach/tab 错误，client 才用新 id 做一次 semantic retry。transport retry 保留原 id；未知结果不自动重试。所有 hop 共享 absolute `deadlineAt`，extension 的 CDP deadline从剩余预算推导，而不是每层重新开始计时。

这套模型比“连接失败就重试”更精确：一次浏览器动作可能成功、失败或结果未知。第三种状态必须进入公共错误契约，否则重试会把一次写操作变成两次。

源码入口：`src/browser/daemon-client.ts`、`src/daemon.ts`、`extension/src/journal.ts`、`extension/src/journal.test.ts`。

## Adapter 边界

adapter 通过 registry 声明 `site/name`、参数、read/write、browser requirement、pre-navigation 和 ephemeral/persistent site session。`normalizeCommand()` 把 strategy 展开成具体 runtime fields；执行路径读取的是标准化后的 `browser`、`navigateBefore` 和 session metadata，不在每个 adapter 中重新解释策略。

普通模块、用户目录模块和 packaged module 进入同一个 registry。代码还会检测用户 adapter 是否遮蔽同名 packaged adapter，使“为什么新版逻辑没有生效”成为可诊断状态。`browserSession()` 只负责创建 page、运行回调和 finally 关闭 factory；站点业务仍在 adapter 函数中，不进入 extension provider。

这对 AB 的价值不是恢复 App Hub，而是验证一种更窄的边界：可复用站点能力可以是核心 SDK 之外的普通模块，依赖稳定的 browser handle 和生命周期注入；它不需要在扩展中拥有 registry、设置页、业务 tab group 或第二套协议。

## 不应照搬的部分

OpenCLI 同时存在会压缩证据的 convenience：

- click 在 CDP hit-test 不通过时会尝试 DOM `el.click()`，随后还可能再次尝试 native click；成功结果虽然返回 `click_method`，但一个调用中已经切换语义；
- numeric ref resolver 会基于 fingerprint 自动接受 soft drift 或重新识别另一节点；
- extension attach 代码会先强制 detach，再重试 attach；
- network capture 不可用时，page runtime 可降级到注入 fetch/XHR interceptor，且只 warning “可能漏接口”。

这些机制能提高命令表面成功率，却不符合 AB 当前强调的显式 world、显式动作语义和不伪装完整观测。它们作为反例保留，不进入能力候选。

源码入口：`src/browser/base-page.ts`、`src/browser/target-resolver.ts`、`extension/src/cdp.ts`、`src/browser/network-interceptor.ts`、`src/browser/page.ts`。

## 对 AB 的候选问题

源码只形成后续实验问题，不直接产生产品改动：

- relay 在“请求已发送但 extension 结果丢失”时，能否区分未执行、已执行和结果未知；
- 多 client 对同一个显式 tab 做 write 时，是否需要与 tab ownership 分离的 command-run lease；
- service worker 重启恢复的数据中，哪些 id 只在 browser session 内有效，是否有跨 reload 误认风险；
- SDK 外部可复用模块是否只需标准 browser/runtime context，而不需要扩展内 App runtime；
- 相同 command id 的重复 delivery 是否可能重复执行页面写操作。

只有这些问题在 AB 当前链路中被真实复现，才进入对照实验。
