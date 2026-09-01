# Recent Runtime Evolution

这份笔记只记录近期源码改动暴露出的通用运行时问题。它不按项目罗列 changelog，也不把“别人刚加了”直接变成 AB 待办。

## Identity Scope 反复成为真实故障根因

Browser Use 最近把 selector index 和 clickability cache 的 key 从裸 node id 修成 `(sessionId, backendNodeId)`（`5a4b02c4b`、`167f0c94d`）。同一个浏览器里的不同 CDP session 可以出现相同 node id，裸 key 会让 OOPIF 或多 target 页面互相污染。

ChromeDriver 最近修复 OOPIF click 的 use-after-free（`adf7c4a7ac1c`）：动作开始时持有 outer page 不能保护真正执行动作的 child `WebView`，child 可能在中途 detach。修复让整个动作持有 child holder。WebKit 则在 `waitForNavigationToComplete` callback 中捕获具体 Session（`6b6622bd96de`）；callback 到达时再读取全局 `m_session`，即使先判空，也可能命中后来替换的新 session。

Karate 把 pooled slot 放进独立 browser context，并按 browserContextId 过滤 `Target.getTargets()`（`1f2b5f9b9`、`a24051c4e`）。原因不是 tab 数量，而是 cookie、storage、cache 和 target discovery 都有 context 作用域。

Playwright 修复 WebView/child-frame exposed function callback 时，把 originating frame 的 injected-script objectId 作为 marker 带回 host（`fd9395d`）；过去把回调路由到 main frame 会直接挂起。另一个 extension-profile 修复（`0edafe4`）则确认了 user-data-dir 不足以标识真实 profile，还必须解析 `Local State.last_used` 并传 `--profile-directory`。

共同结论：任何缓存、callback、pending command 和 page object 都要带产生它的 scope；“当前 tab”或“当前 session”不是可以在异步边界上重新猜的全局变量。

## Navigation Completion 正在从状态猜测转向 generation identity

Browser Use 把 lifecycle event storage 从 per-session 单槽改成按 target/session 路由的 buffer（`c5f0fa767`），避免新 target attach 覆盖旧 handler；当 `Page.navigate` 没有 loaderId 时，它把结果识别为 same-document navigation（`b4b686823`），立即完成而不是等待不可能出现的新文档事件。

ChromeDriver 的 function execution 在 element reference resolve 前后分别读取 loader id 与 execution context；任一变化都返回 aborted by navigation。WebKit 在等待导航前先 resolve 当前 top-level/frame context（`9d4b276bf129`），明确区分 stale frame 和 dead window，避免 frame 消失把整个 window 状态清掉。

Karate 用 expected、committed、superseded loader 表达导航 generation，并处理 Chrome 在 replacement loader 下提交的情况（`f38e9c4be`、`de4268448`、`0f6a72cda`、`43f072a51`）。readyState 只作为当前 loader 的证据，不能单独定义导航完成。

Lightpanda 在 provider 内部让 old/new Page 在 navigation commit 前并存，稳定 frame_id 代表浏览槽位，document arena 和 identity map 随 commit 更换。

共同结论：URL、readyState、固定 sleep 和一次 lifecycle event 都不足以表达 document 是否仍是调用者等待的那一代。

## Enrichment 必须有预算，基础事实不能被附加项拖死

Browser Use 给 JS listener enrichment 设置最多 100 个 element、每批 20 个 describeNode 的上限（`9bf7feffb`），防止远程 CDP fan-out 无界增长。Accessibility tree 失败时保留结构 DOM（`ce0fc1b99`）；截图卡住时在有限预算后返回已取得的 DOM（`7f22c5a7b`）。它曾尝试在 state refresh timeout 时返回无截图的 cached DOM 并限制连续使用次数（`bd45e4c22`、`394ccc157`），但两项随后都被上游回退（`245cdd8df`、`b7ac967ea`）。当前源码重新选择显式 timeout，而不是把旧 DOM 包装成一次成功观测。

共同结论不是“任何 enrichment 失败都继续返回已有东西”，而是不同证据源要有独立预算和完整性语义。AX、listener、截图可以在契约明确时作为补充源；旧 document 的 cache 则可能改变事实时间，不能仅靠 warning 把 timeout 改写成成功。

## Session Detach 必须立即终止所属 pending work

Stagehand 的 CDP connection 在 `detachedFromTarget` / `targetDestroyed` 时清理该 session 的 event handlers，并拒绝该 session 的 inflight send 与 event-dispatch waiter，同时保留 root 和其他 session（`bb5ffa6f4`）。旧行为会让 pending operation 一直等到外层 timeout，错误失去 target/session 原因。

Lighthouse 也把正常 command、method timeout 和 target crash 放进同一 race；crash 后先 detach，阻止后续 CDP cross-talk。

共同结论：disconnect、target destroy、execution-context destroy 都不是普通 timeout。拥有 pending work 的层必须在 identity 消失时主动拒绝，并保留 method、target/session 和阶段。

## Command Delivery 需要表达“结果未知”

OpenCLI 的 transport 重构（`bab0409`、`23cf6e5`）没有把断线统一写成 retry。client 的 transport retry 保留 command id；daemon 中相同 id 的重复请求加入既有 pending；extension journal 对完成结果 replay，对 worker 重启前遗留的 `started` 标记返回 `command_lost`。dispatch 后断线、deadline 到期或 journal 结果过大分别进入 `command_result_unknown` / `result_evicted`，不会重新执行写操作。

后续 write-session lease（`189462c`）又把“同一个站点 tab 正被另一完整 command run 驱动”从单次 request concurrency 中独立出来。它按 profile/surface/session 仲裁 write，read 不被阻塞，持有者仍有 pending work 时不因 TTL 到期被抢占。

共同结论：浏览器写操作不只有 success/failure。transport 已接收、页面是否执行、结果是否送达是三个阶段；不能用断线重试把 unknown outcome 伪装成失败，也不能用 per-request pending map替代跨多次短调用的逻辑操作 ownership。

## 宿主不要替浏览器重复管理同一生命周期

Electron 的 debugger 曾在每次 primary main-frame `RenderFrameHost` 变化时主动 disconnect/reconnect（`8f5bef3`）。Chromium 148 的 RenderDocument 让 RFH 在导航中普遍更换，但 `DevToolsAgentHost` 本身已经会跟随同一 WebContents；宿主重复重连会重置 session Mojo pipe，丢掉 renderer 已发出的 network event。修复只在底层 WebContents 真正改变时重连，并加入跨导航保留 stylesheet/script 请求的 regression spec。

Electron 还把 `render-process-gone` 延迟到 Chromium process-death observer loop 之外（`571d6e9`），防止应用 handler 同步 reload 重入 renderer 初始化；WebContents event emission 期间的 guest destruction 也改为延迟执行（`d164b7a`），避免 callback 销毁来源对象后宿主继续访问已释放状态。

共同结论：宿主适配层不能看见 frame/process event 就机械 detach、reconnect、reload 或 destroy。浏览器内部对象若已拥有 generation 跟随能力，重复管理会制造丢事件；回调若能触发重建或销毁，则事件发送所在的 critical lifecycle 必须进入 trace 与清理设计。

## Attached、Ready 与 Alive 是不同状态

Puppeteer 的 WebWorker 在 `evaluate` / `evaluateHandle` 前等待 `Inspector.workerScriptLoaded`（`dc469b8`）。child target 已 attach、execution context event listener 已安装，都不能证明 worker script 已进入可执行状态。

ChromeDriver 的 prerender 修复（`4a301692f6b7`）揭示另一种同类状态：DevTools target 已存在，但 renderer-side frame 尚未建立，`Page.enable` / `Runtime.enable` 可以一直等待。外部 DevTools attach 需要先建立隐藏 placeholder frame，再绑定真正 renderer agent。

agent-browser 连接已有 CDP browser 时发现 `Target.getTargets()` 的第一个 page 可能是 Memory Saver discarded tab；直接向其发送 `Page.enable` 会没有响应。其修复先用有界 renderer probe 区分 target 存在与 renderer alive（`f680354`），再决定启用 domain 的目标。

Geckodriver 0.37.0 在 Android startup 中加入 process early-exit 检查：Marionette connect 仍有 60s 预算，但每次重试前先读取 browser process status；确定已经退出时立即报告 pid 与 exit code。它还把 TCP connect 与 `gecko`/protocol-v3 handshake 分开，说明 process alive、port reachable、protocol peer ready 和 WebDriver session active 是四个不同事实。

共同结论：daemon connection、Chrome process、target metadata、attached session、execution context 和可响应 renderer 是不同状态。AB 需要把这些状态做成诊断事实；不能用“daemon ready”推导某个 tab 的 CDP command 一定可执行，也不能静默换 tab 掩盖 dead renderer。

## Reconnect 可能改变权限与用户现场

Browser Harness 针对 Chrome 144+ 的修复（`43587ca`、`d6f6f05`、`5726f42`）把“CDP connect 失败就重启 daemon”改成保留同一 browser-level WebSocket 等待授权，并在判死前重复探测现有 daemon。原因是每建立一个新 CDP connection 都可能再次触发授权弹窗；盲目重启不但没有恢复连接，还会制造新的用户交互。它同时不再信任遗留的 `DevToolsActivePort` 文件，而是验证端口和 endpoint 是否仍对应活进程。

共同结论：reconnect/restart 不是中性的 transport recovery。连接建立、权限等待、现有连接健康、endpoint 文件新鲜度和 target session 存活必须分别记录；没有证据证明 browser-level connection 已死亡时，不应靠重启制造“恢复成功”。

## Screenshot 必须绑定 presentation 与像素来源

WebKit 的 full-page screenshot 修复（`caced9923c95`）显示，UIProcess window capture 物理上只能得到 viewport 像素；即使最终图片尺寸看似正确，viewport 外区域仍会被裁掉。当前实现等待下一次 presentation update，并在 full-page/element 需要离屏像素时走 WebProcess snapshot，viewport capture 才可使用 UIProcess 路径。

CEF 的 windowless runtime 从另一侧说明 presentation ownership：`OnPaint` 给 host 完整 BGRA frame 与 dirty rect，accelerated paint 的 native texture handle 却只在 callback 内有效，必须复制到 host-owned texture。其近期 OSR 修复为 input event 增加 timestamp，并处理 capture 停止与同步 Mojo deadlock（`b1fb33e2`、`273f1418`、`feddd226`）。宿主即使直接拥有 surface，也仍需明确 frame progression、callback lifetime 和 input ordering。

共同结论：截图结果至少要保留目标 browsing context、请求区域、实际像素来源和 presentation 边界。正确 tabId 只能解决“拍谁”，不能证明“拍到了哪一代画面”和“请求区域是否完整”。

CEF 近期加入的 AX viewport collapse 与 agentic workflow regression（`b6e302c3`）还表明，观察投影会主动折叠 viewport 外子树；scroll 后重新取树才恢复完整节点。压缩后的 AX tree 若没有 projection policy、viewport 与 generation，就不能把未出现的节点解释为页面不存在。

## 串行执行也必须保留严格请求身份

Chrome Remote Interface、WebDriver BiDi 和 extension relay 用 pending map 支撑并发消息，因此必须在 disconnect 时逐项拒绝。Geckodriver 选择另一条路线：一个 Marionette connection 由 mutex 独占，同一时刻只允许一个命令，response id 仍必须严格等于当前 command id。它没有用“这里只有一个调用”弱化协议校验。

共同结论：per-target queue 可以减少并发 debugger attach、动作和导航之间的竞态，但 queue 不是丢掉 request identity 的理由。AB 若采用局部串行化，仍需让 trace 同时保留 request id、target/session、排队时间、真正开始时间和完成/中断原因；也不能把全浏览器强制串行当成简单答案。

## 长期订阅必须有可撤销的资源身份

Selenium BiDi 把 listener id 改成远程端返回的 subscription id（`9f6ccde`），并让 context/user-context scope 作为独立 `SubscriptionScope` 进入订阅参数（`2f9e1c0`）。unsubscribe 不再根据 event name 和本地 context 列表重建原订阅语义。

Puppeteer 则把 allow/block network conditions 传播到手工 attach 的 session，并在 worker target 上先启用 Network domain（`5c7a0e0`）。策略注册成功不代表后来出现或由另一条 attach 路径进入的 session 自动继承它。

共同结论：userscript mount、console listener、network capture、dialog handler 和 debugger owner 都应有可查询、可撤销、带作用域的资源身份；长期策略还要定义新 session/document 出现时怎样传播，不能只保存一个全局 enabled boolean。

## 长生命周期页面不等于长生命周期观测状态

WebdriverIO 的 `waitForResponse` 修复（`e505a16`）把“收到匹配 response event”和“可选 body collector 已完成”分成两个状态。只看 calls 数量会让调用者在 body 尚未可读时提前继续。

Cypress 在 single-tab run mode 中补上 spec 间 server reset（`5636851`）：即使 tab 不关闭，pre-request correlation queue、response buffer、service worker manager、remote state 与 credentials 仍必须按 observation scope 清理，否则会出现顺序相关污染。

Browserless 的 job clock 从真正出队执行时开始（`a121257`），reconnect route 则显式绕过新 session admission（`f209655`）。queue wait、resource creation、existing-session reconnect 和 command execution 不能共享一个 duration 或 capacity 状态。

共同结论：跨任务复用专用 Chrome 的真实 tab 是 AB 的优势，但 capture/buffer/listener/init-script ownership 必须绑定 client、target、frame/document scope、开始点、结束点和 completeness；不能让“tab 还活着”替代观测状态的生命周期。

mitmproxy 从另一个边界证明了同一点：HTTP streaming 下 response 可以早于完整 request，WebSocket message 与 close 也有独立事件；native flow writer 在终态保存完整 flow，shutdown 时仍会保存 active flow，并逐 flow flush 给下游。网络观测不能只用一个 `requests.length` 表示生命周期，更不能把 capture stop 当成每个 body 都已完整。

## Ambiguity 越来越倾向于硬失败

Playwright 的 pierce-frame selector（`dba907b`）可以递归穿过 frame element，但若同一个 selector 在多个 frame 中产生匹配，它会硬失败，而不是选第一个。函数加参数的 init-script 支持（`f39623b`）也保留 function source 与 serialized args 的清晰边界。

与此相反，Karate candidate ranker 抛错时恢复默认顺序、SeleniumBase click 捕获任意异常后切换 DOM click，虽然提高表面成功率，却会掩盖调用者指定语义是否真正生效。

对 AB 的过滤器是：跨 frame、跨 world、跨 input mechanism 或多候选时，除非调用者显式给出策略，否则失败比猜测更有用。

## Performance Optimization 仍然要保护身份与清理

Vitest 在 Vite server 启动期间预热 browser（`c17677a8`），但只有 launch options 完全相同时才接管 warm instance；没有进入执行的实例由全局 close hook 回收。它还要求 orchestrator URL 必须携带有效 sessionId（`79b7d8fc`），在 browser session resolve 前等待 orchestrator ready（`fe5ed6bc`），并调整关闭顺序为先 close pool、再关 Vite server（`96fa6d73`）。这些修改共同说明启动速度、路由身份和 teardown 顺序不能分开设计。

Lightpanda 的 runner 根据可执行 page 和下一任务时间安排 tick，避免未加载页面造成空转（`542d9a333`）。

共同结论：预热、并行和减少 round trip 都可以优化体验，但必须维持配置同一性、资源归属和确定清理。不能用共享全局 browser/promise 换取表面速度。

## 并发原语要把检查与状态转换放进同一临界区

k6 Browser 修复并发首次注册 route 的 TOCTOU（`06933299e`）时，把“routes 是否为空”“启用 request interception”“追加 handler”放进同一把锁。旧实现分别调用 `hasRoutes()` 和后续 append，多个 goroutine 都可能观察到空数组并重复切换底层 interception。

这类错误与页面业务无关。只要 SDK 暴露 capture、listener、mount、console buffer 或 debugger owner 的并发生命周期，就要审计 `check -> enable -> register` 是否原子；不能靠调用者“通常不会并发”证明安全。

## Provider 兼容是一项持续维护的语义映射

Camoufox 最近需要同时适配 Firefox 152 的 popup/window API、Playwright 1.60 server launch 和异常关闭时的 session leak（`c37a899`、`5bf8081`、`0d54401`）。其 popup 修复显示 content actor 与 chrome-side target 的出现顺序会随浏览器版本改变，provider 必须按 identity 汇合双方，而不是假设某个事件永远先到。

这类改动是 legacy extension 路径的迁移证据，不再构成 AB 的宿主兼容目标。AB 第一版只支持标准稳定版 Google Chrome 与直接 CDP；未来若增加其他 Chromium provider，兼容结论仍必须来自同一实验的可观察结果，不能只看 API 名存在。

Violentmonkey 在 MV3 Chrome 中加入基于目标 URL 的 fast userscript registration（`0086266e`），随后因真实回归立刻把它改成默认关闭（`8540b0e8`），并限制不支持相应注册能力的环境启用（`b1bf577d`）。更早进入 document_start 是性能/时序候选，不是无需实验就成立的可靠性提升。

Obscura 在两周内连续修复 execution context 泄漏、script fetch 网络事件、V8 并发隔离、connection capacity 与 shutdown persistence（`358100a`、`d0b6fc4`、`76fc3b9`、`9065f38`、`3015f7d`、`5819425`）。它先把每条 CDP connection 移到独立 OS thread，再把 V8 lock 缩到 connection scope；随后用原子 admission cap、slot guard 和 shutdown drain 控制这一模型带来的线程、内存和 cookie 持久化成本。

这里的重要信息不是选择相同线程模型，而是 provider 的协议兼容、并发、容量和持久化必须一起验证。一个能通过单连接 demo 的 CDP server，仍可能在多个 connection、旧 execution context、script fetch body 或 shutdown 中给出错误事实。

## 后续怎样使用这些发现

这些模式只用来产生可证伪的问题：

- AB 哪些 cache/pending/ref 缺少 client、browser generation、session、frame 或 document scope；
- navigate/read/action 是否能区分 same-document、replacement loader 和 stale document；
- read page 的 AX/listener/layout/screenshot 补充项是否有独立预算与完整性标记；
- target/session/context 消失后，哪一层仍让调用等待到 generic timeout；
- status/attach 成功后，能否分别证明目标 renderer、worker script 和 execution context 已 ready；
- capture/listener/mount 是否有精确 resource id、scope、传播规则和独立清理点；
- tab 复用时，旧 observation buffer/correlation state 是否会污染下一次 scope；
- userscript 的更早注入路径在 reload、SPA、BFCache、prerender 与多 frame 下是否由实验支持；
- SDK 哪些 helper 会在多候选、跨 world 或 input mechanism 失败时静默换语义。

只有这些问题在 AB 实现链路中被真实复现，才进入对照实验和产品修改。
