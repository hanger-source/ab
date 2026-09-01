# Live Browser Control Implementations

本档案关注怎样接管已有浏览器、已有 tab 和真实 profile。项目是否通过 MCP 暴露不重要；重要的是 extension relay、tab/session identity、观察来源、动作失败和连接生命周期。

## Playwright MCP Extension Relay

定位：让完整 Playwright client 通过 Chrome extension 接管已有 Chrome/Edge tab。

底层链路：

```text
Playwright connectOverCDP
  -> local CDP WebSocket endpoint
  -> CDPRelayServer
  -> extension WebSocket command
  -> chrome.tabs / chrome.debugger
  -> existing browser tabs
```

已确认机制：

- relay 为 CDP 和 extension 分配不同随机 WebSocket path，只允许一个 extension 和一个 Playwright CDP client；
- extension 首先上报全部已有 tab，再发送 `extension.initialized`；handshake 完成前 Playwright 的 CDP 流量不会进入空模型；
- BrowserModel 分开维护 known tabs 和 attached tab sessions；`Target.setAutoAttach` 后才给 tab 分配 `pw-tab-N` session；
- child worker/OOPIF 的 sessionId 记录在所属 tab 的 `childSessions`，发送 child command 时保留真实 child sessionId；
- extension 断线会关闭 CDP 连接，WebSocket close 会拒绝全部 extension pending callback；
- browser-level CDP command 因 `chrome.debugger.sendCommand` 必须指定 debuggee，当前实现选择任意已 attach tab 转发，这是 extension provider 的结构性折衷。

源码入口：

- `packages/playwright-core/src/tools/mcp/cdpRelay.ts`
- `packages/playwright-core/src/tools/mcp/cdpRelayV2.ts`
- `packages/playwright-core/src/tools/mcp/browserModel.ts`
- `packages/playwright-core/src/tools/mcp/extensionContextFactory.ts`

## Chrome DevTools MCP

定位：用 Puppeteer 控制 Chrome，同时把 DevTools network/console/performance/memory 能力组织成小工具。

已确认机制：

- `McpPage` 是 per-page state wrapper，集中保存 dialog、snapshot、emulation 和 DevTools metadata；
- `TextSnapshot` 从 Puppeteer accessibility snapshot 构建，节点公共 UID 由 `loaderId + backendNodeId` 映射，因此同一 document 节点可跨 snapshot 复用，消失节点会清理；
- action 先由 UID 找到当前 snapshot 的 AX node/ElementHandle，再走 Puppeteer Locator；不存在或 detached 时明确失败；
- `WaitForHelper` 在动作前监听 CDP `Page.frameStartedNavigating`，动作后等待可能的 navigation，再等待 DOM 连续 100ms 无 mutation；它只提供有限稳定窗口，不声称业务完成；
- network/console collector 以 Page 为作用域，按主 frame navigation 分段，默认返回当前导航，可选择保留最近三次导航；资源有稳定数字 id，可进一步读取详情；
- 大于 2MB 的截图自动落临时文件，network request/response body 也可落独立文件。

源码入口：`src/McpPage.ts`、`src/TextSnapshot.ts`、`src/PageCollector.ts`、`src/WaitForHelper.ts`、`src/tools/input.ts`、`src/tools/screenshot.ts`。

## agent-browser

定位：Rust native daemon 持有 CDP browser/session，CLI 只发送短命令；也可连接已有 CDP browser。

已确认机制：

- tab 对外使用会话内永不复用的 `tN`，可附 label；element ref 使用 `eN`，避免位置索引被误当身份；
- snapshot 直接读 `Accessibility.getFullAXTree`，结合 DOM 扫描补充 cursor/onClick/tabIndex/contenteditable 元素；
- `RefEntry` 保存 backendNodeId、role、name、nth 和 frameId；OOPIF 的 `frameId -> sessionId` 映射参与 AX 读取与元素动作；
- action 默认先用缓存 backendNodeId，失败后会按 role/name/nth 重查 AX tree。这个隐式再定位可能改变目标语义，不能直接照搬；
- 同一个 daemon 执行 batch，避免每个 CLI 命令重启浏览器连接；stream 侧广播 command/result/duration 和 console；
- 连接已有 CDP browser 时不再直接对 `Target.getTargets()` 返回的第一个 page 启用 domain；它先用有界 `Runtime.evaluate` 探测 renderer 是否仍存活，避免 Memory Saver discarded tab 让 connect 卡在 `Page.enable`；
- 当前实现会在第一个 page 不响应时并行寻找其他 live page，全部 discarded 时才显式 activate 第一个。这证明 renderer liveness 是 target metadata 之外的独立事实，但“自动换一个 tab”仍是它自己的产品策略；
- daemon idle timeout、CLI IPC timeout 和浏览器动作 timeout 有显式层级，并有测试避免 housekeeping tick 无限延后 idle deadline；默认 daemon idle timeout 统一经 CLI/MCP 参数进入同一 parser/runtime。

源码入口：`cli/src/native/snapshot.rs`、`element.rs`、`interaction.rs`、`browser.rs`、`daemon.rs`、`stream/`、`cdp/client.rs`。

## OpenChrome

定位：连接真实 Chrome，围绕 target ownership、并发、可观察 trace 和多种页面观察模式构建 server。

已确认机制：

- `TargetOwnershipRegistry` 和 lease registry 显式记录 target 属于哪个 session/worker；
- `TargetCommandQueueManager` 对同一 target 串行、不同 target 并行；target close 后保留 closed queue tombstone，使竞态中的后续命令立即失败；reconcile 再清理不存活 target；
- trace recorder 给事件分配 sequence，storage 使用 JSONL body、meta 文件、锁和原子写；meta 写失败会回滚新建状态；
- compact DOM 直接暴露 backendNodeId，同时另有 ref manager；其 ref relocation 同样属于需要审慎评估的语义恢复。

源码入口：`src/session/target-registry.ts`、`target-lease-registry.ts`、`target-command-queue.ts`、`src/core/trace/recorder.ts`、`storage.ts`、`src/dom/dom-serializer.ts`。

## chrome-cdp-skill

定位：很薄的 per-tab CDP daemon。每个目标 tab 维持一个 browser WebSocket 和 attached session，命令通过 daemon 复用连接。

已确认机制：targetId 用唯一前缀选择；daemon 在 target destroyed/detached 或 idle 后退出；AX snapshot、eval、screenshot、navigation、network performance、DOM/coordinate click 都直接映射 CDP。它的价值是生命周期极小且可看懂，不是功能覆盖广。

## Browser Harness Runtime

定位：通过一个本地 daemon 长期连接已有 Chrome 的 browser-level CDP endpoint，短命 Python runner 经本地 IPC 复用该连接。本档案只研究这个运行时，不研究其上层自动生成 helper 或站点知识的机制。

已确认机制：

- daemon 只建立一个 browser WebSocket，再以 flattened `Target.attachToTarget` 得到当前 page session；Chrome 144+ 每个新 CDP connection 都可能再次要求用户授权，因此近期修复选择等待同一连接，而不是失败后不断重连；
- 当前状态同时保存 `target_id` 和 `session`。切 tab 时 attach 新 session，并行对新 session 启用 Page/DOM/Runtime/Network，同时对旧 session 关闭 Network，避免后台 tab 继续污染全局事件 buffer；
- event tap 保存原始 `method`、`params` 和 `session_id`。`wait_for_network_idle` 消费事件时再次按当前 session 过滤；相关回归测试固定了切 tab 后 Network domain 未启用、旧 session 事件污染和串行 enable 超过 IPC 预算的问题；
- browser-level `Target.*` command 明确不携带 page session；`current_tab` 必须用保存的 targetId 调 `Target.getTargetInfo`，不能省略 targetId 后误读 browser target；
- POSIX IPC 使用权限收紧的 Unix socket；Windows loopback TCP 使用随机 token，并用原子 port-file 避免并发读取半写状态。

源码入口：`src/browser_harness/daemon.py`、`helpers.py`、`_ipc.py`、`run.py`、`tests/unit/test_daemon.py`、`tests/unit/test_helpers.py`。

边界同样明确：启动时默认 attach 第一个真实 page，stale current session 时会重新 attach 第一个 page；`switch_tab` 会激活目标 tab；事件存储是一个有上限的全局 deque，`drain_events` 是破坏性读取。这些产品选择会改变目标、焦点或多个消费者的观测事实，不应进入 AB 的默认语义。可比较的是“一个 browser connection，多 target session”和 session-scoped domain/event lifecycle。

## PinchTab

定位：Go daemon 管理 Chromium instance 和 tab，以 HTTP/CLI 暴露 snapshot、action、network、console、screenshot 等能力。

已确认机制：

- `TabExecutor` 用全局 semaphore 限制总并行度，同时给每个 tab 建独立 mutex；同 tab 串行、不同 tab 可并行，等待执行槽和等待 tab lock 都服从调用 context；
- tab lock 是独立 TTL ownership：owner 可续占自己的 tab，其他 owner 在 TTL 内硬失败；它没有混入动作 selector 或浏览器连接状态；
- `TabManager` 为每个 CDP target 保存 context、cancel、CDP id、created/last-used、console 状态，并在 tab 关闭时统一清理 executor、network、route、log 等状态；
- AX snapshot 逐 frame 调 `Accessibility.getFullAXTree`，先处理 child frame，再合并 root，避免 root 的 pierced node 抢先写入错误 frame identity；ref 保存 backendNodeId 和 frame metadata；
- tab create 与初始 navigate 使用不同硬 timeout；新 tab 的 network capture 在 navigate 前开始，避免首屏事实天然缺失；
- element resolution 明确区分 selector-no-match 与 transport/internal error，但文本 selector 内含 leaf-most/fuzzy 策略，便利性会带来目标语义推断。

源码入口：`internal/bridge/tabs/tab_executor.go`、`tabs/lock.go`、`tab_manager.go`、`tab_lookup.go`、`observe/snapshot.go`、`action_resolve.go`。

边界：per-tab queue、TTL ownership、首屏前置采集和 frame-aware snapshot 是强底座机制；空 tabId 时选择 recent/current tab、自动 adopt、模糊文本匹配属于 PinchTab 产品策略，不能作为 AB 默认路由语义。

## mcp-chrome

定位：Chrome extension 通过 Native Messaging Host 启动本地 server，并把 MCP tool request 转给 extension 执行。

已确认机制：

- Native Messaging Host 实现 Chrome 原生的 4-byte little-endian 长度帧，限制单消息 16MB，并限制单次 readable tick 处理数量，避免输入流长循环占死进程；
- host 的 request 使用 UUID 和 pending map；每个 request 有 timeout，收到 `responseToRequestId` 后清 timer 并删除；stdin end/error 会拒绝全部 pending；
- extension 对 native port 的“对象已创建”和“server 已运行”分开：只有收到 `SERVER_STARTED` 确认才重置 reconnect 状态；port 立即断开不会被误报为 running；
- 自动连接使用单一 in-flight ensure promise、指数退避+jitter、快速重试上限和 cooldown；手动 disconnect 明确关闭 auto-connect；
- MV3 keepalive 使用 tagged reference count，native-host 与其他长期任务可独立 acquire/release，底层 offscreen keepalive 只在至少一个 owner 持有时存活；
- server status 持久化在 storage，并与 `nativePort !== null` 分开返回，因此 UI 可区分历史状态和当前 transport。

源码入口：`app/native-server/src/native-messaging-host.ts`、`app/chrome-extension/entrypoints/background/native-host.ts`、`keepalive-manager.ts`。

边界：Native Messaging 的 framing、浏览器启动本地进程和 MV3 keepalive 都不进入 AB。可比较的是连接确认与 pending cleanup；AB transport 已确定为 SDK 自动拉起 Rust daemon 后连接 Unix socket。
