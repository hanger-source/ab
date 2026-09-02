# Action、Input Surface 与浏览器 Resource 所有权

## 结论

AB 的 action target 始终由调用者显式指定，不存在隐式 current tab。但 headed Chrome 只有一个可靠接收物理输入的 active surface：AXRef、Locator、ElementHandle 的 pointer、keyboard、focus、form-input 操作以及全部 CUA input，在 dispatch 前由 Rust `BrowserOwner` 申请浏览器级 input-surface lease，串行化跨 tab 输入，并激活那个明确 target。输入结束后立即释放；DOM-only mutation、target 读取、popup 初始化、navigation 观察与 post-action observation 仍按各自 owner 运行。

普通 UI action 只拥有 active-surface input、该输入触发的 acted-frame navigation、阻塞输入序列的 JavaScript dialog，以及调用者明确请求的 post-action observation。它不隐式开启 file chooser interception，也不推断 popup 必须出现。

File chooser 是独立 Resource。调用者在动作前创建 `FileChooserWatcher`，watcher 生命周期唯一持有 `Page.setInterceptFileChooserDialog` feature lease、事件 identity、completeness 和 dispose。Popup target 由 `SessionManager` 独立初始化和发布，调用者通过 tab identity/opener 关系发现它。

## 为什么不能继续按页面修 action

`0a36ab3` 首次建立 `ActionTransaction` 时，每个普通动作都会 acquire `fileChooser` feature、派发输入、收集 chooser 事件，再 release feature；同一版公开文档却同时要求调用者在动作前显式建立 chooser watcher。两套 owner 从一开始就重叠。

发布提交 `ff27b2d` 之后，同一链路又由 `45450e4`、`d0703d2`、`5ae2263` 和 `31e979f` 连续修改 background stability、paused popup 初始化和 action/observation settlement。`ff27b2d..31e979f` 在 `core.rs`、`session_manager.rs`、`pointer_action.rs` 合计增加 471 行、删除 151 行。最初的 `BrowserOwner` 自 `0a36ab3` 起只有 per-target lane，并把“跨 tab 独立调度”当作完整事实；它没有表达 headed Chrome 的输入表面是 browser-global 的。这正是多个局部修复仍无法让后台 tab 操作稳定的结构原因。

## 同一真实页面对照

公开页面：`https://github.com/microsoft/playwright/issues/42452`。操作目标是 sidebar 中原生 `target="_blank"` 的 `Yury Semikhatsky (yury-s)` 链接。

- Codex Browser 先让 cover tab 处于选中状态，再对 source tab 使用 Playwright-style Locator。click 在 932ms 返回，操作中的 source tab 成为选中页；它把 Agent 操作面收敛到当前活动 page，没有向调用者暴露后台 renderer input。
- AB 来源页前台时，组合 Locator 在 443ms 返回，child 正常发布到 `https://github.com/yury-s`。
- 同一 AB 来源页由 child 覆盖、`document.visibilityState="hidden"` 后，同一 Locator 在 5003ms 返回 `outcome_unknown/request.deadline`，但第二个 child 已经创建。
- 移除普通 action 的隐式 file chooser lease 后，隐藏页仍原样超时，直接证伪“chooser acquire 是五秒根因”。
- 通用 stage 日志证明 Rust 从 ref resolve、target lane、context、transaction、live check 到 Pointer preparation 共约 30ms；真正的首个 `Input.dispatchMouseEvent(mouseMoved)` ack 在隐藏 target 上耗时 5396ms，press/release 又分别耗时约 528/555ms。
- 唯一反事实是动作前显式激活同一个 source：同一页面、同一 ref、同一 popup 压力下 action 193ms，三个 Input ack 为 18/6/19ms。将该责任移入 BrowserOwner 后，不修改场景调用方的正式路径为 198-215ms，只有一次 trusted activation 和一次 profile request。

这个对照没有用站点规则、DOM mutation、额外 timeout 或重复 click。它证明隐藏 target 的 CDP input ack、popup lifecycle、file chooser resource 与 observation 是四个相邻但不同的 owner；此前把它们都塞进 target-local action transaction，才会持续出现改一处又从另一处复发。

## 成熟实现参照

本轮源码审查固定在本地已更新 checkout：Puppeteer `5ecc694`、browser-use `67e7194c0`、browser-harness `3586ec2`、Stagehand `4d88741a0`、agent-browser `eb05921`；Playwright checkout 为 `9e3157b`，工作树采用 sparse materialization，相关 server 文件通过 Git object 读取。这里比较的是 owner 与等待边界，不按项目名称或 API 外观推断行为。

Playwright 的 Pointer Action 用 `SignalBarrier` 等待本次输入触发的顶层 navigation；popup 是 `BrowserContext`/`Page` 生命周期。`Page.setFileChooserInterceptedBy` 只在显式 file chooser 订阅者存在时更新 interception。Playwright/Puppeteer 都把 page activation 保留为独立能力，而不是在 element action 中散落 target 切换。

Puppeteer 的 `ElementHandle.click()` 只完成 scroll、clickable point 与 mouse input；navigation、popup 和 file chooser 均通过调用方预先建立的 waiter 与 click 并发。它的 `waitForFileChooser()` 仅在第一个 waiter 创建时发送 `Page.setInterceptFileChooserDialog`。

Stagehand 保持 Locator action 与 page/resource API 分离。browser-use 围绕 active page/target 建立 Agent 操作上下文，切换 page 时调用 `Target.activateTarget`。browser-harness 则把 `activate_tab()` 保留为显式 opt-in，并声称普通 background CDP input 可用；AB 在当前 macOS headed Chrome 上的实测不满足这个假设，因此不能照抄其结论。Codex Browser 的 Agent UX 与 browser-use 更接近：Agent 操作哪个 page，哪个 page 就成为当前活动表面。

AB 采用的是 Agent browser 语义，而不是通用 Playwright 的无界 Page 并发语义：明确 target 的读取和 DOM-only mutation 仍按 target 调度；实际 pointer、keyboard、focus、form-input 与 CUA input 必须经过 BrowserOwner 的唯一 input-surface lease。它不会恢复旧 tab，因为动作后的页面就是 Agent 下一步应观察的表面；`tab.activate()` 仍用于只切换可见页而不执行动作。

## 代码边界

- `server/rust/ab-runtime/src/browser/owner.rs`：唯一 browser-global input-surface lease；在 lease 内激活调用者明确指定的 target。
- `server/rust/ab-runtime/src/browser/core.rs`：四种 action surface 中真正依赖物理输入面的操作在 dispatch 周期持有 input lease；DOM-only mutation 不进入该 lease。ActionTransaction 不 acquire/release chooser feature，action event stream 只等待 acted-frame navigation。
- `server/rust/ab-runtime/src/resources/registry.rs`：FileChooserWatcher 创建和释放时 acquire/release feature，并动态纳入属于该 root target 的 session。
- `server/rust/ab-runtime/src/browser/session_manager.rs`：feature lease 与 popup/session 初始化仍是唯一浏览器事实 owner。
- `server/rust/ab-runtime/src/actions/model.rs`：ActionResult 不再携带隐式 chooser outcome。
- `sdk/ts` 与 `skills/ab`：要求 watcher 在触发动作前建立；普通 action 不声称未观察到 chooser 等于没有 chooser。

## 永久行为证据

`test/ab/scenarios/background-tab-popup-action/` 保留完整跨生命周期压力，但不决定局部实现：调用开始时 source 必须真实 hidden、页面 rAF 被抑制；明确 source action 必须由 BrowserOwner 取得可靠输入表面并在 deadline 内返回，popup 只能导航一次并在 session ready 后发布。它不要求 action 捕获 chooser 或等待 child。

`test/ab/resources-locator-cancel-live.ts` 独立证明显式 `FileChooserWatcher` 在触发前完成 interception，随后捕获带 session/frame/backend-node identity 的 `Page.fileChooserOpened`。两份证据分别验证 absence-of-ownership 与 explicit ownership，不能合并成一个为了通过页面的 helper。

## 候选版本验证闭环

当前候选 Skill runtime manifest 为 `ab-runtime@0.3.0-alpha.2+f853130ced277e95`，protocol v3。build id 同时指纹化 Rust、SDK 与公开 SDK 文档；统一 Agent presentation owner 后由正式 generator 重算，并重新构建 native、SDK 和 self-contained Skill，不复用修改前产物。验证分层完成，不能互相替代：

- `cargo fmt --all -- --check`、文档同步检查、protocol generation/check、SDK 与 benchmark TypeScript typecheck、Rust workspace clippy 全部通过；
- Rust workspace test 顺序运行通过。agent-browser 两个 test target 分别为 1127/1127 与 1156/1156，另有按上游标记 ignored 的 105/105；AB protocol/runtime 与 doc tests 同轮通过；
- Node REPL 全套第一次与 Rust workspace 紧邻运行时，一项 hostile Proxy 文本格式断言收到 `Proxy(...)` 而非旧期望；该项单独复跑通过，随后 Host 全套 152/152 通过。没有改 Host 代码或放宽断言来消掉第一次失败；
- release build、native package、TS SDK、self-contained Skill runtime、release identity 与两个 npm `pack --dry-run` 全部通过；
- 使用打包后的 release binary、SDK 和 Skill 跑默认 live suite，21/21 通过。它覆盖 daemon crash reattach、固定 profile、多 client、OOPIF、Resources、cancellation、跨 tab 调度、Agent Skill client，以及相邻 pointer/popup/SPA/observation 行为；
- 最终一致产物的 hidden source + popup 压力在 267ms 返回，四个 trusted pointer event 在 101ms 内完成；同轮跨 tab 两个 800ms 请求总耗时 856ms，证明 input-surface lease 没有把 target-local read/resource 调度全局串行化。

### 跨 owner 压力与 Agent observation 合同

为了避免单次默认套件掩盖竞态，本轮把 active surface overlay、动画消退、SPA navigation、layout shift、background popup、paused popup 初始化、Resource cancellation 和跨 tab scheduler 串成重复压力。第一轮 8/8 通过；第二轮前五项通过后，既有 paused-popup 场景出现一次 source `observationOutcome.status="failed"`。同一场景随后独立 10/10 通过。这个结果保留为负载下的 observation 竞态嫌疑，不用延长 deadline 或放宽断言把它写成稳定通过，也不把它归因给已经稳定完成 trusted input 的 BrowserOwner。

非默认 dialog 场景也没有闭环：click 与 watcher 都成功，但收到的 `DialogHandle` 在 `accept()` 前已被 SDK 标成 closed，返回 `stale_dialog`。官方 MiniWoB 机械 regression 则在动作前失败：coordinator 已按 BrowserGym 语义移除 human instruction，旧测试却仍断言 AX 正文必须包含 instruction；该静态矛盾自测试首次提交就存在，不能算 AB action 失败或通过。本批不借这两个邻接红灯扩大生产改动。

官方 WebArena-Verified Hard 610 提供了另一条实际反例。创建帖子时，短 ref `click(..., { write: "state" })` 已真实提交并导航到新帖子，但 Core 没有返回可展示 observation；Agent AX facade 随后隐式调用独立 `observation.snapshot`，新请求耗尽约 30 秒才报 `request.deadline`。只读核对确认帖子已创建，未重放 mutation；评论使用 `write:"none"` 后显式观察，2.1 秒完成，官方 evaluator 对发帖和评论两个 POST 给出 score 1.0，HAR 83 entries、`complete:true`。

调用链与 Git blame 表明，隐式 snapshot 自 Agent API 分层提交 `d7171a5` 起存在于 AX short-ref；Locator、composite form 与 CUA 对 observation 缺失又分别采用不同的静默/提示语义。这不是 Reddit 或页面性能问题。当前规则统一收进 Agent AX presentation owner：所有 action surface 只消费同一 `ActionResult`；有 observation 就展示并推进 baseline，没有就展示其中的 `observationOutcome`，绝不制造第二个 capture 或 deadline。实现旁的设计注释指向本文件。

同一修复后的自包含 Skill 在再次重建的官方 Reddit 环境中原样执行 610。创建动作遇到站点响应延迟，Core 在 20 秒 request deadline 内返回 `observationOutcome.status="failed"` 与 `action.observation.deadline`；Agent 调用于 20.4 秒返回，没有后续独立 snapshot。只读观察看到浏览器已经进入新帖 URL、站点暂时呈现 nginx 504；重载同一 URL 后帖子存在，因此没有重放创建。评论动作的 `write:"state"` 在 4.872 秒内连同新 observation 返回。官方 evaluator 再次为 1.0，HAR 85 entries、`complete:true`、无 body/attachment failure。结果位于 `/tmp/ab-webarena-agent-observation-owner-20260902/610/`；`eval_result.json` SHA-256 为 `7b1586f012e58d903fb0bdbfbb4cbc20e4a475afa7619029c9f611401c1e81b4`，`network.har` 为 `1e9fe2ec6555f4291d28a830c7bb6be8a9557d354071ed9e0f1d57855ed8e123`。

更新后的 SDK 和 self-contained Skill 又完整执行默认 live suite，21/21 case 通过。最终 `f853130ced277e95` 一致产物再聚焦执行 background popup、paused popup、Resource cancellation、scheduler concurrency 与 isolated Skill client，5/5 通过。两轮重新覆盖 AXRef、Locator、CUA、OOPIF、Resources、cancellation、跨 tab scheduler、两种 popup 场景和 Skill client；日志中 request-cancellation 场景内部保留的失败状态是预期观测事实，不是 suite case 失败。它证明统一 presentation owner 没有改变底层 action 或 resource 结果，但不抹去上面独立记录的 dialog 红灯和混合压力下单次 popup observation 失败。

### WebArena-Verified Hard 771

正式复杂回归使用 WebArena-Verified `1.2.3` 的官方任务、官方 `shopping_admin` 容器、官方 HAR evaluator 和候选版本自包含 Skill。第一次 session 启动后发现 coordinator 本身不会重置站点，页面里 review 352/347 已是旧运行留下的 Approved；该 session 被终止，没有写成通过。随后显式执行官方 `env start --site shopping_admin`，等待新容器与 Elasticsearch ready，再启动全新 coordinator。这个顺序是评测 provenance，不是 AB 产品逻辑。

重置后的 Pending 集合一页完整显示五条。Agent 只用 AX、semantic/CSS Locator、typed `inspect()`、native select 与 trusted pointer action，先盘点后 mutation：353=1 星、352=4 星、351=1 星、349=3 星、347=5 星；`intendedIds=[352,347]`，两次保存后 `completedIds=[347,352]`，Pending 结果只剩 353/351/349。没有 screenshot、CUA、evaluate、raw CDP、HTTP/API 直改、任务 helper 或重试 side effect。

官方结果保存在 `/tmp/ab-webarena-input-owner-fresh-20260902/771/`：

- `eval_result.json`：score `1.0`，status `success`；SHA-256 `13f3ed7687e3f688b35d66d52ee69de6e48acda6b6d899c7d93c1c7b4ad35346`；
- `network.har`：2273 entries、`complete: true`、0 body failure、0 attachment failure、0 late-attached target；SHA-256 `0b1dfaa475d0cfc51bb715383c08d08415c7c100ba6dbcc323559170abe30bca`；
- evaluator checksum `35c3385b1db4b3378657589f95f50defd4234bd36e5b93d44733fd561b01db4e`，dataset checksum `d65275660814663375028e9017e1f929e3c38321041b125795e2713b52243d30`；
- evaluator 观察到 review 352/347 的两个真实 `POST /review/product/save/id/<id>/`、`status_id=1` 和 HTTP 302。

这是一条 source-aware 机械回归，与仓库已有 771 source-aware 基线可比；它不冒充 fresh Skill-only Agent 统计，也不外推到全部 258 个 Hard 任务。

## 拒绝的修法

- 不把 `Page.setInterceptFileChooserDialog` command receipt 延迟到 input dispatch 后等待；那会让 chooser 在 interception 确认前发生，并继续给所有 action 收取 feature 成本。
- 不在 click、Locator、AXRef 或页面 helper 中分散调用 `activate()`；active surface 是 BrowserOwner 的浏览器级事实。
- 不继续承诺 pointer/keyboard 在跨 tab 上完全独立并发；target-local DOM/AX/Resource 可以独立，headed input 不能伪装成多个物理表面。
- 不延长 action timeout，不对 hidden tab、GitHub、小红书或 `target="_blank"` 加分支。
- 不让 action 猜 popup、download 或 chooser 是否应该出现。
- 不因 AX ref 在客户端重渲染后 stale 而语义重定位 exact ref；稳定意图使用 Locator，精确 identity 继续硬失败。
