# Source Ledger

记录源码梳理使用的 ref。已有仓库保持原 worktree 不变；当本地分支落后时，直接读取 `origin/*`，不覆盖用户修改。

| Project | Inspected ref | Commit | Date | Core scope |
|---|---|---:|---:|---|
| Legacy migration baseline | `codex/framework-lab` baseline | `7c10e26` | 2026-07 | extension provider, relay, SDK runner |
| Playwright | `origin/main` | `898655c6742c` | 2026-07-24 | protocol adapters, frame/page and actionability |
| Puppeteer | `origin/main` | `06442aeb8b03` | 2026-07-23 | CDP target/session, frame manager, locator |
| Cypress | `origin/develop` | `708dd7123e53` | 2026-07-23 | in-browser runner, actionability, command log |
| Browser Use | `origin/main` | `b909fbfba0ae` | 2026-07-24 | browser/session/DOM core only |
| Stagehand | `origin/main` | `2557a797fd68` | 2026-07-22 | browser drivers, refs, cache and action execution only |
| Page Agent | `origin/main` | `b7401a051c0c` | 2026-07-23 | PageController and element/action index only |
| Chrome DevTools MCP | `origin/main` | `e2c19fed80fc` | 2026-07-24 | DevTools tools, page identity, network/console/trace |
| Playwright MCP | `origin/main` | `55679f5f3d4b` | 2026-07-14 | Playwright capability projection and extension attach |
| agent-browser | `origin/main` | `fbd046c23a2c` | 2026-08-29 | native daemon, CDP/browser lifecycle and refs |
| OpenChrome | `origin/main` | `a0bd63a7ace1` | 2026-06-20 | real Chrome, target ownership/queue, trace core |
| PinchTab | `origin/main` | `ca73fadd4730` | 2026-07-22 | local orchestrator, bridge, tab ownership, snapshot |
| OpenCLI | `main` | `5256711a2545` | 2026-07-21 | extension/daemon browser bridge, profile routing, target and command-run leases, command journal and site adapter runtime |
| chrome-cdp-skill | local HEAD | source-only single-file runtime | 2026 | persistent per-tab CDP daemon |
| Browser Harness | `main` | `34e942fd7ca5` | 2026-07-21 | persistent browser-level CDP connection, flattened target-session switching, IPC runner and session-scoped event handling only |
| BrowserGym | `origin/main` | `9e779f087de9` | 2026-03-17 | browser automation observation/action/eval harness only |
| Webwright | `origin/main` | `4a46f282ec37` | 2026-06-03 | browser workspace, scripts and artifacts only |
| chromedp | `origin/main` | `7963c203ed54` | 2026-07-15 | Go CDP connection, target/session and query actions |
| Rod | `origin/main` | `f12b6b656fe6` | 2026-07-16 | Go CDP client, page/element/input and event routing |
| nodriver | `origin/main` | `a71cda374651` | 2026-05-13 | Python raw-CDP browser/tab/connection core |
| Pydoll | `main` | `51dd8bd3a94b` | 2026-07-24 | Python direct-CDP connection health, pending command lifecycle, event queue, navigation barrier and element actions |
| Chrome Remote Interface | `origin/master` | `a2e85b8094bc` | 2026-02-09 | minimal generated CDP transport and session routing |
| mcp-chrome | `origin/master` | `f48e71751e00` | 2026-01-06 | extension/native-host bridge and browser tools only |
| CloakBrowser | `origin/main` | `dcf9ba55d6e0` | 2026-05-29 | Playwright launcher/config/action wrapper; patched Chromium implementation is not present in this repo |
| Browserless | `origin/main` | `6c093530b813` | 2026-07-24 | browser process, session, concurrency and reconnect server |
| Steel Browser | `origin/main` | `5880b48c1af1` | 2026-07-20 | session API, CDP proxy, network/session artifacts |
| Selenium | `origin/trunk` | `5548a8a2be4c` | 2026-07-24 | WebDriver/BiDi context, Grid router/distributor/session ownership |
| WebdriverIO | `origin/main` | `e949f12d6405` | 2026-07-23 | protocol command lifecycle, BiDi pending calls, element middleware |
| TestCafe | `origin/master` | `f210cfcdbb58` | 2026-07-07 | in-page action runtime, request/script/navigation barriers, browser heartbeat |
| Crawlee | `origin/master` | `9dbb405adba9` | 2026-07-24 | browser/page pool lifecycle, capacity, retirement and hooks |
| Taiko | `origin/master` | `67299f0b4f3c` | 2026-07-10 | intent selectors, proximity search and navigation waits |
| Selenoid | `origin/master` | `d496072c7e81` | 2024-12-17 | container session admission, timeout and cleanup |
| Appium | `origin/master` | `e0c9018453ae` | 2026-07-24 | umbrella driver, session routing, plugin command chain and command queue |
| Automa | `origin/main` | `a4cbe34a60c9` | 2026-02-11 | extension workflow engine, tab/frame messaging and content-script injection |
| Browsertrix Crawler | `origin/main` | `7500e147267b` | 2026-07-23 | page worker lifecycle, CDP ownership, reuse and crash handling only |
| DrissionPage | `origin/master` | `5cf74e7b8430` | 2026-07-24 | raw CDP transport, tab/session registry, page lifecycle and dialog handling |
| Violentmonkey | `origin/master` | `f852423e8a6d` | 2026-07-25 | userscript pre-injection, realm routing, document/frame state and bridge |
| Nightwatch | local HEAD | `765afc35669d` | 2026-05-25 | async command tree, nested command context and WebDriver session projection |
| Karate | local HEAD | `c4650e90c38f` | 2026-07-24 | CDP driver, loader/document readiness, browser-context isolation and retry |
| Capybara | local HEAD | `15b5fdb76e97` | 2026-07-09 | selector query policy and recoverable-error synchronization |
| SeleniumBase | local HEAD | `74c0594ed793` | 2026-07-22 | synchronous CDP convenience actions and fallback/error behavior |
| k6 | local HEAD | `eac3e7e5310d` | 2026-07-23 | browser CDP connection/session, frame navigation barrier and test runtime integration |
| Vitest | local HEAD | `c050842b6e9e` | 2026-07-24 | browser project/provider command runtime, prewarm and teardown |
| Lighthouse | local HEAD | `1d58f5b06d28` | 2026-07-20 | protocol session, target manager, execution context and network gathering |
| Camoufox | local HEAD | `0583c3ec94f5` | 2026-07-18 | Firefox Juggler target/context provider and Playwright protocol patches |
| Lightpanda | local HEAD | `0066cad4d90d` | 2026-07-24 | CDP server, page/session identity and navigation replacement |
| Obscura | `origin/main` | `e314b9b0f32f` | 2026-07-24 | independent V8/DOM/network browser engine, CDP compatibility surface, per-connection isolation and navigation/context conformance |
| WebDriver specification | local HEAD | `14b5637636ca` | 2026-07-09 | session, current browsing context, element reference and input action contracts |
| Geckodriver | `release` | `4c23b8b2bea6` | 2026-07-23 | release-imported WebDriver Classic remote end, Marionette transport, Firefox/Android process and profile lifecycle |
| ChromeDriver | Chromium `main` | `56af9910977b` | 2026-07-25 | WebDriver session threads, DevTools client/WebView/OOPIF routing, script/navigation/dialog/input lifecycle |
| WebKit WebDriver / Automation | WebKit `main` | `98f32bc74dea` | 2026-07-25 | WebDriver remote end, SessionHost, UIProcess automation, BiDi realms, simulated input and screenshot lifecycle |
| Electron | `main` | `e12e04e87bb7` | 2026-07-24 | embedded Chromium WebContents/frame/RFH identity, DevTools client, host input/surface capture, session preload and webRequest |
| Chromium Embedded Framework | `master` | `803fe341dffd` | 2026-07-15 | embedded Chromium browser host, off-screen surface, host input, request context and in-process DevTools protocol |
| Tauri | `dev` | `3f5d3984bc89` | 2026-07-24 | cross-platform WebView runtime surface, initialization scripts, eval, lifecycle and provider-specific capability limits |
| webview | `master` | `cbbdee44afff` | 2026-03-09 | minimal cross-platform WebView host, GUI-thread dispatch, document-start scripts and JSON binding bridge |
| undetected-chromedriver | `master` | `757ed6a22052` | 2025-07-05 | ChromeDriver binary patch, Selenium wrapper, page preload evasions and performance-log event polling |
| Maxun | `develop` | `ca3138a2dbc8` | 2026-07-16 | Playwright browser service, per-user browser pool and workflow interpreter boundary only; recording and model-driven layers excluded |
| SikuliX | `master` | `c6f179904945` | 2026-05-15 | screenshot-region matching, visual target confidence, repeated capture search and OS-level input boundary |
| Karma | `master` | `84f85e7016ef` | 2024-07-29 | browser capture/launcher states, socket reconnect and no-activity lifecycle boundary only |
| Selenide | `main` | `c6ef238438a1` | 2026-07-22 | Selenium condition polling, dynamic element re-resolution and assertion diagnostics boundary only |
| BackstopJS | `master` | `930b3c863d39` | 2024-09-07 | scenario/viewport/selector screenshot matrix, readiness gates, reference/test/diff artifacts and visual failure projection |
| rebrowser-patches | `main` | `6373894fde83` | 2025-05-08 | Playwright/Puppeteer Runtime-domain patching, execution-context acquisition, isolated-world and sourceURL side effects |
| Web Platform Tests | `master` | `1985b47aa897` | 2026-07-24 | WebDriver fixture/session cleanup, browsing-context identity assertions, executor timeout and conformance result lifecycle |
| WebDriver BiDi specification | local HEAD | `a7b8b672df11` | 2026-07-20 | browsing context, navigation id, realm, script and network event contracts |
| Chrome DevTools Protocol | local HEAD | `a9544e3797c9` | 2026-07-23 | generated browser protocol domains and target/session command contracts |
| mitmproxy | `origin/main` | `a4b234a3e1ff` | 2026-07-18 | external HTTP/WebSocket proxy flow model, protocol layer state machine, addon hooks and native flow artifacts |
| Ferret | `main` | `b822033be289` | 2026-07-23 | current v2 engine/compiler/session/module/VM lifecycle; browser driver implementation is absent from this branch |

## Reading rule

- 项目定位来自 README/architecture 与真实 package layout 交叉确认；
- 底层原理必须指向源码文件或测试，不从 marketing 表格推断；
- 当前清单只从开源项目和公开协议规范形成底层实现结论；
- Agent loop、planner、prompt、model adapter、memory 和任务策略不进入本研究；
- ref 更新后，先重读关键实现 diff，再更新能力结论。

Geckodriver 的 canonical development source 位于 mozilla-central；这里读取的是官方 GitHub `release` 分支随 0.37.1 导入的可构建源码，因此结论对应发布实现，不冒充 mozilla-central tip。

ChromeDriver 从 Chromium 官方 Gitiles 的精确 commit 读取 `chrome/test/chromedriver` 子树与架构文档；没有用不完整的 Chromium clone 冒充本地仓库。WebKit 从官方仓库精确 commit 读取 `Source/WebDriver` 与 `Source/WebKit/UIProcess/Automation` 关键文件，结论不外推到未读的 port-specific 实现。
