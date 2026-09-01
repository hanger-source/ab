# Browser Session Infrastructure

本档案只研究浏览器进程、会话接入、排队、重连、资源回收和运行证据，不研究托管平台的商业功能。

## Browserless

定位：把标准 CDP/Playwright WebSocket endpoint 作为远程 browser service 暴露，同时管理 browser process 和并发容量。调用者仍使用原生 Puppeteer/Playwright client。

已确认机制：

- Router 先匹配 route，再由 Limiter 做 admission；route 可声明是否占 concurrency；
- Limiter 区分 executing、waiting、concurrency limit 和 queue limit，排队发生在 browser launch 之前；队列满时返回明确容量错误；
- job start 在真正出队执行时记录，不把排队时间混入 browser session runtime、billing 或执行耗时；
- BrowserManager 保存 `BrowserInstance -> BrowserlessSession`，session 记录 id、trackingId、连接数、开始时间、临时 profile 与 resolver；
- reconnect URL 会按 browser endpoint id 找回已有 browser 并增加连接计数，不重启 browser；reconnect route 显式绕过新 session admission limit，因为它不创建第二个 browser resource；
- wrapper 监听 Chromium `disconnected` / Playwright server `close`，异常退出会沿正常 close event 清 registry 与 profile；连接对象存在不被当成 browser 仍存活；
- close 先同步从 registry 移除，再等待 browser.close，最后串行清理临时 user-data-dir，避免管理 API 在关闭期间继续暴露幽灵 session，也避免 Chrome 尚未释放文件句柄时并行删除 profile；
- 管理 API 查询多个 browser 时并行读取，单个 wedged browser 不让全局 session list 失败；读取 Chrome JSON endpoint 有硬 timeout；
- browser launch 失败时显式关闭进程并回收自动 profile，不依赖正常 session cleanup 路径。

源码入口：`src/limiter.ts`、`src/router.ts`、`src/browsers/index.ts`、`src/browsers/browsers.cdp.ts`、`src/shared/chromium.ws.ts`。

对 AB 的启发边界：它证明 session registry、admission、reconnect 和 cleanup 应是彼此独立的状态机。AB daemon 虽然管理一个专用 Chrome，却没有 browser pool 或“一 client 一 browser”模型；不能复制 Browserless 在 client/session 结束时 kill Chrome、回收 profile 的语义。

## Steel Browser

定位：围绕一个受服务端管理的 Chromium 暴露 session API、CDP WebSocket proxy、实时 viewer、browser instrumentation 和文件接口。

已确认机制：

- 当前 `SessionService` 是单实例、单 `activeSession` 模型，结束后把已释放对象移入 `pastSessions`；它不是代码层面的并发 session registry；
- session 从 `idle` 重置为 `live` 后启动 proxy/profile/fingerprint/extension 等配置。结束时先 resolve completion、标记 `released`、统计时长与 proxy 流量，再关闭当前模式并重建新的 `idle` session；
- CDP session start/end 有 `onSessionStart`、`onBeforeSessionEnd`、`onSessionEnd`、`onAfterSessionEnd` hooks。启动失败仍执行 end hooks；结束后清空 session context 和 instrumentation context，并重新启动默认 idle browser；
- 外部 CDP client 通过 WebSocket proxy 直连实际 browser endpoint；browser/process/socket 的 close/error listener 在连接结束时解除。该层没有自己重写 CDP id/sessionId；
- TargetInstrumentationManager 按 target id 去重并保存 `targetId -> CDPSession`。page、background page、service/shared/dedicated worker、webview 和 extension target 分别启用适用的 Runtime/Page/Log/Network domain；target destroyed 时 detach 对应 session；
- browser event 合并 pageId、targetType 和 logger context，可写 storage 或实时 SSE；storage 支持按时间、event type、pageId、targetType 分页查询以及 Parquet export；
- FileService 当前使用进程级共享目录和单例 watcher，生成全目录 zip，并在 browser shutdown 时统一 cleanup。源码没有实现架构文档所称的 session-scoped file isolation。

源码入口：`api/src/services/session.service.ts`、`api/src/services/cdp/cdp.service.ts`、`api/src/services/cdp/instrumentation/target-manager.ts`、`api/src/services/cdp/instrumentation/browser-logger.ts`、`api/src/services/cdp/instrumentation/storage/log-storage.interface.ts`、`api/src/modules/logs/logs.routes.ts`、`api/src/services/file.service.ts`。

与 AB 的关系：session hooks、target 级 instrumentation registry、实时事件与持久查询分离值得比较。Steel 当前是单 active session，不能直接回答 AB 多个 SDK client 共享一个 daemon/Chrome、但各自拥有 observer/handle 的资源隔离问题。文档声称与实现不一致也提示后续评估必须以 registry key、cleanup path 和实际存储路径为证据。

## Selenium Grid

定位：WebDriver remote endpoint 的分布式路由和容量调度层。它管理的是新建 WebDriver session，不是接管用户已经打开的 tab。

已确认机制：

- Router 只负责协议 route 组合：status、session map、new-session queue、distributor，以及现有 `/session/*` 命令转发；ready 是 Distributor、SessionMap、Queue 三者 ready 的合取；
- SessionMap 是稳定的 `sessionId -> Session(node URI, capabilities, metadata)` 事实源；现有 session 命令先按 sessionId 查出所属 Node，再反向代理，不按“当前活跃浏览器”猜目标；
- Distributor 创建 session 时先在读锁下选候选 slot，再逐个用很短的写锁原子 reserve；真正调用 Node 创建 session 时不持有全局选择锁；
- Node 启动成功后，Distributor 才把 session 同时写入 SessionMap 和 slot registry；启动失败则立即释放该 slot，失败状态不会伪装成可路由 session；
- Router 的 Node HttpClient 缓存键包含 `node URI + effective read timeout`，并跟踪 in-use 和 last-use；长页面导航的 session 不会被一个固定的较短代理 timeout 截断；
- 命令 trace 明确带 sessionId、HTTP request/response、exception 和 session URI。传输失败、session 不存在与 Node 返回错误保留不同失败语义。

源码入口：`grid/router/Router.java`、`grid/router/HandleSession.java`、`grid/sessionmap/SessionMap.java`、`grid/distributor/local/LocalDistributor.java`。

与 AB 的关系：最有价值的是“稳定 identity 先于路由”“分配与执行分离”“timeout 随实际操作语义传播”“每层 trace 保留归属”。Grid 的 session queue、Node slot 和分布式容量不能套到 AB 的单 daemon/单 Chrome；可借鉴的是 client id、target id 与实际执行 owner 的确定路由。

## Selenoid

定位：按 WebDriver session 启动 browser container/driver process，并代理 session 命令、VNC、DevTools、文件和日志。

已确认机制：

- Queue 用 limit、queued、pending、used 四个 channel 表达请求排队、已获容量但未创建、已创建 session 和总容量；client 在排队时断开会退出，不继续消耗 slot；
- session 创建失败走 `Drop()`，成功写入 SessionMap 后走 `Create()`，DELETE 在先移除 session 后走 `Release()`；容量状态与 session registry 的转换点清楚；
- 每个 session 保存 URL、container、host ports、cancel、idle timeout、startedAt 和 mutex；现有 session 命令先按 id 路由，并在同一 session 内串行重置 idle timer；
- new session 对 browser service 有单次 attempt timeout 和 retry count；client 断开、attempt timeout、service startup failure 分开记录并清理启动资源；
- session idle timeout 通过发 DELETE 走与显式结束相同的清理链，而不是旁路停止 container。

源码入口：`protect/queue.go`、`session/session.go`、`selenoid.go`、`service/docker.go`。

与 AB 的关系：queue 状态、registry 转换和 artifact finalize 顺序值得比较；container-per-session ownership 与 AB 的持久单 Chrome、多 client resource ownership 不同。Selenoid 源码时间较旧，只作为机制样本，不代表当前 WebDriver 生态最佳实现。

## Crawlee BrowserPool

定位：在抓取任务中复用多个 Puppeteer/Playwright browser，并管理每个 browser 的 page 容量、退役和生命周期 hooks。

已确认机制：

- page id 在 browser launch 之前创建，并贯穿 launch、page create、close 的全部 hooks 和事件；页面失败不会让 identity 缺失；
- browser controller 分为 starting、active、retired 三个集合；retire 只停止接收新 page，已有 page 关闭后才真正 close；
- `newPage()` 先通过 limiter，再选择有容量且 plugin/proxy 匹配的 active controller，否则启动新 browser；browser launch 与 page create 都有 operation timeout；
- pre/post launch、pre/post page-create、pre/post page-close hooks 按顺序执行；post-launch 失败会从 starting registry 移除并主动 close browser；
- page create 失败会 retire 对应 browser；page.close 被包装为先采集/清理 hook、删除 page registry、再检查 retired browser 是否可关闭；
- browser retirement 可由 page count、inactive time 或调用者触发，close inactive retired browser 与强制 destroy 是不同路径。

源码入口：`packages/browser-pool/src/browser-pool.ts`、`abstract-classes/browser-controller.ts`、`browser-plugin.ts`。

与 AB 的关系：starting/active/retired、稳定 page identity、失败清理和 hooks 顺序是通用生命周期经验；browser pool 的自动选 browser/代理不适用于 AB 的固定 Chrome，也不应让 AB 在 tab id 缺失时自动选择目标。

## Browsertrix Crawler

定位：基于 Puppeteer/CDP 的长时间并发浏览器任务 runtime。本研究只看 live page worker。

已确认机制：

- 每个 PageWorker 独占 worker id、Page、CDPSession、当前 PageState 和 crash signal；page event handler 会验证 `this.page === page` 后才把 crash 归到当前任务，避免旧 page event 污染新任务；
- page 默认只在未崩溃、仍有现有状态、复用次数未超限且新旧 URL 同源时复用。`alwaysReuse` 是显式配置，不把任意跨站导航默认为可复用现场；
- 创建新 window、page close、teardown、整页任务各有独立 timeout 和日志 context。创建失败会有限重试，达到阈值后标记 browser crashed，不让单个 worker 无限卡住；
- page close 无论成功与否都会清空 worker 的 Page/CDPSession 引用；worker loop 将 queue、pending、scope 和 page limit 分开判断；
- 多 worker 用 `Promise.allSettled` 运行，单 worker 失败被记录而不会让其他 worker 的清理链直接消失。

源码入口：`src/util/worker.ts`、`src/util/browser.ts`、`src/crawler.ts`。

与 AB 的关系：resource owner、旧事件归属检查、同源复用边界和分阶段 timeout 是长脚本运行时的参考。AB 只在下一次显式 `connect()` 时恢复 daemon/Chrome，不把 Browsertrix 的自动 kill/retry 或 worker 队列带进 Agent 调度层。
