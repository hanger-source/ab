# Browser Automation Source Landscape

这份清单定义研究宇宙和源码阅读状态。样本优先选择高采用度、持续维护、能代表一类实现路线的开源项目；协议标准和用户明确指定的 provider 研究可不受 star 数约束。只研究浏览器 provider、协议、页面观察、动作、会话、artifact、诊断与复现；项目中存在的 Agent loop、prompt、模型适配、memory 和规划器一律排除。

清单不是开源项目百科。每个项目必须代表一个尚未被同类样本解释的机制，否则不继续扩张；低采用、停止维护、只有 README 功能包装而没有独特运行时机制的项目不纳入源码梳理。

## 纳入等级

- `foundation`：定义协议或被大量上层项目复用，必须理解；
- `direct peer`：与 AB 同样面向 Agent 管理本地 Chrome/CDP、持久 profile、tab/ref/action 或常驻 runtime；
- `mechanism peer`：产品定位不同，但某项底层机制可直接比较；
- `boundary reference`：只用于解释能力边界，不进入近期实现比较；

阅读状态只有三种：

- `source-read`：已读关键实现和测试，可以写实现结论；
- `source-open`：已定位源码入口，尚未完成关键链路；
- `queued`：只确认项目存在和定位，不能写底层原理结论。

## 实现路线覆盖

当前样本不是围绕几套相似的 Agent browser wrapper 展开，而是覆盖浏览器自动化中彼此不同的实现边界：

| Route | Representative sources | What it can explain |
|---|---|---|
| 标准与一致性契约 | WebDriver Classic / BiDi、CDP、Web Platform Tests | context、realm、element、navigation、input 和错误应怎样被定义与验证 |
| 浏览器侧 remote end | ChromeDriver、Geckodriver、WebKit WebDriver | 命令进入浏览器后怎样绑定 session、frame、renderer、输入和进程生命周期 |
| 嵌入式浏览器宿主 | Electron、CEF、Tauri | host-owned WebContents/browser/WebView 怎样暴露 frame、renderer、surface、session、input 与平台差异 |
| 薄协议客户端 | Chrome Remote Interface、chromedp、Rod、nodriver | pending、session routing、target identity 与断线怎样保持可见 |
| 完整自动化 runtime | Playwright、Puppeteer、Selenium、WebdriverIO | page/frame/locator/actionability 和跨引擎 provider 怎样组成公共 API |
| 浏览器内 runner / proxy runtime | Cypress、TestCafe | 注入页面后的命令队列、稳定化 barrier、heartbeat 与命令证据 |
| 本地 Agent 浏览器 runtime | agent-browser、Browser Harness runtime、PinchTab、OpenChrome | daemon、CDP、持久 Chrome、target/ref/action 和跨任务复用怎样组合 |
| 已有浏览器与扩展接管 | Playwright MCP relay、Chrome DevTools MCP、mcp-chrome、OpenCLI、Legacy baseline | 不拥有用户 browser process 时怎样路由真实 tab、debugger owner 与 extension transport |
| 浏览器能力适配运行时 | OpenCLI | 站点能力模块怎样复用同一 browser interface，同时保留 profile、target、write lease、command outcome 与 cleanup |
| 页面脚本注入 | Violentmonkey、Automa | document_start、frame/document、realm、持久注册与 reinjection 的真实边界 |
| 分布式 session 基础设施 | Selenium Grid、Browserless、Steel、Selenoid、Crawlee BrowserPool | admission、capacity、ownership、reconnect、retirement 与 cleanup |
| 测试运行时嵌入 | k6 Browser、Vitest Browser Mode、Lighthouse | 浏览器资源怎样继承 workload、test project、gatherer 的生命周期与来源 |
| 非 Chromium provider | WebKit、Camoufox、Lightpanda | 相同协议表面下 renderer、navigation、page 和 screenshot 语义怎样不同 |
| OS 级输入与视觉目标 | SikuliX、PyAutoGUI | 坐标、焦点、桌面截图、图像相似度和重新匹配能做什么，以及它们为什么不能替代 tab/frame/document 身份 |
| 视觉回归 oracle | BackstopJS | readiness、viewport/scenario/selector 矩阵、reference/test/diff 与采集失败应怎样区分 |

后续扩张以“是否补充新机制”为准。另一个 Playwright wrapper、Selenium binding 或 Agent loop 即使流行，也不会因为项目名不同就自动形成新样本。

## 协议与驱动基础

| Project | Level | Status | Core question |
|---|---|---|---|
| Chrome DevTools Protocol | foundation | source-read | target/session/frame/runtime/input 的真实作用域是什么 |
| WebDriver Classic / BiDi | foundation | source-read | 跨浏览器远程端契约怎样表达 context、navigation、realm 与事件 |
| ChromeDriver | foundation | source-read | Chromium WebDriver remote end 怎样把 session command、DevTools client、WebView/OOPIF 与 renderer 生命周期串起来 |
| Geckodriver | foundation | source-read | 浏览器侧 WebDriver remote end 怎样把 session、Firefox/Android 进程与 Marionette 命令串成一条生命周期 |
| WebKit WebDriver / Automation | foundation | source-read | WebDriver remote end 与 UIProcess/WebProcess automation 怎样表达 browsing context、realm、input 和 screenshot |
| Playwright | foundation | source-read | 多引擎 provider、frame/session 与 locator/actionability |
| Puppeteer | foundation | source-read | CDP-first target/session/OOPIF 与 locator 如何实现 |
| Selenium | foundation | source-read | WebDriver/BiDi、Grid 与多语言 binding 的边界 |
| WebdriverIO | mechanism peer | source-read | 在 WebDriver/CDP 之上的 command、hook 和诊断模型 |
| Chrome Remote Interface | foundation | source-read | 最薄 CDP pending map、session 路由和断线拒绝 |
| chromedp | mechanism peer | source-read | Go 中 browser/target executor 与 frame/context 状态 |
| Rod | mechanism peer | source-read | session-aware page/element 与原始 CDP event routing |
| nodriver | mechanism peer | source-read | Python raw-CDP connection、target/tab、transaction 与 element identity |
| Pydoll | mechanism peer | source-read | socket/receiver 双重健康、pending command 终态、事件队列与导航监听怎样避免连接假活和命令悬挂 |
| DrissionPage | mechanism peer | source-read | Python CDP pending、tab/session registry 与 dialog 状态 |

## UI 自动化运行时

| Project | Level | Status | Core question |
|---|---|---|---|
| Cypress | mechanism peer | source-read | 浏览器内 runner、命令队列、actionability、command log |
| TestCafe | boundary reference | source-read | proxy 注入、动作稳定化 barrier 与 browser heartbeat |
| Taiko | mechanism peer | source-read | Chrome Runtime 上意图 API 的目标选择与等待 |
| Appium | boundary reference | source-read | session driver、插件命令链与 per-session 串行执行 |
| Nightwatch | mechanism peer | source-read | command tree、嵌套命令因果与 WebDriver session 投影 |
| Karate UI | mechanism peer | source-read | CDP document/loader identity、browser context 隔离与显式 retry |
| Capybara | mechanism peer | source-read | selector match policy 与仅对可恢复错误生效的同步重试 |
| SeleniumBase | boundary reference | source-read | 大型 convenience layer 怎样用隐式 fallback 换取表面成功率 |

## 嵌入式浏览器宿主

| Project | Level | Status | Core question |
|---|---|---|---|
| Electron | mechanism peer | source-read | Chromium host 怎样直接管理 WebContents、frame/RFH、DevTools、surface input/screenshot、session preload 与 webRequest |
| Chromium Embedded Framework | mechanism peer | source-read | 嵌入式 Chromium host 怎样把离屏像素、输入、request context 与内嵌 DevTools protocol 暴露给应用 |
| Tauri | boundary reference | source-read | 跨平台 WebView abstraction 能提供哪些宿主能力，以及为何它仍不是完整 automation runtime |

## 桌面视觉自动化边界

| Project | Level | Status | Core question |
|---|---|---|---|
| SikuliX | boundary reference | source-read | 屏幕区域、图像相似度、重复截图搜索与 OS 输入怎样形成视觉动作，以及身份和失败证据在哪里丢失 |
| PyAutoGUI | boundary reference | audited | 纯坐标鼠标、键盘和桌面截图能提供哪些最小 OS input 事实 |

## 浏览器能力嵌入其他运行时

| Project | Level | Status | Core question |
|---|---|---|---|
| k6 Browser | mechanism peer | source-read | CDP session、navigation barrier 与性能测试 iteration 怎样共用生命周期 |
| Vitest Browser Mode | mechanism peer | source-read | provider command 怎样嵌入 test project、Vite server 和浏览器预热/清理 |
| Lighthouse | mechanism peer | source-read | 多 target protocol event、execution context、network 与 gather 生命周期怎样分层 |

## 本地 Agent 浏览器与既有浏览器接管

| Project | Level | Status | Core question |
|---|---|---|---|
| Legacy baseline | boundary reference | source-read | 已冻结的 extension provider、relay、SDK runner 如何共同保持真实现场，以及哪些 owner 需要退出 |
| Playwright MCP extension relay | direct peer | source-read | 怎样把 `chrome.debugger` 伪装成完整 CDP browser endpoint |
| Chrome DevTools MCP | direct peer | source-read | Puppeteer page、AX refs、network/console collector 和 DevTools 数据如何组合 |
| agent-browser | direct peer | source-read | native daemon、stable tab/ref、OOPIF session 与 artifact |
| OpenChrome | direct peer | source-read | target ownership、per-target queue、trace storage 与真实 Chrome |
| PinchTab | direct peer | source-read | local server、profile/instance、tab lock、snapshot/action |
| chrome-cdp-skill | direct peer | source-read | 每 tab 持久 daemon 如何保留 CDP session |
| Browser Harness runtime | direct peer | source-read | 一个 browser-level CDP connection 怎样切换 flattened target session，并保持 domain 与事件作用域 |
| mcp-chrome | direct peer | source-read | extension/native-host/HTTP bridge 如何路由浏览器 API |
| OpenCLI | direct peer | source-read | extension/daemon 怎样接管多个真实 profile，并把 target lease、command journal 与站点 adapter 组织在同一 runtime |
| Automa | boundary reference | source-read | extension workflow worker、tab/frame 消息与 content script 生命周期 |
| Violentmonkey | mechanism peer | source-read | userscript 的 document/frame、runAt、realm 与 bridge 生命周期 |

## 页面观察与动作内核

这些项目只读其 browser/session/DOM/action 实现，不读 Agent 决策层。

| Project | Level | Status | Core question |
|---|---|---|---|
| Browser Use | mechanism peer | source-read | recursive auto-attach、OOPIF hierarchy、node session identity |
| Stagehand | mechanism peer | source-read | frame/session registry、snapshot ref、locator、navigation wait |
| Alibaba Page Agent | mechanism peer | source-read | PageController、element index、页面内动作与失效边界 |
| BrowserGym | mechanism peer | source-read | observation/action/evaluation 的统一可复现接口 |
| Webwright | mechanism peer | source-read | browser workspace、脚本与 artifact 如何支撑长流程 |

## 会话与远程浏览器基础设施

| Project | Level | Status | Core question |
|---|---|---|---|
| Browserless | mechanism peer | source-read | admission queue、browser ownership、reconnect、cleanup |
| Steel Browser | mechanism peer | source-read | 单活动 session、CDP proxy、target instrumentation、event storage |
| Crawlee BrowserPool | mechanism peer | source-read | page/browser capacity、retirement、hooks 与资源归属 |
| Browsertrix Crawler | mechanism peer | source-read | 长任务 page worker、CDP session、同源复用与崩溃隔离 |
| Selenium Grid | foundation | source-read | router/distributor/session map/node 的远程调度 |
| Selenoid | mechanism peer | source-read | 容器 browser 生命周期、限流和 session log artifact |

## Provider 与反检测边界

| Project | Level | Status | Core question |
|---|---|---|---|
| CloakBrowser | boundary reference | source-read | 公开 launcher/action layer 能证明什么，patched binary 内部不能证明什么 |
| Camoufox | boundary reference | source-read | Firefox 内部 Juggler target/context provider 怎样实现 Playwright 语义 |
| Lightpanda | boundary reference | source-read | 非 Chromium CDP provider 怎样实现 page/session/navigation 语义 |
| Obscura | boundary reference | source-read | 自建 V8/DOM/network engine 怎样用 CDP conformance、execution context lifecycle 与并发隔离支撑兼容声明 |
| rebrowser-patches | boundary reference | source-read | `Runtime.enable`、execution context 获取、utility world 与 sourceURL 怎样成为页面可观察的自动化副作用 |

反检测不是 AB 当前主线。只有当 provider 差异能解释真实兼容问题时，才进入实验。

## 运行中观测与动作证据

| Project | Level | Status | Core question |
|---|---|---|---|
| BrowserGym | mechanism peer | source-read | 环境重置、observation/action space、oracle |
| Web Platform Tests | foundation | source-read | WebDriver 会话复用、逐测试清理、身份失效断言、超时/崩溃结果与重启边界 |
| Cypress Command Log | mechanism peer | source-read | 命令状态、重试、失败快照怎样呈现 |
| Lighthouse | mechanism peer | source-read | protocol session、target fan-in、network recorder 与 gatherer 怎样保留来源 |
| BackstopJS | boundary reference | source-read | 页面 readiness、截图采集、reference/test/diff artifact 与视觉失败怎样映射 |

## 浏览器外部网络观测

| Project | Level | Status | Core question |
|---|---|---|---|
| mitmproxy | mechanism peer | source-read | browser 外部 proxy 怎样表达 HTTP/WebSocket flow、stream 并发、body 完整性、error 与 artifact 生命周期 |

## 已审计但不展开为完整样本

| Project | Category | Current judgment |
|---|---|---|
| Docker Selenium | browser deployment / Grid packaging | 主要把 Selenium Grid、browser node、容器生命周期和可观测组件组成可部署系统；当前没有发现超出 Selenium Grid 与 browser session infrastructure 档案的新命令或目标语义 |
| webview | embedded WebView library | 提供跨 GTK WebKit、WKWebView 与 WebView2 的最薄 host surface：GUI-thread dispatch、document-start init、fire-and-forget eval 和 JSON binding；Tauri 档案已覆盖同一宿主边界，它没有 target/session/document/input/screenshot automation identity，因此不另建完整样本 |
| undetected-chromedriver | Selenium/ChromeDriver patch wrapper | 核心是下载并二进制替换 ChromeDriver 注入片段，再用 new-document JS 修改 headless surface；event listener 每秒轮询 performance log，CDP helper 每次新建 WebSocket。它没有新的 target/session/action lifecycle，且大量异常被吞掉，因此只作为 wrapper 不能证明浏览器语义的边界证据 |
| Maxun | no-code scraping/workflow platform | browser service 是 Playwright `launchServer`，server 端以 Playwright Browser/Context/Page/CDPSession 组织每用户 browser pool，录制和 workflow interpreter 占主要实现；其 slot reservation、stale cleanup 和 incremental result persistence 属于已有 session-pool/long-job 路线，没有新增 target、document、action 或 observation 语义，因此不另建完整样本 |
| PyAutoGUI | OS-level input and screenshot | 能代表坐标、键盘、鼠标和桌面截图这一输入边界，但没有 tab/frame/document/realm 身份；只用于提醒 OS focus 与协议目标不同，不作为浏览器运行时实现样本 |
| Karma | browser test capture/runtime | browser capture、launcher 与 test socket 有明确的 `CONNECTED/CONFIGURING/EXECUTING/EXECUTING_DISCONNECTED` 状态和 bounded reconnect/no-activity timeout；它没有 tab/frame/document/action surface，且核心 runtime 最近没有形成新的浏览器语义，因此只作为连接状态机证据 |
| Selenide | Selenium convenience runtime | condition wait 会按 polling interval 重新获取 WebElement 并把最后一次 check/error 包入 assertion；这与 Capybara 的 recoverable synchronization、WebdriverIO 的 element refetch 属于同一路线，没有新增 target/session/document identity，而且隐式重查不适合作为 AB 默认动作语义 |
| Ferret v2 | declarative query runtime | 当前主干实现 Engine、Plan、Session、module hooks 和 VM pool，但没有 browser/CDP driver package 或对应依赖；仓库中的浏览器 `.fql` 示例仍引用旧 `DOCUMENT(..., {driver: "cdp"})` 能力，不能证明 v2 当前存在浏览器运行时。其 session/VM 生命周期属于通用嵌入式语言设计，不作为 AB 浏览器机制样本 |

## 当前阅读顺序

1. 用 foundation 确认 target/session/frame/document/realm 的语义来源；
2. 用 direct peer 比较真实浏览器接管、tab ownership、断线与并发；
3. 用 UI runtime 比较动作、等待、命令因果与错误边界；
4. 用 embedded host、runtime embedding、capability adapter 和 session infrastructure 比较资源、清理与诊断；
5. 用 provider 实现区分协议契约、浏览器固有行为和框架偶然实现；
6. 最后才从矩阵中提出实验问题，不先把项目特性翻译成 AB API。
