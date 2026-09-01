# Pointer Action 与异步 SPA ActionTransaction

## 这次变更解决什么

AB 的 semantic click 曾经把“CDP 已发送鼠标事件”当成动作成立。真实页面证明这个判断不够：一次点击可能命中目标的普通祖先、在框架重绘时绑定到已经 detach 的节点，或者已经让 SPA 切换 URL，但 `ActionResult` 和 post-action observation 仍读取旧页面事实。

这次变更不为任何特定站点或 benchmark 增加规则。它收回 Rust Browser Runtime 对 pointer action 和 action effect ordering 的所有权，让 AXRef、Locator、ElementHandle 经过同一条机械事务：

```text
resolve exact browser identity
  → visible / enabled / stable
  → scroll and current content quad
  → strict hit target
  → arm event-time interception
  → re-arm action event receiver at actual dispatch
  → dispatch trusted CDP input once
  → classify browser-owned signals
  → capture optional post-action observation
  → read final Target URL and Frame document generation
```

## 为什么之前多轮没有发现

此前存在三处互相遮蔽的实现：

1. agent-browser 的 click 只做 ref 解析、中心点和一次 CDP input；返回成功只能证明命令发送成功。
2. AB 后加的 `BLOCKER_AT_JS` 同时接受 target descendant 和 target ancestor。点击落到一个覆盖范围很大的普通祖先时也会被判定为合法。
3. 为通过一个人工构造的“零面积 ARIA option + 同文本 presentation div”测试，旧实现又允许把同文本节点视为 pointer proxy。这不是浏览器 identity，也不是可证明的可访问性关系。

于是复杂用例出现 pointer no-op 时，表面看起来像站点 handler、遮罩或组件库问题；显式 `domInvoke("click")` 又能继续任务，使真正缺失的 pointer transaction 没有成为第一责任人。

Git 历史也说明这不是许多小 commit 反复修同一个 bug。独立仓库只有两天历史，关键判断被压在少数大提交里：agent-browser 上游 `688e285` 首次加入的是 dispatch 前一次静态 overlay 检查；AB 的 `12c44bf` 又为一个零面积虚拟 option 测试加入同文本 presentation proxy；当前未提交批次才第一次建立完整 Pointer Action owner。问题不是提交次数，而是 selector resolution、静态 blocker、测试特例和 click transaction 在不同 owner 之间接力，导致每一层都以为下一层会保证真实命中。

在修改 Pointer Action 前，同一 Magento review-list 流程先分别由 AB 与 Codex Browser 执行。AB 两次冷页面的第一次 `Edit` 点击都返回 `cdp.pointer` 成功，但 CDP 事件探针显示 `pointerdown/mousedown/pointerup/mouseup/click` 实际全部落在 `<td>`，第二次重新观察后才进入详情。Codex Browser 通过 Playwright 风格 Locator 在三个冷页面上第一次都进入详情。这个对照把问题从 selector、AX ref 和页面业务 handler 中排除，定位到 hover move 与 button dispatch 之间的 hit-target race。

## 成熟实现参照与取舍

### Playwright

Playwright 的 pointer action 把可见、可用、稳定、滚动、content quad、hit target interceptor 和导航 signal 组织在一次 progress/action transaction 中。它还明确区分 hover 与 click 的事件证据：hover interceptor 监听 `mousemove`，mouse-click interceptor 监听 `pointerdown/pointerup/mousedown/mouseup/click/...`，不会因为 move 当时命中就跳过 button-event 复核。无 delay 的 click 会连续发出 move/down/up，而不是等待每个 input ack 后才发送下一个。对于多击，`Mouse.click()` 按 count 依次发出独立的 down/up pair，使双击先产生 `click(detail=1)`，再产生 `click(detail=2)` 与 `dblclick(detail=2)`。AB 吸收这套 ownership 和 action-specific hit-target ordering，不复制 Playwright 的 BrowserContext、selector protocol 或 Node driver。

### Puppeteer 与 WebDriverIO

Puppeteer 的基本路径是 scroll、clickable point、mouse input；它与 Playwright 独立采用相同的多击事实：`count=N` 生成 N 组 down/up，而不是在一组事件上直接写 `clickCount=N`。WebDriverIO 主要把 element click 交给 WebDriver remote end，并在 intercepted 场景重新滚动。它们证明 content quad、真实 button sequence 和 remote-end actionability 是必要机械事实，但没有提供 AB 所需的 AXRef/Locator/ElementHandle 统一事务。

### agent-browser、browser-use 与 Stagehand

agent-browser 提供了 AB 当前 Rust fork 的 ref/CDP 基础，但原 click 没有完整的 stable/interceptor/action signal transaction。browser-use 保留多处 JavaScript `.click()` 兜底，适合 Agent workflow，不适合作为 AB pointer truth。Stagehand 的强项在上层 Agent/selector/runtime 组合，也不能替代底层 pointer owner。

因此本轮没有照搬某个仓库的一段函数，而是按浏览器事实重新划定 owner；也没有把 DOM activation 藏进 pointer fallback。

### Hover 与 drag 的边界复核

click/double-click 收敛后没有顺势把所有鼠标动作塞进同一个实现。先在真实小红书桌面 feed 上让 Codex Browser 与 AB 执行同一条 `业务合作` 悬停流程：两边都使 `专业号`、`推广合作`、`蒲公英`、`商家入驻`、`MCN入驻` 成为可见菜单项；AB 的菜单项还能继续由 role/name Locator 唯一解析。这个流程没有暴露 AB hover 缺陷，因此没有为了形式统一改写 hover。

源码复核仍保留一个明确边界：AB hover 目前是解析当前中心点后发送一次 trusted `mouseMoved`；Playwright hover 还拥有 visible/stable、scroll、current quad、frame hit target 与 `mousemove` interceptor 的 retry transaction。这个差异只有在真实动态目标证明一次 move 会落空时才进入生产改动，不能仅凭实现不同就复制整套 click owner。

drag 的差异更大。AB 目前分别读取 source/target 中心点，发送 down、十步 move、up；Playwright 把 source 的 move/down 与 target 的 move/up 分成两个 pointer action transaction，并在拖动中间明确禁止会移动鼠标的 locator-handler checkpoint。BrowserGym 对外提供 `drag_and_drop` 原语，但本地 WebArena-Verified Hard、VisualWebArena 与 BrowserGym 任务资料没有给出可直接作为本批产品证据的复杂 drag 任务。现阶段只确认实现风险，不用自建简单拖拽页把它伪装成复杂验收，也不改生产代码。

## 当前实现

### Pointer Action owner

`server/rust/agent-browser/cli/src/native/pointer_action.rs` 负责：

- 对同一个 backend node 做 visible、enabled，并在滚动后由 Rust 通过连续两次 CDP content quad 读取完成 geometry sample；稳定性采样不依赖页面 `requestAnimationFrame`，因此后台或被遮挡 tab 仍由 Browser Runtime 的 deadline 管理；
- 按多种 alignment 滚动并读取当前 `DOM.getContentQuads`；
- 只接受 target 自身、shadow-including descendant 或明确 label/control activation；
- dispatch 前做 preliminary hit-test，在事件捕获阶段以 click 的第一个 trusted button event 复核实际 hit target；`mousemove/pointermove` 只负责 hover preparation，不能完成 click gate；
- button event 命中错误时先阻断整组事件，再重新解析 geometry 并安全重试；已经到达正确目标的输入不重放；
- 仅在 document navigation 已销毁旧 execution context 时把 gate cleanup 失败视为已自然结束，其他 CDP 错误继续暴露。

`server/rust/agent-browser/cli/src/native/element.rs` 中旧的 generic ancestor 和 same-text virtual proxy 已退出。零面积语义节点没有可点击 geometry 时明确失败；调用者应选择控件真正暴露的 semantic target，或在经过视觉观察后显式使用 CUA，而不是由 runtime 猜另一个 DOM 节点。

`server/rust/agent-browser/cli/src/native/interaction.rs` 负责浏览器 button sequence。agent-browser 原实现把 `clickCount=2` 只发成一组 press/release，导致页面直接收到第二次 click 和 dblclick，缺失第一次 click。当前实现按 1..N 发出独立 pair，并把当前 count 保存在 `PendingRelease`；若第 N 次 mousedown 打开原生 dialog，dialog 处理后的 release 仍属于同一个第 N 次输入，不会硬编码回 1。

Pointer gate 的 session 初始化分成两个有先后约束的阶段：`Page.addScriptToEvaluateOnNewDocument` 在 auto-attached OOPIF 仍 paused 时注册，保证新 document 从开始就有 gate；`Runtime.evaluate` 只在 `Runtime.runIfWaitingForDebugger` 之后用于覆盖已经存在的 document。不能在 paused child session 中等待 evaluate，否则 child 等恢复、初始化又等 evaluate，最终让 top-level `load` 死锁。默认 live suite 的 OOPIF 场景曾以 `tab.navigate` 15 秒 deadline 直接证伪了错误顺序。

### Action signal owner

`server/rust/ab-runtime/src/browser/core.rs` 的 `ActionTransaction` 在 action preparation 前订阅浏览器事件，但在真正 input dispatch 的同步 hook 中 `resubscribe()`，因此 preparation 期间的 background traffic 不会被误归因给本次动作。

dispatch 后，同一 receiver 同时处理 file chooser、navigation page signals 和相关 network signals。它不再像旧 `collect_file_chooser()` 一样监听 75ms 后丢弃所有非 chooser 事件。最终结果的事实源按 owner 分开：

- top-level current URL 来自 `SessionManager` 的 Target record；
- frame document generation 来自 Frame registry；
- optional AX diff/state 在 signal settlement 后捕获；
- URL 与 generation 在 observation 完成后最后读取。

这解决了同一时刻 `browser.tabs.list()` 已看到 destination、`ActionResult.navigation` 却仍报告 source URL 的自相矛盾。

## 本轮明确拒绝的做法

- 不增加站点 URL、CSS selector、控件名称或 benchmark task helper；
- 不把 pointer 失败自动改成 DOM `.click()`；
- 不用相同文本推断另一个可点击节点；
- 不把 target 的普通祖先视为命中目标；
- 不因一次 action 返回而宣称保存、购买、审核等业务结果成功；
- 不用固定 sleep 代替 browser event 和最终 identity；
- 不把 deterministic scenario 的绿色外推为 WebArena 全量或任意 SPA 成熟度。

## 证据

### 公开真实 SPA

在 GitHub `microsoft/playwright` issues 列表中点击 issue `#42452`：

- 旧行为曾返回 dispatch completed、`navigation.changed=false`，随后 `tabs.list()` 才显示 `/issues/42452`；
- 新事务在默认 Agent `write: "diff"` 路径中约 1.1 秒完成；
- `ActionResult.navigation.afterUrl` 与立即读取的 tab URL 都是 `/issues/42452`；
- 同一 action 返回的 AX diff 已是 issue 详情，而不是列表页或空变化；
- document generation 保持不变，正确表达 same-document SPA navigation。

### 永久机械场景

`test/ab/scenarios/async-spa-navigation/` 保留 trusted anchor click、`preventDefault()`、异步 route fetch、`history.pushState()`、destination AX render 的完整形状。它会在以下任一回归时失败：事件订阅晚于 dispatch、receiver 被其他 watcher 消费、URL 继续读 stale frame、observation 提前捕获 loading state，或 pointer input 被重放。

首次当前实现结果：action transaction 868ms，navigation changed，source `/` → destination `/destination`，document generation 不变，post-action observation completed 并包含 destination content。

`test/ab/scenarios/pointer-hit-target-layout-shift/` 保存 Magento 失败的最小浏览器边界：trusted `mousemove` 先命中 anchor，页面 bubble listener 随即把 anchor 移到另一位置，旧坐标在 button dispatch 时只剩 table cell。修改前该场景稳定得到 `dispatchMechanism=cdp.pointer` 但 activation `0`；把 click gate 收敛为 Playwright 的 button-event 证据后，同一场景只发生一次 trusted activation 并通过。

`test/ab/scenarios/pointer-click-sequence/` 保存同流程 Codex Browser/AB 对照发现的浏览器输入语义。对同一个 button 执行一次 semantic double click 时，Codex Browser 产生两组 down/up、`click(1)`、`click(2)`、`dblclick(2)`；修改前 AB 只有一组 down/up、`click(2)`、`dblclick(2)`。当前 AB 的真实 CDP 输入得到七个预期 mouse events，全部 `isTrusted=true`。这个场景验证页面收到的事件，不读取 Rust 循环或内部状态。

随后以同一份新源码重新打开 Magento review list 三次。三次冷页面的第一次 semantic `Edit` 点击都直接进入 `/admin/review/product/edit/id/353/`，`ActionResult.navigation.afterUrl`、立即读取的 tab URL 和 AX heading `Edit Review` 一致。Codex Browser 对照的三次第一次点击也都进入详情；其中两次 wrapper 层的 `waitForURL/load` 或紧随其后的 URL 读取曾晚于 DOM 详情状态，说明 post-action URL/observation settlement 是与 pointer 命中相邻但独立的 owner，不能用 pointer 修复掩盖。

### 邻接回归

本轮先单独通过：

- `locator-semantics`；
- `observation-actions`；
- `scenario-active-surface-overlays`；
- `scenario-animated-surface-dismissal`；
- `scenario-async-spa-navigation`。

随后使用正式产品构建 `ab-runtime@0.3.0-alpha.2+b83c680d0b470dd1` 运行完整默认 live suite，19/19 通过：

- daemon/Chrome persistence：`native-smoke`、`multiprocess-persistence`、`profile-lock`；
- package/Skill：`node-package`、`skill-client`；
- session/frame/resource：`oopif-registry-resources-cdp`、`resource-locator-cancel`、`multitab-har`；
- observation/action：`observation-actions`、七个 scenario、`locator-semantics`；
- runtime：`request-cancellation`、`scheduler-concurrency`。

完整 suite 的早期运行并非直接绿色：`oopif-registry-resources-cdp` 的 `tab.navigate` 在 15 秒 deadline 到达后失败。失败暴露出本轮最初把 `Runtime.evaluate` 放在 paused auto-attached child session 的 resume 之前，形成 child 等 resume、session 初始化等 evaluate 的环。将 pointer gate 初始化拆为“paused 时只注册 new-document script → resume → evaluate current document”后，先单独重跑 OOPIF 场景通过，再重跑完整 suite。加入 layout-shift 场景并按 Codex/Playwright 对照收敛 click gate 后，完整 suite 曾达到 18/18。

多击序列修正后的第一次默认 suite 在 `node-package` 停止：Rust daemon 已是 `b83c…`，但 SDK dist 仍携带上一轮 `3949…`，build identity 闸门正确拒绝连接。运行仓库正式 `build` 管线同步源码协议、npm dist、native package 与 repo 内 Skill 后，产品产物 19/19；不是绕过握手或仅用 source import 取得绿色。此后重新执行正式 `release:prepare`，将源码协议、npm dist、native package 与 Skill 统一为 `ab-runtime@0.3.0-alpha.2+ee830113781e06bf`；该最终身份下的 `node-package`、`scenario-pointer-hit-target-layout-shift`、`scenario-pointer-click-sequence`、`skill-client` 四条聚焦产品链全部通过，发行身份校验也通过。

同一发布批次同步更新公开 Skill：Locator mutation 的说明现在与 Rust action transaction 一致，不再把 post-dispatch observation 描述成未 settle 的“立即捕获”；机械重试规则也只允许捕获阶段已经阻断、没有到达应用 handler 的 wrong-target pointer attempt。事件期命中错误现在稳定分类为 `action_intercepted`，让 Agent 按 fresh observation 处理 active surface，而不是把它当成无身份的普通失败或改用 DOM JavaScript 绕过。

完整 suite 证明本轮没有破坏已有 daemon、OOPIF、resources、cancellation、multi-tab 和 Skill package 链路；它仍不能替代 WebArena-Verified Hard 的官方 evaluator。

同一源码还通过 `cargo fmt --all -- --check`、`cargo check --workspace --all-targets`、SDK TypeScript build/typecheck，以及单进程 `cargo test --workspace --quiet`。曾有两份并行 workspace test 争用共享临时状态而各失败一项；没有把那次并行运行包装成产品失败或成功，先分别顺序重跑两个失败项均通过，再以一份干净的单进程 workspace test 取得最终通过结果。多击序列改动后又单独运行一份干净的 workspace test 并通过。

显式 `dialog` live case 仍在第一次普通 click 的原生 modal 处触发既有 timeout，尚未进入本次多击分支；它不属于默认 19 项，也没有被写成通过。本轮保留这个已知边界，没有用模拟 dialog 或跳过 pending-release 逻辑制造绿色。

### WebArena-Verified Hard 771

当前源码通过重置后的官方 shopping_admin 环境再次执行任务 771，浏览器操作只使用 AX、semantic Locator、typed state/form action 和 trusted CDP pointer input。review 352 的四星状态与 review 347 的五星状态均由页面控件读取；两条记录都从 All Reviews 的真实 `Edit` link 进入，状态改为 Approved 后由 `Save Review` 提交。

正式产物位于 `/tmp/ab-webarena-postfix/out/771/`：

- `network.har`：927 entries，`complete: true`，没有 body/attachment failure；
- review 352：POST `/review/product/save/id/352/`，`status_id=1`，302；
- review 347：POST `/review/product/save/id/347/`，`status_id=1`，302；
- WebArena Verified 1.2.3：最终 `score=1.0`，AgentResponseEvaluator 与两个 NetworkEventEvaluator 均为 1.0。

同一 run 的第一次官方评分曾为 0：页面 mutation 与两个 NetworkEventEvaluator 已全部成功，但提交给 coordinator 的 `agent_response.task_type` 被错误写成 `action`，官方合同要求 `mutate`。只修正该 response metadata、保持同一 HAR 和页面操作不变后重新调用官方 evaluator，最终为 1.0。这里保留第一次失败，是为了区分浏览器行为证据与评测响应协议；不能用两个 mutation 分项通过冒充首轮总分通过。

## 仍需关注的边界

当前实现仍有三项必须由后续证据决定，而不能被描述成已经成熟：

1. event-time gate 当前安装在页面可调用的 execution world；是否应迁入 isolated utility world，需要在保持真实 trusted-event interception 的前提下验证，不能只为隐藏全局变量改写。
2. XHR/Fetch 被用作潜在 SPA navigation 的早期 signal，并有总 deadline 上限；长轮询页面不能因此让普通无导航 click 固定撞满上限。需要以完整 live suite、公开 SPA 和 WebArena timing 继续校准，不能加站点白名单。

### 后台 tab 的 actionability 边界

真实的持久 profile 多 tab 场景随后证伪了页面 `requestAnimationFrame` 作为稳定性时钟：小红书详情页处于 `document.visibilityState="hidden"` 时，同一个可见作者链接的两帧采样可以一直不返回，动作尚未 dispatch 就耗尽请求 deadline；当 Node REPL 外层同为 30 秒时，宿主先重置 JavaScript kernel。未修改的 agent-browser 0.35.1 在同一链接上还会把 `target=_blank` popup 留成暂停的空 target 并卡住 CLI；Playwright 1.62.1 连接同一 Chrome、点击同一坐标时 120ms 返回，即使页面没有实际产生 popup，也不把缺失的新页当作 input 尚未完成。

随后通过 Git 中与现场 daemon 完全同源的 `ee830113781e06bf` Skill 再次连接固定 profile，原样执行 DeepSeek 报告的作者链接流程。fresh AX observation 中作者名仍是可见、enabled 的 `<a target="_blank">`，只是本轮 ref 为 `e4`。后台状态下 `ax.click("e4", { write: "state", maxChars: 4000 })` 在 30048ms 以 `cancelled/request.deadline` 结束；同页探针确认 `visibilityState="hidden"`，750ms timer 胜出而 `requestAnimationFrame` 未执行。激活 tab 后 rAF 在 0.6ms 返回，同一新鲜 ref 的点击已经由 `cdp.pointer` 完成，但整个事务仍耗时 30244ms，`ActionResult.lastStage="action.post_observation.failed"`，`observationOutcome.error.stage="action.observation.deadline"`。

第二次现场不是 AX 本身慢。点击后 Chrome 原始 target 列表出现一个 `title=""、url=""` 的 page，而 AB `tabs.list()` 不发布它；daemon 日志对该 session 只有 `detach`，没有 `attach ready`。直接向这个 task-created target 发送 `Runtime.runIfWaitingForDebugger` 也在 5 秒内没有响应。它说明 source action 已经创建 child，但 browser-level auto-attach 将新页暂停后，AB 串行等待 Page/Runtime/Network 初始化与 resume，形成 opener input、paused child、session readiness 之间的等待环。检查结束后只关闭了该空 target，原详情页和固定登录态保留。

因此稳定性仍属于 Pointer Action owner，但时钟不再属于页面。当前实现先同步检查 connected/visible/enabled 并滚动，再由 Rust 间隔 16ms 读取两次 `DOM.getContentQuads`；任一点移动超过 0.25 CSS px 仍分类为 `element is not stable` 并进入既有安全重试。这里没有移除 actionability、增加 DOM click fallback、等待固定业务结果或加入站点规则。popup/auto-attach 与 post-action observation 仍是相邻但独立的 owner，不能借这次修改一起掩盖。

popup 的修正落在 SessionManager，而不是 ActionTransaction：新 document gate、现有 init script 与拦截能力仍在 resume 前登记；Page、Runtime、Network 三个 baseline domain command 随后作为同一初始化批次进入 flight，并与 no-wait `Runtime.runIfWaitingForDebugger` 一起发送。只有这些命令完成、current document gate 已安装且 frame tree 已读到后，session 才发布 `attach ready`。这个顺序对应 Playwright 的并发 page 初始化，也沿用 agent-browser 对 auto-attached session 的 no-wait resume；没有让 action 猜 popup、延长 deadline 或忽略 observation 失败。

`test/ab/scenarios/popup-target-initialization/` 保存了由上述认证现场缩减出的 CDP 生命周期：trusted author-link handler 只调用一次 `window.open`，source click 同时请求 post-action state。修正后的隔离运行中 action 为 245ms、`observationOutcome.status="completed"`，handler 记录一次 click 且 `navigator.userActivation.isActive=true`，child `/profile` 只请求一次，随后作为可用 tab 发布并能捕获 heading AX。与同一 owner 相邻的 OOPIF registry/resources/CDP、resource locator/cancel、async SPA navigation、pointer layout-shift 五个 live case 在 debug build 中一并通过。

项目正式 `build` 随后将 native runtime、源码协议、SDK dist 与 repo Skill 统一为 `ab-runtime@0.3.0-alpha.2+846dd65b73425c01`，`release:check` 通过。这个最终产物的默认 live suite 单次执行 20/20：新增 popup 场景为 5539ms，scheduler concurrency 的实际双任务区间为 822ms，node package、multi-process persistence、OOPIF、resources、cancellation、multi-tab HAR 与 Skill client 全部在同一 run 中通过；没有把 debug 聚焦结果、前一个构建或分次补跑冒充最终正式全量结果。

正式构建 `ab-runtime@0.3.0-alpha.2+7eef564e92073a50` 后，`scenario-pointer-hit-target-layout-shift`、`scenario-pointer-click-sequence` 与 `scenario-async-spa-navigation` 分别通过；layout-shift 仍只产生一次 trusted activation，多击仍产生完整七个 mouse events，SPA 的 URL、document generation 与 post-action observation 仍来自同一事务。默认 live suite 的一次完整执行连续通过前 16 项，在 `scheduler-concurrency` 以 1514ms 触发既有独立 tab lane 时序阈值；没有修改阈值。系统空闲后同一并发 case 为 810ms 并通过，随后未执行到的 `multitab-har` 与 `skill-client` 也分别通过。因此 19 个默认 case 都有当前 build 的通过证据，但没有把这组分次证据描述成一次首轮 19/19。

当前固定 profile 上仍有旧 build 的 DSH Node REPL 与另一 Codex Node kernel 作为真实 client owner，且没有 active side effect；版本闸门正确拒绝新 build handover。修复后的同一登录小红书页面尚未由 AB 产品链原样复测，不能因隔离 live suite 通过就宣称该现场已经闭环，也不能通过强杀旧 daemon 或复制登录凭据制造结果。

这些是当前设计的审计边界，不是 fallback 授权。任何后续调整都应继续落在 Pointer Action 或 ActionTransaction owner，并在本文件和对应 scenario 中说明原因。
