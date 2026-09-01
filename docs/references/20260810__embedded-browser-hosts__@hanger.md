# Embedded Browser Host Implementations

嵌入式浏览器宿主不是普通自动化客户端。它位于 browser engine 与应用之间，可以直接拥有 page container、renderer、session、surface 和输入转发；但宿主暴露多少自动化语义，仍取决于其公共 runtime。AB 不嵌入 Chromium，而是通过 CDP 管理标准 headed Chrome；宿主内部 surface 能力因此只能作为边界对照，不能假定 AB 自动拥有。

## Electron

定位：把 Chromium `content::WebContents` 暴露为应用运行时，并在 main process 提供 frame、session、DevTools、输入、截图和 preload 能力。当前读取 [Electron `e12e04e8`](https://github.com/electron/electron/tree/e12e04e87bb7c3a0ce744a0bab9b317d250d725e) 的 browser API、实现和 regression specs。

### WebContents、frame slot 与 renderer instance

- `WebContents` 有进程内稳定 id，并可从 `WebFrameMain` 或 DevTools target id 反查；unknown target 明确返回空，不自动选择其他 page；
- `WebFrameMain` 同时维护两种身份：`FrameTreeNodeId` 表示可跨导航延续的 frame slot，`GlobalRenderFrameHostToken` 表示当前精确 RFH。跨进程导航交换 RFH 时，对象保留而 token 更新；frame tree node 真正删除后才进入 destroyed；
- `RenderFrameCreated` 会过滤 speculative RFH，只把 active frame 暴露为 `frame-created`；旧 RFH 删除时还会比较精确 frame token，避免把已换到新 RFH 的 `WebFrameMain` 错误处置；
- navigation event 保留 URL、same-document、main-frame、process id、routing id、当前 frame 与 initiator。frame getter 在事件处理过晚、frame 已导航或销毁时可以为空，这是显式 stale 语义；
- renderer crash、frame disposal 和 WebContents destruction 是不同事件。全局 id map 在 WebContents 销毁时移除，frame 访问在 disposed 后硬失败。

这套模型的重要性不在 Electron API 名称，而在它没有把“一个 iframe 槽位”和“当前承载该槽位的 renderer/frame instance”合成同一身份。

源码入口：

- `shell/browser/api/electron_api_web_contents.cc`
- `shell/browser/api/electron_api_web_frame_main.cc`
- `shell/browser/api/electron_api_web_frame_main.h`
- `lib/browser/api/web-contents.ts`
- `spec/api-web-contents-spec.ts`

### Page execution 与 preload

- `webContents.executeJavaScript` 在主 frame loading 时等待 `did-stop-loading`，再通过 renderer IPC 执行；async promise 的值和异常都由测试覆盖；
- `WebFrameMain.executeJavaScript` 直接绑定调用时的 frame object。frame disposed 时 promise 立即拒绝，而不是重新查询一个同位置的新 frame；
- main world 与显式 isolated world 是独立 API，测试确认 isolated world 写入不会泄露到 main world；
- session preload 有调用者可指定的唯一 id，重复 id 硬失败，注销未知 id 也硬失败；context type 区分 frame 与 service worker；
- frame preload 在 `ReadyToCommitNavigation` 中通过与 navigation 同序的 associated Mojo channel 发送，先于 CommitNavigation 到达 renderer，并早于 per-WebContents preload；之后启动的 service worker 会从 session preferences 重新建立 startup data；
- preload 注册只表达脚本资源与未来 context 的传播，不把已存在 document/worker 是否执行过伪装成一个全局 enabled boolean。

源码入口：

- `shell/browser/api/electron_api_session.cc`
- `shell/browser/api/electron_api_web_contents.cc`
- `docs/api/structures/preload-script-registration.md`
- `spec/api-web-contents-spec.ts`

### DevTools session 与 pending lifecycle

- `Debugger` 是 `DevToolsAgentHostClient`。每条 command 分配递增 id，promise 存入 pending map；可选 child `sessionId` 原样进入 CDP message，空 session id 被拒绝；
- response 按 id resolve/reject，protocol event 以 method、params、sessionId 发出；target close 会拒绝全部 pending，并发送明确 detach reason；
- Electron 自己的 debugger wrapper 不把 DevTools frontend 视为互斥 owner，regression test 证明打开 DevTools 后仍可发送 `Runtime.evaluate`；这与扩展环境下 `chrome.debugger` 的 attachment 约束不是同一语义；
- `Target.setAutoAttach(flatten: true)` 由调用者显式启用，child target event 保留各自 session id，宿主不把多个 child session 压成 root page；
- [RenderFrameHost swap 修复 `8f5bef3`](https://github.com/electron/electron/commit/8f5bef3) 删除了同一 WebContents 导航时的 debugger disconnect/reconnect。Chromium RenderDocument 使主 RFH 每次导航都可能更换，而 `DevToolsAgentHost` 已会自行跟随；宿主额外重连反而重置 Mojo session pipe，丢掉已经发出的 network notification。

源码入口：`shell/browser/api/electron_api_debugger.cc`、`spec/api-debugger-spec.ts`。

### 输入、surface 与后台语义

- `sendInputEvent` 直接向目标 `RenderWidgetHost` 转发 mouse、keyboard 和 wheel；offscreen WebContents 有专门的 offscreen view 路径；wheel 还显式补齐 Chromium 所需的 began/ended phase；
- specs 在 `show: false` 的 BrowserWindow 上验证 mouse/keyboard event 能到达 renderer，说明 Electron host-level input 不等同于依赖桌面当前 active tab 的 OS 输入；
- `capturePage` 从目标 `RenderWidgetHostView` 的 surface 复制像素，并通过 capturer count 的 `stayHidden` / `stayAwake` 控制 capture 期间的可见性与活跃状态；
- surface 尚未建立或 view bounds 为空时，截图返回空图。已有 surface 的窗口被遮挡或最小化后，spec 仍要求 capture 成功；因此“hidden”不是单一状态，surface availability 才是必要事实；
- `backgroundThrottling=false` 会关闭 renderer scheduler throttling，并把 hidden render widget 置为 shown。它是宿主拥有的调度策略，不是页面函数或 CDP action helper 可以默认为真的环境条件。

源码入口：`shell/browser/api/electron_api_web_contents.cc`、`spec/api-browser-window-spec.ts`、`spec/api-web-contents-spec.ts`。

### Session network 与多使用者边界

- Electron session 对应 browser context/partition：空 partition 是默认 context，`persist:` 是持久 context，其他名称是内存 context；同 partition 返回同一个 session；
- session `webRequest` 在 Chromium network stack 边界提供 request id、URL、method、resource type、webContents id、requesting frame、headers、upload data、redirect、status、cache 与 network error；
- response started、completed 和 error 是不同事件；HTTP error response 与 transport error 不应混为一类；
- 这条 API 没有 response body 通道，不能冒充完整 network capture；
- 每一种 webRequest event 的 listener map 只有一个槽位，新 listener 会覆盖旧 listener，传 null 才注销。若多个 SDK 使用者需要共存，宿主之上必须有显式 fan-out/resource ownership，不能直接把原生注册函数暴露成可组合订阅。

源码入口：`shell/browser/api/electron_api_session.cc`、`shell/browser/api/electron_api_web_request.cc`、`docs/api/web-request.md`、`spec/api-web-request-spec.ts`。

### Event reentrancy 是宿主级故障面

- [render-process-gone 修复 `571d6e9`](https://github.com/electron/electron/commit/571d6e9) 把应用事件延迟到 Chromium process-death observer loop 之外，避免 handler 同步 reload 时重入 renderer 初始化；
- [WebContents event UAF 修复 `d164b7a`](https://github.com/electron/electron/commit/d164b7a) 在 event emission 期间延迟 guest destruction。事件回调可以销毁其来源对象，因此“已经进入 callback”不能证明 callback 返回前 owner 仍存活；
- 这两项都不是普通异常捕获问题。宿主转发层必须知道自己是否位于浏览器内部 critical lifecycle 中，并决定事件、销毁和重建的先后顺序。

### 对 AB 的边界

Electron 证明宿主可以实现后台 renderer input、target-bound surface capture、frame slot/RFH 双重身份和 session-level preload/network。AB 使用外部标准 Chrome 与 CDP，不能调用 Electron 的 WebContents/RFH/surface 私有宿主面；可借鉴的是身份与呈现边界，不是 Electron API。

后续值得形成实验的问题是：

- 同一导航下 debugger session 是否被宿主错误重建并丢事件；
- background tab 的 protocol input、host input 和 OS input 分别需要哪些可见/焦点条件；
- screenshot 是否来自目标 surface、是否绑定目标 document/presentation，而不只核对 tabId；
- host-level webRequest/preload 怎样给多个调用者提供独立 resource id、fan-out、传播状态和清理；
- renderer crash、frame replacement、target detach 与 extension reconnect 能否在 trace 中被分型，而不是都等待到 generic timeout。

这些仍是实验问题，不是直接修改 AB 的依据。

## Chromium Embedded Framework

定位：把 Chromium 作为应用内 browser host 暴露给 C/C++ 调用者。与 Electron 相同，它拥有 browser surface 和 renderer 输入链；与 Electron 不同，它同时提供 windowed 与 windowless/off-screen rendering，并把 DevTools protocol 作为进程内 observer API 暴露。当前读取 [CEF `803fe341`](https://github.com/chromiumembedded/cef/tree/803fe341dffd5b6b18eb009301b8d9a61a83a329) 的 browser host、OSR、DevTools 和 regression tests。

### Off-screen surface 与输入

- `CefRenderHandler::GetViewRect` 定义 view 坐标；`OnPaint` 分别报告 view 与 popup 的 dirty rect，并交付完整 BGRA buffer、像素宽高和 DPR 关系；
- accelerated paint 交付平台 native texture handle，但 handle 只在 callback 生命周期内有效，host 必须立即复制到自己拥有的 texture，不能把 callback 参数当成稳定 screenshot handle；
- `CefBrowserHostBase` 把 key、mouse click/move/wheel 投递到 browser UI thread，再由 platform delegate 发给目标 render widget；这条链不依赖桌面层选中一个 Chrome tab；
- OSR regression 同时验证 view/popup paint、mouse move/click、dropdown、drag、keyboard 和 hide/show repaint。测试 helper 甚至为 click down/up 保留明确延时，说明输入已发送与 renderer 接受事件不是一个同步布尔值；
- 2025 年的 OSR 变更为 input event 增加 timestamp，并修复 capture 停止和同步 Mojo deadlock，证明离屏 surface 的帧推进、输入时序和线程边界都是宿主能力的一部分。

源码入口：`include/cef_render_handler.h`、`include/cef_browser.h`、`libcef/browser/browser_host_base.cc`、`libcef/browser/osr/render_widget_host_view_osr.cc`、`tests/ceftests/os_rendering_unittest.cc`。

### Frame、request context 与内嵌 DevTools

- `CefFrame` 暴露 browser、parent、URL 和 globally unique frame identifier；frame 尚不存在时 identifier 为空，frame 执行与 DOM visitor 又带 browser/render-process thread 限制；
- `CefRequestContext` 把 cache/profile 与 request handler 绑定到 browser context；内部 handler map 以 Chromium `GlobalRenderFrameHostId` 关联请求来源，而不是只按 tab/browser 猜 frame；
- `ExecuteDevToolsMethod`、raw `SendDevToolsMessage` 与 `AddDevToolsMessageObserver` 直接连接当前 browser 的 `WebContents`；observer registration 自己拥有注销生命周期，并分别报告 message result、event、agent attach 和 detach；
- agent detach 会使 pending method result 永远不再交付并取消 event subscription。CEF 把这个写进公共回调契约，而不是让调用者只等 transport timeout；
- DevTools message callback 的 buffer 只在 callback 内有效，源码还明确提醒大消息可能超过 1MB，宿主必须自行复制并治理输出。

源码入口：`include/cef_frame.h`、`include/cef_request_context.h`、`include/cef_devtools_message_observer.h`、`libcef/browser/request_context_impl.cc`、`libcef/browser/devtools/devtools_protocol_manager.cc`。

### 对 AB 的边界

CEF 补足了一个重要对照：当宿主真正拥有 browser surface、render widget 和 browser context 时，后台输入、离屏截图、request attribution 与 DevTools detach 都可以成为直接宿主事实。AB 没有 CEF/Electron 级 host surface；只能把 CDP 实际交付的 target、frame、input、screenshot 与 request 事实写入能力契约。

CEF 最近加入的 AX viewport collapse 与 agentic workflow regression 也不意味着 AB 应复制一个“精简 AX 树”。它说明 observation projection 必须由 viewport、scroll 和重新取树的测试证明，离屏节点被折叠时不能把缺失解释为页面不存在。

## Tauri

定位：高采用度的跨平台应用 WebView runtime，通过 `tauri-runtime` 抽象并由 Wry 映射到 WebView2、WKWebView、WebKitGTK 和移动平台 WebView。当前读取 [Tauri `3f5d3984`](https://github.com/tauri-apps/tauri/tree/3f5d3984bc8916b5dd31289b19284637ede37e3d) 的 webview runtime 与 JS API。

已确认机制：

- WebView 以应用 label 管理，可创建、定位、聚焦、导航、关闭和 reparent；runtime dispatcher 把公共命令委托给平台 webview；
- initialization script 明确区分 main-frame 与 all-frames，并承诺在 `window.onload` 前执行；page-load event 只分 started/finished；
- `eval` 是单向执行，`eval_with_callback` 才把 JSON serialized result 送回 host；Windows 的异常传播存在平台限制，源码文档要求调用者自行包装；
- devtools、background throttling、custom protocol、proxy、data store、first mouse、service worker 与 app-bound domain 均带平台条件。相同 Tauri API 不代表底层 WebView2、WebKit 与移动 WebView 行为相同；
- 当前公共 runtime 没有稳定 target/session/frame/document/node identity，也没有协议级 input、surface screenshot 或 response-body capture。它是 WebView 应用宿主，不是完整浏览器自动化 runtime。

源码入口：

- `crates/tauri-runtime/src/webview.rs`
- `crates/tauri-runtime-wry/src/webview.rs`
- `crates/tauri/src/webview/mod.rs`
- `crates/tauri/src/webview/webview_window.rs`
- `packages/api/src/webview.ts`

对 AB 的边界：Tauri 的价值是证明“嵌入 Web 内容”与“提供可诊断自动化语义”之间还有完整的一层能力差。面对 Chromium-based host，不能从 engine 品牌推导 target、frame、input、debugger、network 和 screenshot 都可用；必须逐项验证宿主公开的 capability surface。

## 当前共同结论

1. embedded host、browser remote end、extension provider 和 automation client 是不同层，不能按“都能执行 JavaScript”归为同一种实现。
2. 宿主若拥有 frame slot、renderer instance、surface 与 browser context，应把这些身份保留下来，而不是只暴露一个 page id。
3. 宿主内部可直接输入和截图，不代表 extension 或外部协议有同样后台语义；provider capability 必须实测。
4. preload、webRequest、debugger listener 都是长期资源，单 listener 或全局 enabled 状态不适合多调用者 SDK。
5. renderer swap、process death、DevTools agent detach 与 event callback destruction 都可能改变对象生命周期；重连、重载和清理必须避开宿主内部 critical section。
