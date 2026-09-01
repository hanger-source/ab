# Runtime Semantics And Browser Providers

这组项目不因为 API 多而进入研究。它们分别代表成熟 UI 同步语义、浏览器能力嵌入其他运行时、协议标准和替代 browser provider。阅读目标是确认状态、身份、等待、失败与资源边界，不把测试框架整套搬进 AB。

## Capybara：把重试限制在可恢复错误上

Capybara 的 `Node::Base#synchronize` 不会对所有异常做通用重试。它只重试 driver 声明的 invalid-element errors 和 `ElementNotFound`，受 session wait time、retry interval 和 timer 约束；driver 不支持等待时，重新加载 node 后若 base 未变化就直接失败。

`SelectorQuery` 同时保留 exact、smart、prefer_exact、one 等匹配策略，visibility、text、spatial filter 也是 query 的显式部分。它说明同步与目标选择是两个契约：重试不能替调用者改变匹配政策，也不应把业务不满足包装成暂时性错误。

源码入口：`lib/capybara/node/base.rb`、`lib/capybara/queries/selector_query.rb`。

## Nightwatch：命令是有父子因果的执行树

Nightwatch 的 `CommandQueue` 继承 `AsyncTree`。每个命令节点记录 parent、stack trace、deferred、async mode 和 callback-added context；callback 中新增的命令进入当前节点的子树，而不是无来源地追加到全局 Promise 链。

这类模型的价值不在于 DSL，而在于诊断：一个命令为什么出现、由哪个回调派生、何时才算整棵子树完成，都可以从结构中回答。它适合用来审视 SDK request、动作与资源事件的多步因果 trace，但不意味着 AB 需要复制测试 DSL 或自建 runner。

源码入口：`lib/core/queue.js`、`lib/core/asynctree.js`、`lib/transport/selenium-webdriver/session.js`。

## Karate UI：document identity 比 readyState 更重要

Karate 的 CDP driver 用 loaderId 和 committed/superseded loader 表达 navigation generation。近期实现把 navigation reset、commit barrier、document readiness 和 lifecycle event 连接起来：Chrome 可能在 replacement loader 下提交，旧 document 的 readyState 不能证明当前导航完成；同 document 导航也不能按完整加载等待。

它还把并发 slot 分到独立 browser context，并在枚举 targets 时按 browserContextId 过滤。原因是 tab 不是 cookies、storage 和 cache 的隔离边界。AB 第一版明确只有固定 profile 的 default context，不引入临时 context；但 target 枚举、client resource 与 browser generation 仍必须有明确 owner/scope。

`RetryableDriver` 的 retry 有显式 timeout 和动作边界；最近加入的候选 ranker extension seam 则是反例：ranker 抛错或返回错误形态时静默恢复默认顺序，会让调用者误以为排序逻辑生效。AB 不应采用这种隐藏语义切换。

源码入口：`karate-core/src/main/java/io/karatelabs/driver/cdp/CdpDriver.java`、`karate-core/src/main/java/io/karatelabs/driver/RetryableDriver.java`、`karate-core/src/main/resources/io/karatelabs/driver/driver.js`。

## SeleniumBase：大型 convenience layer 的边界样本

SeleniumBase 的同步 CDP facade 能快速压缩常见操作，但源码也展示了 convenience API 的代价：`find_element` 自动猜 CSS、XPath 和 text，异常被收敛成通用 not-found；`click` 先做 mouse click，捕获任意异常后改用 DOM `element.click()`，再固定等待。

这不是“做得差”，而是产品目标不同。它追求脚本容易成功，AB 更需要 Agent 能判断动作到底以哪种语义执行、失败在哪一阶段。其实现可作为明确反例：高层 helper 若隐藏 selector 解释、input mechanism 和 fallback，短期代码少，长期会失去可信度。

源码入口：`seleniumbase/core/sb_cdp.py` 及其 CDP element wrapper。

## k6 Browser：浏览器命令属于 workload 生命周期

k6 Browser 的 `Connection` 和 `Session` 分开处理 browser-level 与 target-level CDP message；sessionId 被写入每个 target command，pending reply 受调用 context、session done、connection done 和 socket error 共同约束。FrameManager 把 navigation 与 lifecycle event 绑定到当前 frame，并通过 `Barrier` 等待由动作触发的 top-frame navigation。

这里浏览器操作不是独立 CLI，而是 k6 virtual user/iteration 的一部分。timeout、logger、metrics、context cancellation 都必须保留 workload 来源。对 AB 的启发是：SDK client/request 可以继承调用上下文和 provenance，但不应把性能测试的 VU 调度模型带进公共 SDK。

源码入口：`internal/js/modules/k6/browser/common/connection.go`、`session.go`、`frame_manager.go`、`barrier.go`。

## Vitest Browser Mode：provider 是测试工程的可替换执行端

Vitest 的 `ProjectBrowser` 持有 project、Vite server、provider、server state 与注册命令。命令先查 project-local registry，再查 parent registry；provider 不支持的命令硬失败，不假装存在统一能力。

Playwright provider 把 BrowserContext 和 Page 按 context id 管理，并在创建 Vite server 的同时预热浏览器。预热实例只有在 resolved launch options 完全一致时才会被接管，否则丢弃并走正常启动；无测试项目留下的 warm browser 在 Vitest close hook 中回收。这里值得借鉴的是启动重叠仍保留配置同一性和确定清理，而不是“预热就一定复用”。

源码入口：`packages/browser/src/node/project.ts`、`packages/browser-playwright/src/playwright.ts`。

## Lighthouse：观测源通过 target/session fan-in 聚合

Lighthouse 的 `ProtocolSession` 为每条 CDP command 保存方法级 timeout，并把正常结果、protocol timeout 和 target crash 放进同一 race。target crash 会先 detach，避免后续 cross-talk CDP 调用，再以明确 `TARGET_CRASHED` 失败。

`TargetManager` 递归 auto-attach page、iframe 和 worker，为每个 target 建独立 `ProtocolSession`，把原始 protocol event 附加 targetType 和 sessionId 后汇入统一事件流。execution context 用 uniqueId 索引，并在 destroyed/cleared 时清理。Network、DOM 与执行上下文因此可以聚合，但来源身份不会丢失。

这比“做一个强大的 probe”更接近 AB 的方向：提供覆盖明确、带 session 来源的观测原语，让上层决定怎样解释。

源码入口：`core/gather/session.js`、`core/gather/driver/target-manager.js`、`core/gather/driver/network-monitor.js`。

## WebDriver Classic、BiDi 与 CDP：协议层身份不是框架细节

WebDriver Classic 把 element reference 绑定到 session、当前 browsing context 和 active document；stale、被遮挡、不可交互和窗口不存在是不同协议错误。它还把 input state 绑定到 top-level browsing context，并把协议 context 切换与 OS-level focus 分开。

WebDriver BiDi 将 browsing context、navigation id、realm、sandbox、preload script、network request 和 subscription 写入远程端契约。`script.evaluate` / `script.callFunction` 的结果携带 realm，navigation 的 started、committed、failed、aborted、fragment-navigated、DOMContentLoaded 和 load 事件共享 navigation id。network data collector 与 event subscription 是独立资源；订阅可以按 browsing/user context 限定，并由远程端生成 subscription id。

CDP 则通过 Target session、Page frame/loader、Runtime executionContext/uniqueContextId、DOM backendNodeId 与 Network requestId 暴露 Chromium 内部状态。上层框架可以包装这些 id，但不能假设 tabId 或 selector 自动替代它们的作用域。

协议规范的作用不是要求 AB 实现 WebDriver，而是作为语义校准：当独立标准都要求 context/navigation/realm/document/input/subscription identity 时，这不是某个框架的复杂化偏好。

## Lightpanda：实现 CDP 不等于成为 Chromium

Lightpanda 自己实现 CDP server。`CDP.zig` 区分 browser session 与 page session；`Page.zig` 持有 document-lifetime arena、identity map、DOM version 和 pending navigation；导航时 old/new page 并存，到 commit 才替换，而稳定 frame_id 继续代表 browsing slot。

Server 为连接设置上限、keepalive、worker inbox 和连接注销。事件循环会计算可运行 page 与下一任务时间，避免页面未加载时 tight tick。这说明 provider 兼容性应该逐项讨论 target/session/navigation/input/DOM surface，不能用“支持 CDP”推导“行为等同 Chrome”。

源码入口：`src/Server.zig`、`src/cdp/CDP.zig`、`src/browser/Page.zig`、`src/browser/Session.zig`。

## Obscura：CDP 兼容要由并发与生命周期回归证明

Obscura 同样自建 browser engine，但使用 Rust 组织 HTTP、DOM 与 browser lifecycle，并为每个 page 持有 V8 runtime。CDP server 不是把请求转发给 Chromium，而是逐 domain 映射到自己的 page/context/network 实现；未实现但客户端初始化需要的部分 domain 会显式返回空成功。这意味着“能连接 Puppeteer/Playwright”只是 protocol shape 起点，不能证明行为等价。

它的并发模型是每条 CDP connection 一个 OS thread、一个 current-thread runtime 和独立 `CdpContext`。同一 connection 内只有可能进入 V8 的 method 获取 per-connection mutex；纯 Rust 状态读取绕过锁。每条可能进入 V8 的 command 另有 isolate watchdog，超时只终止该 isolate，并在返回前清除 termination 状态，避免一条 runaway evaluate 永久占住同连接的其他 session。

导航事件实现显式清空旧 `executionContextId`，重建 default world 和 fresh isolated world id；主 document 的 requestId 与 loaderId 对齐，script fetch 也进入 Network event 和 response-body store。回归测试不仅断言结果，还固定了真实重页面、慢 subresource、并发 connection、超限 503、slot 释放、旧 context 拒绝、click/submit 与 preventDefault 等行为。

最近针对 iframe event、dynamic script settle、TreeWalker 和 template serialization 的修复进一步说明：provider 兼容不是一次性实现 CDP method 名单，而是长期补齐 DOM/runtime 细节并以行为测试防回归。

源码入口：`crates/obscura-cdp/src/server.rs`、`dispatch.rs`、`domains/page.rs`、`crates/obscura-browser/src/page.rs`、`crates/obscura-js/src/cdp_watchdog.rs`；测试入口：`concurrent_connections_heavy_page.rs`、`max_connections_cap.rs`、`execution_context_pruned_on_navigation.rs`、`js_fetch_emits_network_events.rs`、`cdp_click_submit_parity.rs`。

## Camoufox：浏览器内部 provider 必须处理双向生命周期竞态

Camoufox 通过 Firefox 内部 Juggler 实现 Playwright 所需的 target/context/page protocol。`TargetRegistry` 同时维护 browser-to-target、browserId-to-target、browserId-to-actor 和 browser-context maps。

近期 Firefox 中 popup 的 content-process actor 可能先于 chrome-side `TabOpen` 出现。实现没有要求固定先后顺序，而是同时缓存 actor 与 target，任一侧出现都尝试绑定。这是通用生命周期经验：跨进程对象的建立顺序不是可靠契约，registry 应根据双方 identity 汇合，而不是靠延时或重试掩盖竞态。

源码入口：`additions/juggler/TargetRegistry.js`、`additions/juggler/content/FrameTree.js`、`additions/juggler/protocol/Dispatcher.js`。

## CloakBrowser：公开 wrapper 不能证明 patched engine 语义

CloakBrowser 的公开仓库提供 Python/JavaScript launcher、binary downloader、配置、proxy 和 humanized action wrapper。`browser.py` 最终仍调用 Playwright `chromium.launch()` / `launch_persistent_context()`，替换 executable path 和启动参数，并给 close 包装 Playwright runtime cleanup。

真正改变 Chromium 行为的 patched binary 源码不在该仓库中，因此不能从 wrapper 推断它如何修改 CDP、DOM、network、target 或 frame。它对 AB 的价值是一个边界结论：provider 的公开 API 兼容和启动成功，只证明调用形态兼容；底层语义必须通过可复现实验或浏览器源码验证，不能靠项目介绍补全。

源码入口：`cloakbrowser/browser.py`、`cloakbrowser/config.py`、`js/src/playwright.ts`、`js/src/puppeteer.ts`；binary 内部不在此 source tree。

## rebrowser-patches：协议初始化本身会改变页面可观察状态

rebrowser-patches 直接修改 Playwright/Puppeteer 内部源码，跳过默认 `Runtime.enable`，再在真正需要 evaluate 时获取 execution context。其默认方案先 `Runtime.addBinding`，为 frame 注册 new-document script；主世界触发 binding 后从 `Runtime.bindingCalled.executionContextId` 取得 context。iframe 路径先建临时 isolated world，再借 DOM CustomEvent 触发主世界 binding；worker 则直接 evaluate binding。

另两条模式展示了明确的语义代价：`alwaysIsolated` 通过 `Page.createIsolatedWorld` 执行，不能访问主世界变量且不支持 worker；`enableDisable` 短暂打开 Runtime domain 等待 `executionContextCreated`，仍保留被页面在该窗口观察到的可能。patch 还会改变 utility world 名称和 evaluate 的 `sourceURL`。

源码入口：`patches/playwright-core/src.patch`、`patches/puppeteer-core/src.patch`、`scripts/patcher.js`。

边界：仓库没有自动测试，patch 依赖具体 Playwright/Puppeteer 内部文件形状，patcher 只通过 `patch --dry-run` 判断能否应用。它能证明 domain enable、realm、binding、sourceURL 不是不可见的实现细节；其反检测效果和跨版本正确性不能仅凭 README 当成已验证事实。Legacy baseline 的 console/file-upload 路径是迁移证据；AB 是否形成真实站点摩擦必须在 Rust CDP 实现后另做实验。

## 对 AB 的研究约束

这些源码目前只产生后续实验假设：

1. tab、target、session、frame、document、realm 和 node 不能压成一个 id；
2. retry 只应覆盖已知可恢复状态，不能改变动作语义；
3. 多 target 观测可聚合，但每条事实必须保留来源；
4. command scope 应保留调用因果、timeout owner 和 cleanup owner；
5. provider 声称兼容某协议，不代表所有行为等价；
6. 高层 convenience 若隐藏匹配、fallback 或执行 world，就不适合作为可信 SDK 原语。
7. domain enable、binding、utility world 和 sourceURL 也属于页面可观察的运行时选择，诊断与兼容实验应保留这些事实。

这些仍不是实现决定。每条都需要在 AB 当前链路上找到真实摩擦，并用可重复实验验证收益和代价。
