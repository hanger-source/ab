# Client target ownership and popup expectation

## 问题

AB 的 daemon、Chrome 和固定 profile 天生允许多个 Agent client 共享。此前 Resource、observation、element、artifact 已按 client 隔离，但 page target 只有全局发现和按 target id 调度，没有“谁可以改变这个 tab”的 server-side 事实。因此两个 client 都能对同一 target 导航、点击、evaluate 或关闭；动作另开 target 时，调用方只能在动作前后比较 `tabs.list()`，既可能错过瞬时 target，也不能把 child 的 identity 与准确 opener 绑定。

小红书实际操作暴露了两种表象：动作另开作者页但动作结果没有 child target；并行 client 可以让另一个任务仍在使用的 tab 消失。外部反馈不能证明具体哪个进程关闭了 target，也不能证明 SDK 句柄曾被静默重定向；但协议和 Runtime 源码能够证明更底层的不变量确实缺失：任何已连接 client 都具备修改或关闭任意已发现 target 的能力。

这个问题不属于 AXState、动作 settle 或站点控件兼容。它属于 BrowserOwner 对共享 Chrome 中可变 target 的并发所有权。

## 成熟实现提供的共同约束

本轮没有把某一个项目的 API 原样搬入 AB，而是从多个独立实现提取共同的不变量：

| 参考 | 可复核的处理 | AB 的判断 |
| --- | --- | --- |
| Codex Browser public runtime `26.831.20005` | Browser/Tab 是宿主拥有的 Tool 对象；tab 丢失后要求丢弃旧绑定重新取得，不允许悄悄换 target；`expectNavigation(action)` 把 watcher 建立在 action 前；tab 的 URL 与 DOM observation 分离 | 保留“显式 tab identity”和“观察独立于动作”；吸收 action 前建立 expectation 的形式，不复制私有宿主生命周期 |
| Playwright `9e3157b` | Page/BrowserContext 维护 popup、close、crash 生命周期；popup 在 child 初始化完成后发布；导航 expectation 通过 action-scoped signal barrier 在输入前武装 | popup 必须 race-free 且返回 ready child；target 消失必须明确失败 |
| Puppeteer `5ecc694` | `PageEvent.Popup` 和 BrowserContext target 生命周期是独立事件；导航示例使用 `Promise.all([waitForNavigation(), click()])` | event waiter 与 input dispatch 是两个责任，不把 popup 猜测塞进 click result |
| agent-browser `eb05921` | stable tab id；严格 pin-tab 在绑定 target 消失时返回 `tab_gone`，不会收养另一个 tab | AB 不能用 active/last/同 URL target 替代调用方选定的 target |
| browser-harness `3586ec2` | 多个 named daemon 共享一个 browser 时各自保留 dedicated target，源码明确避免共同 attach first page 后互相争抢 | 共享 Chrome 不等于共享 mutation authority |
| OpenChrome `a0bd63a` | 显式 TargetOwnershipRegistry、TargetLeaseRegistry、冲突、cleanup 与 closed tombstone | 租约是成熟的 server-side 模型；AB 只取本产品所需的 client-target lease，不复制其 session/queue/TTL 系统 |
| browser-use `67e7194` | SessionManager 跟踪 target attach/detach 并分发 tab closed；同时会在 focus 丢失后自动选择其他 target 或创建 fallback tab | 吸收生命周期集中管理；拒绝自动换 target，因为它会把并发干预变成无声 target drift |
| Stagehand `4d88741` | deterministic Page/Locator 与 AI `act/observe/extract` 分层 | 证明 Agent 语义与浏览器生命周期可分层，但没有解决固定 profile 多 client 所有权，不作为本轮实现来源 |

这些项目的 API 不完全一致，但共同否定两种做法：依赖数组顺序猜新 tab，以及 target 消失后自动找一个“差不多”的页面继续。

### Codex Browser 同场景操作

在当前 Codex Browser runtime 中打开一份本地页面，页面只有 `<a target="_blank">Open child</a>`。通过它的 `playwright.domSnapshot()` 可以直接读到语义链接；Locator `click()` 快速完成并返回 `undefined`，没有把页面后果伪装成动作结果。紧接着执行 `tabs.list()` 时仍只有 source target；等待一秒后再次 list 才出现 child。

这个体验同时给出正反两条证据：Codex Browser 的“确定性 Locator + 动作与观察分开”值得作为 Agent 操作面标杆；但它的公开 API 在 popup 上仍要求调用方自行发现 child，并存在立即 list 尚不可见的窗口。因此 AB 不复制这处行为，而采用 Playwright/Puppeteer 已成熟的 pre-armed event expectation。对照结束后只关闭本轮创建的 source/child tab。

同一 runtime 另做了 stale-handle 对照：新建临时 `about:blank` tab，取得一次 DOM snapshot 后关闭，再通过原对象观察。Codex Browser 没有转到其他可用 tab，而是立即返回 `Tab 8 is not part of browser session ...`。这验证了它在 Agent 体验上最值得保留的不是某个方法名，而是“对象身份失效时明确失败、重新选择必须由调用方显式发生”。AB 的 `target_closed` / `target_in_use` / `target_not_acquired` 以及禁止自动 active/last target fallback 与这个效果一致。临时 tab 已在对照中关闭。

## 采用的模型

### 发现与修改权限分离

所有 client 都可以 `tabs.list/get` 并进行只读观察。返回的 `Tab.ownership` 是相对于当前 client 的事实：

- `available`：没有活跃 client 持有 mutation lease；
- `owned`：当前 client 持有 lease；
- `other`：另一个活跃 client 持有 lease。

`tabs.open()` 创建的 target 原子归创建 client 所有。复用现有 `available` target 时必须调用 `tabs.acquire(targetId)`；这不是内容所有权或关闭授权，只是告诉 Runtime 后续 mutation 应归哪个活跃 client。另一个 client 获取同一 target 时返回 `target_in_use`，不等待、不重试、不抢占。

导航、activate、reload/history、evaluate、CUA、ref/Locator/ElementHandle mutation、close，以及可能改变浏览器状态的 CDP、dialog response、file chooser 和 init script 都由 Runtime 在 dispatch 前检查 lease。观察、selector 读取和普通事件监听保持可共享。

没有 operation in flight 时，正常 `disconnect()` 先以内部 `client.release` 请求让 Rust 清理该 client 的 Resource/observation/element/artifact 和 target leases，收到确认后才关闭 transport；有未完成 operation 或异常 EOF 时仍由 transport interruption 取消/结算请求，再执行同一幂等清理。tab 和 Chrome 保留，下一 client 可以从真实 `tabs.list()` 重新选择并显式 acquire。第一批不提供单个 target 的 `release()`：在 client 仍持有与 target 关联的可变 Resource 时单独释放 lease，会制造 Resource owner 与 mutation owner 分裂；任务结束使用 `disconnect()` 是清晰的生命周期边界。

### Popup 是 opener-scoped Resource

popup watcher 订阅 Rust SessionManager 的 target lifecycle，并在触发动作前建立。它只发布 `openerId` 等于准确 source target 的 ready root page target。child target 自动继承 opener 的 mutation lease，因此其他 client 不能抢在 watcher 返回前取得它。

Core 提供 `tab.watchPopups()`；Agent facade 提供：

```ts
const popup = await tab.expectPopup(
  () => tab.playwright.getByRole("link", { name: "Open", exact: true }).click(),
  { timeoutMs: 10_000 },
);
```

这是“预先建立 Resource → 执行动作 → 等准确 child → 返回 Tab”的组合，不是让 click 猜页面后果。动作可能不产生 popup；超时就报告 expectation 没满足，不改用最后一个 tab。

## 明确不采用

- 不向 `AXState` 添加 URL。URL 属于 Tab/ActionResult；observation 继续表达 document/viewport/AX identity。
- 不恢复 action 后自动 AX observation。动作事实、期待的生命周期事实和下一次模型观察仍分开。
- 不新增 `scrollIntoViewIfNeeded()` 别名来迎合一次调用错误；AB 的公开方法是 `scrollIntoView()`，Codex Browser 的公开 Locator 也没有该别名。
- 不把每个 `complete:false` 当故障。frame/source gap 必须保留真实 completeness，不能为“看起来成功”抹平。
- 不要求每次动作后 fresh `tabs.list()` 对账。server-side lease 和 pre-armed popup watcher正是为了删除这种调用纪律。
- 不自动切换到 active、last、相同 URL 或同 opener 的另一个 target。
- 不引入站点 URL、页面文字、固定坐标、benchmark id 或针对某个页面的分支。
- 不同时加入 `expectNavigation()`。AB 已有 ActionResult 的 action-owned navigation facts 与显式 `waitForURL()/waitForLoadState()`；popup 是动作后无法通过原 target 重读而恢复的 identity gap。只有独立证据证明 same-URL/reload race 仍缺失公共能力时，再单独决定 navigation expectation。

## 可证伪场景

`test/ab/scenarios/client-target-ownership/` 使用真实 Chrome、真实 Rust daemon 和两个独立 OS client：

1. client A 打开 source target，并获得 `owned`；
2. client B 能 list 到它，但看到 `other`，显式 acquire 必须得到 `target_in_use`；
3. client A 通过真实 `<a target="_blank">` 和 `expectPopup()` 得到准确 child，child 的 opener 和 inherited ownership 必须匹配；
4. client A 断开后不关闭 source；
5. client B 才能 acquire preserved source、执行 mutation 并关闭。

它会在以下现实错误下失败：租约只存在于 SDK 内存、check 与 acquire 非原子、popup 订阅晚于动作、child 不继承 opener、client 断开不释放、Runtime 用 active tab 替代目标。它不依赖小红书、CRM、fixture 答案或 AX 文案。

首次运行因 TypeScript generated protocol 与刚编译的 Rust source digest 不同而触发 `daemon_version_mismatch`；重新生成 protocol 后，同一场景在独立临时 profile 中完成。build mismatch 的硬失败是正确版本边界，不是浏览器行为失败。

完整 live suite 的首个持久化场景随后揭示：原 `disconnect()` 只调用 `socket.end()` 就返回，而 Rust 在读到 EOF 后才释放 lease；紧接着连接的新 client 可以短暂收到 `target_in_use`。没有在测试中增加 sleep 或 acquire retry，而是把 graceful disconnect 收敛为 server-acknowledged cleanup；EOF 只保留为崩溃兜底。这一变化属于 target ownership 生命周期本身，不属于测试适配。
