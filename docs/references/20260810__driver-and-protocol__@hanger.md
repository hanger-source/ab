# Driver And Protocol Implementations

本档案记录驱动层和协议客户端已由源码证明的实现。API 名称不是比较单位；比较单位是 target/session/frame 身份、pending 生命周期、动作语义与断线行为。

## WebDriver Classic 规范

定位：跨浏览器远程端的命令契约。它不规定某个 binding 的 convenience API，但精确定义 session、当前 browsing context、element reference、input state 与错误语义。

已确认机制：

- element reference 是否已知同时取决于 session 与当前 browsing context；取回后还必须验证节点是否属于当前 active document，失效时返回 stale element reference，而不是用 selector 自动寻找替代节点；
- session 的 input state 按 top-level browsing context 保存。click 会滚动元素、验证 in-view center point 是否被遮挡，再创建 pointer input source、派发 actions 并释放该 input source；
- element click intercepted、element not interactable、no such window、no such element 和 stale element reference 是不同协议失败，不应被客户端压成一个“点不到”；
- 切换 browsing context 会更新远程端后续命令的目标，但规范明确不要求改变 OS-level focus。协议目标和用户当前前台窗口不是同一状态。

源码入口：`index.html` 中 Browsing Context、Elements、Element Click 与 Actions 算法。

对 AB 的边界：AB 不需要实现 WebDriver endpoint，但可以用这份规范校准公共语义。尤其是 element identity 的作用域、显式 context 切换、pointer state 和分型错误，不能因为公共 API 比 CDP 更高层就被抹平。

## Geckodriver

定位：Firefox 的 WebDriver Classic remote end。它接收 WebDriver HTTP 命令，把命令翻译给 Marionette，并同时拥有或连接 Firefox/Android browser process、profile 与底层 socket。它补足了“协议规范”和“客户端 binding”之间真实浏览器端实现这一层。

已确认机制：

- `MarionetteHandler` 用 `Mutex<Option<MarionetteConnection>>` 保存唯一活动连接；没有 session 时只有 New Session 能创建连接，其他命令直接返回 invalid session id；
- transport 按十进制 payload byte length、冒号和 JSON framing。单连接一次只发送一条命令，response id 必须与当前单调递增 command id 完全一致，乱序响应直接失败；它通过串行约束消除了 pending map 所需处理的一整类相关性歧义，而不是在并发响应中猜配对；
- `/status` 的 ready 表示 remote end 当前没有活动连接，并不等价于 Firefox process 存活、Marionette port 可连、握手完成或已有 session 可执行；
- 新 session 在 capability matching 之后才创建 browser/profile 资源。Firefox 临时 profile 使用 port 0 并从 profile 读取真实 Marionette port，避免固定端口冲突；existing browser、local browser 和 Android browser 的资源所有权分开建模；
- 连接阶段每 100ms 尝试一次、总预算 60s，但每轮先检查 browser process。进程已退出时立即返回 pid 与 exit status，不让确定的 startup failure 退化成 generic connect timeout；握手另行校验 application type `gecko` 与协议版本 3；
- session teardown 区分已收到 Delete Session 与异常结束：正常删除先给 Firefox 最多 70s 完成关闭，再强制 kill；existing browser 的 close 是 no-op；profile preferences、crash minidump 与 Android package 也按各自 ownership 清理；
- 0.37.0/0.37.1 的近期改动把 Android startup early exit、一次有界 launch retry、SIGTERM graceful shutdown、profile extraction failure 与 crash dump retrieval 放进同一条可诊断生命周期，而不是提高一个通用外层 timeout。

源码入口：`src/marionette.rs`、`src/browser.rs`、`src/android.rs`、`src/main.rs`、`CHANGES.md`。

对 AB 的边界：AB daemon 管理专用 Chrome，但多个 SDK client 共享同一个 browser generation，不应复制 Geckodriver 的单 WebDriver session 模型；“daemon ready、Chrome alive、CDP connected、client ready 分层”“确定早退优先于 timeout”“connection ownership 决定 client cleanup”“同一 transport 上请求相关性不可歧义”直接适用于 Unix socket、CDP connection 与 per-target queue。

## ChromeDriver

定位：Chromium 仓库内的 WebDriver remote end。它不是 Selenium binding 的一部分，而是把 WebDriver command 转成 DevTools 命令，并在 browser、tab、frame、OOPIF 与 renderer 之间维护运行时状态。

已确认机制：

- HTTP command 先按 session id 找到专属 session thread，再把同一 session 的命令排入该线程；不同 session 可以并行，同一 session 的状态变化保持串行，但 DevTools transport 仍用递增 command id 和 `response_info_map_` 精确关联响应；
- browser-wide `DevToolsClient`、每个 tab 的 `WebView` 和 OOPIF child client 分层存在。child session message 按 session id 路由，frame 的高层身份不能被压成 root tab 的单一 CDP client；
- listener 分成 connect、event 和 command-response 三类。通知 listener 时另存未通知队列，避免 re-entrant event/command 修改当前遍历集合；
- navigation tracker 明确使用 unknown/loading/not-loading 三态。modal dialog 打开时 JS event loop 暂停，tracker 返回 unexpected alert open，把控制权交还调用方处理 dialog，而不是继续用 `Runtime.evaluate` 猜加载状态；
- script/function execution 在解析 element reference 前记录 frame loader id 和 execution context，解析后再次校验。任一代际变化都返回 aborted by navigation，避免把旧 document 的 node 交给新 context；
- pending navigation 只对 no execution context 和 aborted by navigation 继续等待。page-load timeout 后发送 `Page.stopLoading`，并给停止加载本身单独的有界清理等待；MPArch active page 被 detach 时会等待替代 page，而不是继续在旧 target 上发命令；
- `GetTargetWindow` 从显式 current window 解析当前 active page。target metadata 已存在不等于 renderer-side frame 已建立；近期 prerender 修复在外部 DevTools attach 时先建立隐藏 placeholder frame，避免 `Page.enable` / `Runtime.enable` 永远等待；
- 近期 click UAF 修复表明，OOPIF child `WebView` 可能在动作中途 detach。外层 page holder 不能保护 child，动作必须在完整异步区间持有实际 child holder；
- SendKeys 的近期修复把合法 UTF-16 surrogate pair 转成 text-only key event，错误 pair 则硬失败。输入不是把字符串拆成 code unit 后逐个派发即可。

源码入口：`commands.cc`、`session.cc`、`chrome/devtools_client_impl.cc`、`chrome/navigation_tracker.cc`、`chrome/web_view_impl.cc`、`docs/threading.md`、`docs/chrome_connection.md`、`docs/event_listener.md`、`docs/run_javascript.md`。

对 AB 的边界：AB 不需要复制 ChromeDriver 的 WebDriver HTTP 层或 session-per-thread 模型；但 per-target queue 不能替代 CDP response identity，异步动作要保留实际 child session/resource，页面执行必须验证 document/context generation，renderer readiness 也不能由 target existence 推断。

## WebKit WebDriver / Automation

定位：WebKit 自带的 WebDriver remote end 与浏览器内部 Automation backend。WebDriver `Session`/`SessionHost` 负责协议和 browser connection，UIProcess `WebAutomationSession` 再与 page/WebProcess、input dispatcher 和 BiDi realm 交互。

已确认机制：

- WebDriverService 默认只允许一个活动 session；新 session 不会静默覆盖旧 session。只有显式 `--replace-on-new-session` 才先关闭旧 session再连接新 browser；
- 每条 session command 同时校验 session id 与 `isConnected()`。browser page crash/hang 断开后立即失效 session；remote/already-running browser 与 remote end 自己启动的 browser 具有不同 close ownership；
- `Session` 分别保存 top-level browsing context、current frame context 和 parent context。等待导航前先调用 `resolveBrowsingContext`，从而区分 stale frame 和 dead window；前者只清 current frame，后者才清整个 top-level state；
- `executeScript` 把调用者脚本包成 function，递归替换 arguments 内的 element/shadow references，再把 frame handle、函数和参数交给 browser-side `evaluateJavaScriptFunction`。结果通过结构化 JSON 返回，不依赖拼接字符串解析；
- user prompt handling 是命令前置阶段。unhandled prompt policy、dialog 生命周期和后续命令并非 generic timeout 的同一错误；
- UIProcess input dispatcher 同一 page 只允许一个 active action run。每个 tick 有自己的最短时长 timer；page 关闭时会拒绝 keyboard/mouse/wheel flush callbacks 并 cancel dispatcher，防止输入 pending 留到外层 timeout；
- browsing context navigation event 带 navigation id；fragment navigation 明确不创建新 document，也不重新执行 preload scripts。context/realm create/destroy 分开上报，WebProcess 终止时仍发出活动 realm 的 destroyed 事件；
- screenshot 在下一次 presentation update 后执行。viewport capture 可以走 UIProcess window snapshot，需要 viewport 外像素的 full-page/element capture 则必须走 WebProcess；近期修复正是因为 UIProcess 路径会把尺寸正确的整页截图裁成 viewport；
- 近期 session callback 修复在 `waitForNavigationToComplete` 整个异步链中捕获具体 Session 实例。只在 callback 时读取 `m_session` 或判空仍可能误操作后来替换的新 session；
- 近期 mouse/wheel 修复分别暴露了“single click 错把 up event 构造成第二个 down”和“dialog 前 wheel flush 落在 async dispatch 外同步执行”。动作完成证据必须来自正确事件序列与 flush 边界，不能只看调用已返回。

源码入口：`Source/WebDriver/WebDriverService.cpp`、`Session.cpp`、`SessionHost.cpp`、`Source/WebKit/UIProcess/Automation/WebAutomationSession.cpp`、`SimulatedInputDispatcher.cpp`、`WebDriverBidiProcessor.cpp`。

对 AB 的边界：WebKit 不使用 Chromium target/session 模型，不能逐 API 搬用；但 context 分型、async callback 的实例代际、输入 cancel/flush、presentation-aware screenshot 和 browser ownership 都是跨 provider 的运行时原则。

## Playwright

定位：多浏览器自动化框架。Chromium 侧不是简单包装 CDP，而是在 browser/context/page/frame/worker 对象层上维护自己的协议和状态模型。

已确认机制：

- Chromium target manager 对 target 和 session 分别建索引，递归设置 `Target.setAutoAttach(flatten: true)`；
- frame manager 在 OOPIF/SPIF 转换时更换 frame 使用的 CDP client，frame 对象身份不等于某个固定 root session；
- locator 动作先解析目标，再检查 attached、visible、stable、enabled、in viewport 和 hit target；失败保留具体 actionability 原因；

源码入口：

- `packages/playwright-core/src/server/chromium/crBrowser.ts`
- `packages/playwright-core/src/server/chromium/crPage.ts`
- `packages/playwright-core/src/server/frames.ts`
- `packages/playwright-core/src/server/dom.ts`

对 AB 的边界：Playwright 通常拥有或以完整 CDP endpoint 接管 browser，和 AB 的直接 CDP 条件相近；可移植的是 target/session/frame、Locator 与 actionability 的机械语义。AB 只有固定持久 profile 的 default context，且 daemon/Chrome 跨 client 常驻，不能照搬 Playwright 的 BrowserContext 产品模型与 `browser.close()` 生命周期。

## Puppeteer

定位：Chrome/CDP-first 自动化库，Page/Frame/Target 是对 CDP target/session 的高层对象。

已确认机制：

- TargetManager 维护 `targetId -> Target` 和 `sessionId -> CDPSession`，递归 auto-attach child target；
- OOPIF target attach 后，FrameManager 把对应 frame 的 client 更新为 child session；frame 返回同一高层对象，但命令发送端发生变化；
- isolated world 以 `${session.id()}:${worldName}` 区分，避免不同 OOPIF session 的同名 world 混淆；
- WebWorker 的 evaluate/evaluateHandle 会先等待 `Inspector.workerScriptLoaded`；target 已 attach 不等于 worker execution 已可用；
- TargetManager 把 allow/block network conditions 应用于手工 attach 的 session，并对 worker 先启用 Network domain，避免只保护 auto-attached page；
- Dialog 暴露 handled 状态，调用者可区分“看到 dialog”和“该实例已被处理”，而不必从后续命令是否恢复反推；
- Locator 不承诺任意元素都能点，而是按 viewport、stable bounding box、enabled 等明确条件等待，重试范围在实现中可见。

源码入口：

- `packages/puppeteer-core/src/cdp/TargetManager.ts`
- `packages/puppeteer-core/src/cdp/FrameManager.ts`
- `packages/puppeteer-core/src/cdp/IsolatedWorld.ts`
- `packages/puppeteer-core/src/api/locators/locators.ts`

## Chrome Remote Interface

定位：接近原始 CDP 的最薄 Node 客户端，不提供 locator、page model 或隐式等待。

已确认机制：

- 每条 command 用递增 id 放进 pending callback map；
- command 可显式带 `sessionId`；
- event 同时以全局 method 和 `${method}.${sessionId}` 分发；
- WebSocket 关闭时拒绝全部 pending，而不是让调用者只等到各自 timeout；
- domain API 由 protocol schema 生成，薄层不会替调用者猜 target/frame。

源码入口：`lib/chrome.js`、`lib/api.js`、`lib/protocol.json`。

## chromedp

定位：Go CDP 自动化库，以 context/executor 组合 browser 和 target 生命周期。

已确认机制：

- browser connection 按 `SessionID` 把 CDP 消息路由到 target executor；
- target 同时保存 `TargetID`、`SessionID`、frame tree 和 execution context map；
- `WithTargetID` 明确绑定已有 target，不从当前活动 tab 推断；
- query/action 是对 target executor 的组合，context cancellation 是资源清理主轴。

源码入口：`browser.go`、`target.go`、`chromedp.go`、`query.go`。

## Rod

定位：Go CDP client 与 page/element 高层 API，保留较多 protocol identity。

已确认机制：

- raw Request/Event 都携带 SessionID；
- Page 与 Element 保存所属 session/page 身份，元素动作通过所属 page 的 session 发出；
- event router 不把 child session 事件折叠成 root target 事件；
- race helper、sleeper 和 element state 方法是显式组合，不由单个万能 action 隐藏所有恢复策略。

源码入口：`browser.go`、`page.go`、`element.go`、`lib/cdp/client.go`。

## nodriver

定位：Python 的轻量 CDP browser/tab/element wrapper，可启动 Chromium 或连接已有 remote-debugging endpoint，不经过 WebDriver。

已确认机制：

- Connection 用递增 id 和 `id -> Future` map 关联响应，WebSocket close/cancel 时统一结束 pending；send lock 只保护发送，多个请求仍可并行等待；
- browser、tab、iframe 都是 Connection。attach target 使用 flatten session；auto-attach event 会按 target type 创建 Tab、IFrame 或普通 child Connection；
- 每个 Connection 保留最近 25 条 Transaction，记录 request、result 和可选 events；字符串展示会裁剪到 256 字符，但真实 result 不被修改；
- Browser 通过显式 `Target.getTargets` 更新 `targetId -> Tab` 列表；新建 tab 后按返回的 targetId 精确取回对象。复用已有 tab 的 convenience path 会选择第一个 page，这是产品策略而非协议必然；
- Element 同时保存所属 Tab、nodeId、backendNodeId 和 RemoteObject。`update()` 重新取 document，并按同一 backendNodeId 更新 node；未找到时仍继续尝试 resolve，失败来自 CDP；
- 默认 `Element.click()` 重新 resolve backendNodeId 后执行页面 JS `.click()`；CDP coordinate mouse click 是另一个方法，源码注释称可能不可用。两者没有被伪装成相同语义；
- 单 command 没有自己的 timeout，若连接仍开着但响应永远不来，Future 可无限等待。它依赖调用者 timeout 或连接断开。

源码入口：`nodriver/core/connection.py`、`nodriver/core/browser.py`、`nodriver/core/tab.py`、`nodriver/core/element.py`。

对 AB 的启发边界：pending 断线拒绝、真实结果与 transaction 展示投影分离、Element 绑定 Tab/session 都是清楚的薄层机制；无 command timeout、first-page convenience 和默认 DOM click 是需要避免的反例。nodriver 的反检测定位不在本研究主线。

## DrissionPage

定位：Python 自研 CDP runtime，可连接已有 remote-debugging Chromium，并把 browser、tab、frame、element 与下载等能力组织成对象。

已确认机制：

- Driver 用递增 command id 和 `id -> Queue` 关联响应，单独接收线程把 event 按 `sessionId -> owner` 路由；每条命令有明确 deadline，连接关闭会结束 receive loop 并清空 pending 与 session owner；
- browser 通过 `Target.setDiscoverTargets` 观察 target 生命周期。tab 创建时立即 flatten attach，保存 targetId、sessionId、browserContextId 和 opener；target destroyed/detached 时清理 tab/session registry；
- `ChromiumTab` 取显式 targetId。按 title/url 或序号取 tab 是另一套 convenience 路径，并可能选择结果第一项，因此它不等于稳定 identity；
- page 监听 frame attach/detach/navigation/loading，导航后重新取得 document root 的 backendNodeId、nodeId 和 objectId；它维护 frame ownership，但没有把 document generation 暴露成公共 identity；
- dialog opening/closed event 在 driver 层设置 per-session alert flag。alert 存在时 Input/Runtime pending 会尽快返回 `alert exists`，page 层另用 `Page.handleJavaScriptDialog` 处理，而不是让所有命令一直等到通用 timeout。

源码入口：`DrissionPage/_base/driver.py`、`DrissionPage/_browsers/chromium.py`、`DrissionPage/_pages/chromium_base.py`。

对 AB 的启发边界：dialog 作为 session 运行状态、event 的 session owner 路由和 target 生命周期清理值得对照。Driver 断线只清空 pending queue 而未逐条构造拒绝结果、tab convenience 默认取首项、部分循环等待使用高频 sleep，均不是候选实现。

## Pydoll

定位：Python direct-CDP runtime，可启动 Chromium 或连接调试 endpoint，以 browser、tab、element、iframe 和 request 对象组织协议调用。

已确认机制：

- `ConnectionHandler` 只有在 WebSocket 为 open 且 receive task 仍存活时才报告连接健康。socket 尚未关闭但 reader 已退出会被视为失效，新命令进入前会在 connection lock 内重建连接；
- command 使用递增 id 和 `id -> Future` 关联，每条调用有独立 timeout。timeout 会移除 pending，socket close 或 receive loop 的任意终止会给全部 pending future 设置 `WebSocketConnectionClosed`，不让它们继续等待各自 timeout；
- receive loop 内直接解析并 resolve command response；普通 CDP event 进入独立有序 queue。单条 malformed message 被记录并跳过，事件 callback 异常不会杀死 reader；
- event queue 的 worker 与 socket 生命周期绑定。close 会清 callbacks、停止 worker、丢弃死连接遗留的 queue，再关闭 receive task 和 socket；callback 有明确 id 和 temporary 标记；
- navigation 在发送 `Page.navigate` 或 reload 之前注册 `domContentEventFired` / `loadEventFired` callback，随后等待事件，并在 `finally` 删除 callback、恢复此前未启用的 Page domain。这避免了“导航命令发出后才开始监听”的竞态；
- JS click 与 pointer click 是两个公开方法。pointer click 读取 element quad 后发 `Input.dispatchMouseEvent`，DOM quad 缺失时会改用页面 JS bounding box；普通 text insertion 则是另一个 JavaScript value/event 语义，不把这些动作描述成同一种输入；
- iframe resolver 显式处理 frame owner、flatten session 和 OOPIF 路由，说明 frame element、content frame 和 child target session 不能只用一个 root connection 表达。

源码入口：`pydoll/connection/connection_handler.py`、`pydoll/connection/managers/commands_manager.py`、`events_manager.py`、`pydoll/browser/tab.py`、`pydoll/elements/web_element.py`、`pydoll/interactions/iframe.py`。

对 AB 的启发边界：值得进入实现的是“socket 与 reader 双重健康”“reader 终止立即结束 pending”“command response 与事件 callback 解耦”和“导航监听先注册后发命令”。Pydoll 与 AB 都直接使用 CDP，但它没有隐藏 daemon 多 client、跨任务 Chrome 接管和 client-scoped resource；其 element convenience 与重连策略不能直接照搬。

## 当前共同结论

成熟实现都没有把 `tabId`、`targetId`、`sessionId`、`frameId`、document 和 node id 当成同一种身份。高层对象可以保持稳定，但发送命令时必须解析到当前有效 session 与 execution context；target 已 attach 也不能证明 worker/document/renderer 已 ready。断线时 pending 必须统一结束，薄客户端还进一步说明：断线拒绝并不能替代单命令 deadline。Geckodriver 证明串行 remote end 也不能省略明确相关性；ChromeDriver 与 WebKit 则进一步证明，异步 command 必须持有它开始时的 child resource/session generation，不能在 callback 时重新读取一个可能已被替换的“当前对象”。这个结论来自协议规范和多套独立浏览器实现，不是某个 API 风格偏好。
