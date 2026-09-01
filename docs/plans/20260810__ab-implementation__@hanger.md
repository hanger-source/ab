# AB 实施计划

这份计划把[《AB 目标架构》](../architecture/20260810__ab-target-architecture__@hanger.md)落到当前仓库。它定义实施依赖、每批生产链路、源码落点、旧路径退出、失败语义和真实完成证据。它不是进度日志；实施状态由 Git commit、构建输出和验收记录表达。

## 一、最终结果

完成后只有这一条运行链：

```text
Agent
  -> skills/ab
  -> ab/agent (Agent facade + Presenter)
  -> ab (Core TypeScript SDK)
  -> ab-runtime (Rust)
  -> CDP
  -> Rust Server 启动和管理的 headed Chrome
  -> ~/Library/Application Support/ab/chrome-profile
```

最终交付必须同时成立：

- 第一次 SDK `connect()` 在固定 Unix socket 不可用时自动拉起隐藏 Rust daemon 与可见 Chrome；
- 同一 Node 会话和后续独立 Agent/Node 任务都复用同一个 daemon、Chrome、tab 与固定 profile；
- `browser.disconnect()` 或 Agent 进程退出只释放当前 client resource，daemon 与 Chrome 继续常驻；
- Agent 面对未知页面默认得到 AX/DOM/layout 合并后的带 ref 状态；
- ref、Locator、CUA、evaluate 和 CDP 是明确不同的操作面；
- target/frame/document/session 变化有确定失效规则；
- network、console、dialog、download、file chooser、init script 和 artifact 有统一资源生命周期；
- TypeScript SDK、Rust Server 和 Skill 共享一套公开语义；
- extension、Python relay、手写 JavaScript SDK、protocol v2 和 evaluate-first Skill 完全退出正式构建与产品入口；
- 不存在兼容层、fallback、双 server、双 provider 或隐藏 Playwright runtime。

## 二、已经锁定的设计决定

实施期间不再把以下事项作为待选方案：

| 事项 | 决定 |
|---|---|
| 产品名 | `AB`，展开为 Agent Browser |
| SDK package | `ab`；根导出是 Core SDK，`ab/agent` 是同包 Agent facade |
| Rust binary/native package | `ab-runtime` / `@ab/runtime-darwin-arm64` |
| Skill 与本地目录 | `skills/ab/`、`~/Library/Application Support/ab/`、`$TMPDIR/ab-<uid>/` |
| 浏览器宿主 | Rust Server 启动标准 headed Google Chrome |
| profile | AB 专用、固定、持久 profile；不复用用户日常 Chrome |
| 浏览器协议 | Rust 直接连接 CDP |
| 服务端语言 | Rust native binary |
| TypeScript SDK | 一份 TypeScript 源码，编译为 Node.js ESM + `.d.ts`；Bun 不是用户运行时前提 |
| 进程模型 | SDK 通过固定 Unix socket 连接隐藏 Rust daemon；缺失时自动拉起；daemon/Chrome 跨任务常驻 |
| Agent 使用入口 | Codex-style Skill + `ab/agent`；程序化调用直接 import `ab` Core |
| Agent observation | `ax.get()` 只返回；`ax.write()` 真实呈现并推进 per-session/per-tab last-presented baseline |
| 默认观察 | AX + DOM + layout 合并的 interactive observation |
| 默认一次性定位 | observation ref |
| 稳定重复定位 | Playwright 风格 Locator AST，由 Rust 执行 |
| 视觉操作 | screenshot + 明确 CUA 坐标接口 |
| 底层逃生口 | 函数式 evaluate 与显式 CDPSession |
| model/Agent loop | 不进入 Rust Server/Core SDK；`ab/agent` 只负责呈现与操作便利，不调用模型 |
| Playwright | 只借鉴 Locator/actionability 语义，不运行 Playwright |
| extension/Python/Node server/WASM | 全部不存在 |
| Server 管理面 | 不存在用户 CLI、status/start/stop/restart、TCP 端口或 runtime descriptor；Unix socket 与单实例启动完全内部化 |
| at-browser/Electron/CEF/WebView | 不属于本计划 |
| compatibility/fallback | 不建设 |

任何实现问题都应在这条主线上解决，不能通过恢复旧 provider、临时 profile、备用 selector 或自动重放绕开。

## 三、当前代码与目标 owner 的迁移关系

当前仓库已经有一批值得保留的语义，但 owner 在 extension/provider 或 Python relay 中。迁移不是逐行翻译，而是把已经验证过的责任放到唯一的 Rust owner。

| 当前位置/能力 | 可保留的语义 | 目标位置 | 退出内容 |
|---|---|---|---|
| `server/bridge/*.py` | request correlation、deadline、artifact、trace、resource routing | `server/rust/src/rpc`、`artifacts`、`diagnostics` | Python 进程、provider/client 双端 relay、Python CLI |
| `extension/provider/runtime/provider-runtime.ts` | Browser runtime 的装配边界 | `server/rust/src/browser/runtime.rs` | extension provider、service worker lifecycle |
| `browser-state/graph.ts` | target/frame/document revision 与失效传播 | `browser/targets.rs`、`frames.rs`、`documents.rs` | window/tabGroup/extension event owner |
| `cdp-session-manager.ts` | attach/session/domain lease/pending/detach | `cdp/connection.rs`、`sessions.rs`、`domains.rs` | `chrome.debugger` 与 debugger owner 冲突模型 |
| `snapshot-runtime.ts` | document-bound snapshot/resource 基础 | `observation/*` | 只读 AX tree、简单全局 ref、无 DOM/layout 合并 |
| `locator-runtime.ts` | strict 与 Locator/ElementHandle 生命周期区分 | `selector/*`、`elements.rs` | 只有 CSS/role 的查询协议与页面侧零散逻辑 |
| `element-action-runner.ts`、`pointer-runtime.ts` | 分阶段 actionability、geometry、hit-test、输入 | `actions/*` | extension target、active-tab 假设和 capability 分散状态 |
| network/console/dialog/download runtime | resource + event + dispose 语义 | `resources/*` | extension API 事件和 provider resource owner |
| userscript runtime | registration/instance/command/event 生命周期 | `resources/init_scripts.rs` | extension scripting API 与旧 patch 产品面 |
| 早期 JavaScript SDK | Browser/Tab/Frame/Locator/Resource 对象经验 | `sdk/ts` | 手写 `.mjs` 与手写 `.d.mts` 两份事实、provider/workspace 字段 |
| `protocol-v2.schema.json` | request/response/stage/artifact/resource 消息分类 | Rust 派生 protocol v3 | provider hello/status、workspace、extension endpoint |
| 早期浏览器 Skill | 资源清理、函数式 evaluate 的纪律 | `skills/ab` 重写 | evaluate/querySelector 优先、extension 连接说明、CLI runner 入口与旧产品名 |
| `test/chromium/*.mjs` | 真实浏览器行为场景 | `test/chromium/*.ts` 与 Rust integration | extension 启动、Python relay 与旧 handshake fixture |

早期 SDK 与 Skill 只作为迁移阶段的阅读依据，不进入独立仓库或产品构建。其余旧 owner 可以在对应新能力完成前保留源码，但从第一条 native 纵向链接管 public package 开始，产品入口不得调用旧链路。每个后续批次完成时，旧 owner 同批退出构建、测试和文档；不建立 bridge adapter。

## 四、目标公共 API

TypeScript 是唯一 SDK 源码。下面的对象和方法是实施时要守住的公共形状；wire message 不直接暴露。

### 4.1 连接与 Browser

```ts
import { connect } from "ab";

const browser = await connect();
const tabs = await browser.tabs.list();
const tab = await browser.tabs.open("https://example.com");
await browser.disconnect();
```

`connect()` 是唯一连接入口。它先连接固定 Unix socket；socket 不可用时解析与 SDK 版本匹配的 Rust binary 并私有拉起 detached daemon，然后等待同一个 socket、Chrome 与 CDP ready。并发调用由 Rust singleton lock 收敛到一个 daemon。调用者不接触 PID、socket path、server status 或启停命令。

`browser.disconnect()` 释放当前 client 拥有的 resource 并关闭 SDK connection。Node socket EOF 或进程退出触发同一清理；它不关闭 Chrome、daemon 或其他 client 的资源。页面必须用 `tab.close()` 显式关闭，全局 Chrome 没有面向 Agent 的关闭 API。

### 4.2 Tab、Frame 与 Realm

```ts
const tab = await browser.tabs.get(targetId);
await tab.navigate(url, { waitUntil: "domcontentloaded" });

const frame = tab.mainFrame();
const childFrames = await tab.frames();
const value = await frame.evaluate((arg) => ({ title: document.title, arg }), 1);
```

`Tab.id` 是 CDP target id 字符串；`Frame.id` 是 CDP frame id。Tab 跨导航稳定，Frame 跨同一 frame 的导航稳定，Document/Realm/AXRef/ElementHandle 按 document replacement 失效。

### 4.3 Core AX observation

```ts
const state = await tab.ax.snapshot({
  mode: "interactive",
  frames: "all",
  maxChars: 24_000,
});

state.text
const result = await state.ref("e7").click({ observe: "diff" });
result.observation
await state.dispose();
```

`mode`、frame scope、depth/character budget、`diffFrom` 都是明确参数。截断只影响文本渲染，不能生成指向未保留节点的 ref，也不能把不完整 observation 说成完整。

Core `AXState[inspect.custom]` 只输出紧凑 identity/completeness metadata；正文由 `state.text` 显式读取。Core 不维护 latest observation，ref 动作始终携带明确 observation identity。

### 4.4 Agent AX facade

```ts
import { connect } from "ab/agent";

const agent = await connect();
const tab = (await agent.tabs.list())[0];

const state = await tab.ax.get("state");    // typed return; no display/baseline change
await tab.ax.write("state");               // model-visible text; advances AX baseline
await tab.ax.write("screenshot");          // model-visible image; no AX baseline change
await tab.ax.write("both");                // atomic state + pixels; advances AX baseline
await tab.ax.click("e7");                  // sends explicit observationId + refId
```

`ab/agent` 依赖同包 Core，不实现第二套 capture/action。`write("state"|"both")` 只有在 Presenter 成功后才按 Agent session + tab 保存 `lastPresentedObservationId`；`get()` 与 `write("screenshot")` 不推进。短 ref 动作没有基线时硬失败，不能使用 server-global RefMap、最新全局 snapshot、role/name 猜测或 silent fallback。

`AgentPresenter` 是公开的宿主输出边界：文本带 origin/observation/untrusted-content boundary；截图携带经过校验的 artifact/path 与 viewport identity。默认 Node Presenter 输出文本边界和截图路径，Agent 再使用宿主图片查看能力打开该路径；它不伪装成拥有 Codex Browser 的私有 response writer。其他宿主可以注入自己的公开 Presenter，Presenter 失败不得被“已展示”吞掉。

### 4.5 Locator

```ts
const submit = tab.getByRole("button", { name: "提交" });
await submit.click({ observe: "diff" });

await tab.getByLabel("邮箱").fill("a@example.com");
await tab.getByText("更多").filter({ visible: true }).nth(0).click();
```

Locator builder 只构造 immutable Query AST。`count/all` 允许多结果；动作、`elementHandle()` 和单值读取 strict。所有机械等待使用 `timeoutMs`/AbortSignal。

### 4.6 组合观察、CUA、screenshot、evaluate 与 CDP

```ts
const shot = await tab.screenshot({ fullPage: false });
await tab.cua.click({ x: 320, y: 180, viewportId: shot.viewportId });

const view = await tab.observe({
  ax: { mode: "interactive" },
  screenshot: true,
});
view.state
view.screenshot

const data = await tab.evaluate(() => globalThis.__APP_STATE__);
const cdp = await tab.cdp();
const metrics = await cdp.send("Performance.getMetrics");
await cdp.dispose();
```

Skill 必须把 AX write/ref、Locator、组合观察、CUA、evaluate 和 CDP 写成不同使用条件，不能把 CUA/evaluate/CDP 作为 Locator 失败后的静默补救。

`PageObservation` 是 Core `tab.observe()` 一次调用的组合返回，不是新的长期状态 owner。Agent `ax.get/write("both")` 直接使用同一 Core primitive。Rust 必须保证 AX 与 screenshot 来自同一 target/document/viewport transaction，不能由 Agent facade 或 Skill 先后调用两个方法再拼装。

### 4.7 Resource

```ts
const network = await tab.observeNetwork();
const response = await network.waitForResponse((event) => event.url.includes("/api/"));
const body = await network.responseBody(response);
await network.dispose();
```

resource handler 在 SDK 侧只是 event consumer。buffer、sequence、body retention、session 扩展、关闭原因和完整性由 Rust Server 管理。

## 五、protocol v3

### 5.1 单一事实源

Rust `serde` message types 是 wire contract 的唯一源码。构建生成：

- `protocol/generated/protocol-v3.ts`：SDK 内部 wire types；
- `protocol/schema/protocol-v3.schema.json`：契约审查与外部诊断；
- 固定 protocol version 与 capability version constants。

CI/verify 重新生成到临时目录并比较，禁止手工分别维护 Rust、TypeScript 和 JSON Schema 三份 shape。

### 5.2 消息族

只保留：

```text
daemon.hello / client.ready / browser.generation
request / cancel / response
stage
resource.event / resource.closed
daemon.event / client.closed
```

request：

```ts
type Request = {
  type: "request";
  id: string;
  method: string;
  target?: {
    tabId?: string;
    frameId?: string;
    documentGeneration?: string;
    observationId?: string;
    resourceId?: string;
  };
  params: unknown;
  deadlineUnixMs: number;
};
```

response 是 success/error 二选一。error 使用稳定 kind、stage、identity 和 details；artifact 是结果中的 descriptor，不再有 Python relay chunk protocol。resource event 含 resource id、sequence、event kind、value、completeness。

### 5.3 timeout、cancel 与副作用

- SDK 有调用侧 timer；Rust 收到 request 后建立执行侧 deadline；
- AbortSignal 触发 cancel，并使 SDK Promise settle-once；
- Rust 若尚未派发副作用，可以返回 `cancelled`；
- 已派发但无法确认结果时返回 `outcome_unknown`；
- transport close 统一 reject 所有 pending；
- SDK 不重放副作用方法；
- 只读调用是否重试也由调用者明确再次发起，transport 不自行判断。

## 六、隐藏 Rust daemon 与持久 Chrome

### 6.1 配置与目录

macOS 用户数据根：

```text
~/Library/Application Support/ab/
  config.json
  chrome-profile/
  artifacts/
  logs/
```

daemon socket 与 singleton lock 放在当前用户独占的短路径 runtime 目录中：

```text
$TMPDIR/ab-<uid>/
  browser.sock
  daemon.lock
```

它们在一次 OS 用户登录会话内固定，是可重建的运行时文件，不另写 `runtime.json`。持久数据仍只放在上面的 Application Support 根。

默认 profile path 是固定常量。产品配置可以显式保存 `chromePath` 和 `profilePath`，但 `connect()` 不根据每个调用临时切 profile。Rust singleton lock 保证只有一个 daemon；Chrome 自己的 profile singleton lock 保证只有一个 Chrome。profile 被无可用 CDP endpoint 的进程占用时返回 `profile_in_use_unmanaged`，不另起临时 profile。

测试使用独立的临时 test root，并把路径显式传给 server test process；测试机制不能污染产品 profile，也不能让产品代码在锁失败时自动落入临时目录。

### 6.2 SDK connection、自动拉起与 Unix socket

`sdk/ts/src/runtime/` 维护当前 Node module instance 的 connection cache，但不拥有全局 daemon：

- 解析当前平台、架构和 SDK 版本对应的 native binary；
- 先连接固定 Unix socket；已有健康 connection 时复用；
- `ENOENT`、`ECONNREFUSED` 或 stale socket 时，以 detached、无继承 stdio 的方式发起当前版本 daemon；
- 多个 SDK 同时发起也只等待同一个 socket ready，不各自认领一个 child；
- daemon 持有 singleton lock 全生命周期，只有持锁者可以清理 stale socket 并 bind；竞争失败的启动进程立即退出；
- length-prefixed JSON frame 在每条 socket connection 上独立 request id、pending map 与 event stream；
- handshake 完成并获得 client id、daemon id、browser generation 后才发布 Browser；
- socket EOF 立即拒绝该 connection 的 pending 并使其 handle 失效；不自动重放副作用方法；
- `browser.disconnect()`、Node `beforeExit` 或 socket EOF 只触发当前 client cleanup。

Rust 不监听 TCP，不写 runtime descriptor，也不提供用户可调用的 status/start/stop/restart 命令。runtime 目录权限为 `0700`、socket 为 `0600`，并在平台允许时校验 peer uid。

### 6.3 Chrome launch

Rust 按顺序查找：显式配置的 `chromePath`、macOS 标准 Google Chrome 路径。找不到立即返回 `chrome_not_found`，不切 Edge/Brave/Chromium。

daemon 先检查固定 profile 的 `DevToolsActivePort`。endpoint 存活且 product/profile marker 匹配时连接现有受管 Chrome；不存在时才启动 Chrome、等待 `DevToolsActivePort`，连接 `/json/version` 的 CDP browser websocket，并验证 product/protocol。超时要保存 Chrome stderr、pid、profile、args 和最后阶段，但不把 cookie 写入日志。

Rust 记录 Chrome pid、profile、browser generation、启动来源与可选 process handle。不会按进程名批量杀 Chrome；只有当前 daemon 自己启动且仍持有原始 process handle 的 Chrome，才允许在启动失败清理等内部场景中按全部 identity 验证后终止。daemon 异常退出时不杀 Chrome，新 daemon 通过固定 profile 内的 `DevToolsActivePort` 重新接管并标记为 reattached，保留 tab 与现场；reattached Chrome 不做 OS 级终止。

### 6.4 关闭与异常语义

- `connect()` 只在 socket 不可连接时发起 daemon，daemon singleton lock 消除并发重复拉起；
- `browser.disconnect()` 停止该 client 的新请求并释放其资源，Chrome 与 daemon 保持运行；
- socket EOF 由 Rust 解释为一个 client 消失，不影响其他 client；
- daemon 意外退出时各 SDK connection reject pending；Chrome 保持运行，下一次 `connect()` 拉起新 daemon 并重连；
- Chrome crash 或用户关闭 Chrome 时 daemon reject 当前 browser generation 的 pending、关闭相关 resource；下一次显式 `connect()` 才启动新 Chrome；
- transport 丢失时已经派发的副作用返回 `outcome_unknown`，SDK 不为“恢复连接”重放；
- daemon exact build 与 SDK 不同时，若没有其他 client 和进行中的副作用请求，旧 daemon 内部退出并由 SDK 自动拉起当前版本；Chrome 保持运行并由新 daemon 接管；
- 版本不同时若仍有其他 client 或进行中的副作用请求，返回 `daemon_version_in_use`，不强杀、不兼容执行；
- profile 被非受管进程占用时调用立即失败，不切目录，也不提供管理 CLI 绕过。

## 七、Rust CDP 内核

### 7.1 协议类型

`server/rust/agent-browser` 中准备好的完整 agent-browser Rust 源码是唯一底层引擎基底，固定 Chromium protocol JSON revision。`ab-runtime` 直接链接所需 native modules，不通过 agent-browser CLI/MCP/daemon 子进程。后续修改保留上游仓库、commit、Apache-2.0 与修改摘要，并进入第三方 NOTICE。

不用字符串 Map 作为高层实现的常态。已使用的 command/event 要有 serde 类型；public raw CDP 可以保留 JSON params/result。

### 7.2 Connection

`CdpConnection` 负责：

- 单调 command id；
- browser session 与 child session route；
- pending table settle-once；
- reader/writer task 终止传播；
- protocol error 与 connection close；
- event fan-out 到 registry，不直接实现 browser feature。

### 7.3 Session 与 domain lease

server 开启 `Target.setAutoAttach(flatten: true, waitForDebuggerOnStart: false)` 和必要 discovery。每个 session 记录 target type、target id、parent、frame mapping、attached state。

Network/Runtime/Page/DOM/Accessibility 等 domain 由 lease 管理。第一个 consumer enable，最后一个 consumer disable；target detach 关闭全部 lease 和 waiter。raw CDP consumer 请求同一 domain 时也进入同一 manager，不能和高层 observer 抢 owner。

### 7.4 Browser state

TargetRegistry、FrameRegistry、DocumentRegistry、RealmRegistry 共同维护：

- target created/infoChanged/destroyed；
- frame attached/navigated/detached；
- loader/document generation；
- executionContext created/destroyed/cleared；
- OOPIF session remap；
- invalidation 由上向下传播。

Tab handle 只绑定 target。每个 operation 开始时由 Rust 解析当前 frame/document/session，SDK 缓存 metadata 只能用于显示，不能决定命令 route。

### 7.5 Scheduler

每个 tab 有写动作队列；跨 tab 并行。navigation、pointer/form input、dialog handling、file chooser 设置属于写操作；snapshot、metadata 和普通读取在不会干扰 domain lease 的条件下并发。

cancel 结束 caller wait 不等于立刻释放 tab 写锁。底层命令、导航 watcher 或 action outcome 到达终态后才释放，避免下一动作和未知前一动作重叠。

## 八、Observation Engine

### 8.1 采用来源

- 以 agent-browser native Rust 的 AX snapshot、Chrome/CDP、ref/action 为唯一底层代码基底；
- browser-use 的 DOM/AX/layout/frame/shadow/OOPIF 处理只作为算法对照，验证后把缺失能力落回同一 agent-browser-derived Rust engine，不引入第二引擎；
- Codex Browser 是唯一 Agent UX 基准：AX-first、紧凑文本、get/write、ref 动作、动作后 diff、model-visible observation 和 state/screenshot 组合观察；
- 不复制 Codex 私有 WASM/runtime；不把 browser-use Python Agent 引入运行时。

### 8.2 Capture transaction

一次 capture 必须产生自洽 observation，而不是把不同时刻的缓存随意拼起来：

1. 绑定 tab、runtime id 和 frame topology revision；
2. 为涉及的 root/OOPIF session 取得 Page/DOM/Accessibility lease；
3. 读取 frame tree、viewport/DPR/scroll；
4. 对每个 session capture DOMSnapshot、deep/pierced DOM 与 AX tree；
5. 若 capture 期间 document generation 改变，整次返回 `document_replaced_during_observation`，不交付混合状态；
6. merge/normalize/render/assign refs；
7. 把 observation record 原子登记到当前 runtime 的 ObservationStore；
8. 释放临时 domain lease。

当请求是 `tab.observe({ ax, screenshot: true })` 时，capture transaction 继续在相同 target/document/viewport 约束内取得 screenshot，并在返回前重新读取 document generation、viewport、scroll 与 DPR。任一事实变化都返回明确 consistency error；不能交付 AX 与 screenshot 的部分成功，也不能由 SDK 把两次独立采集包装成“同一状态”。`PageObservation` 只组合已存在的 `AXState` 和 `Screenshot`，不拥有另一套 ref、diff 或生命周期。

### 8.3 Merge

以 `(sessionId, frameId, documentGeneration, backendNodeId)` 为主 identity：

- AX role/name/value/states 是语义来源；
- DOM 提供 tag、attributes、文本、label/for、form state、shadow/frame boundary；
- layout 提供 rect、viewport intersection、paint order、可见性；
- isolated helper 只补足 cursor、原生 property、contenteditable 等缺失事实；
- frame 坐标变换后统一到 tab viewport；
- 缺失 AX、缺失 layout 或跨域边界要记录 completeness，不能伪造默认值。

ref eligibility 使用明确规则：原生交互元素、可聚焦/可编辑元素、具有可操作 ARIA role 的节点、明确 onclick/tabindex/cursor hint 的可见节点，以及为这些节点提供必要 label/context 的语义节点。普通容器不因有文本就全部获得 ref。

### 8.4 Render

渲染格式稳定但不冻结页面措辞：

```text
heading "账户设置" [level=1]
textbox "邮箱" [ref=e3 value="a@example.com"]
checkbox "接收通知" [ref=e4 checked]
button "保存" [ref=e5]
```

interactive 默认按语义树保留父子上下文，折叠 ignored/纯布局节点。相邻文本合并要保持 label/name 边界。密码、token、Authorization 等敏感值默认遮蔽；调用者必须显式请求才读取 input value。

### 8.5 Observation/ref 生命周期

Observation record 存：

- id、runtime id、tab、createdAt；
- frame topology revision 与各 frame document generation；
- normalized nodes、rendered text、completeness；
- ref -> exact node identity；
- 可选 diff baseline id。

新 capture 不使旧 observation 自动失效。old ref 动作必须满足同 runtime id、tab/frame 仍存在、document generation 相同、backend node 仍 attached；否则返回精确 stale。ref 的显示编号只在 observation 内唯一。

`diffFrom` 必须由 SDK/Skill显式传递。diff 比较语义字段、值、状态、bounds/visibility 与节点增删；跨 document 只报告 replacement 和新状态，不做相似节点配对。

### 8.6 观察完成证据

真实 fixture 必须覆盖：

- 原生表单、ARIA 控件、disabled/hidden/readonly；
- onclick/cursor/tabindex/contenteditable 的非原生控件；
- open shadow DOM；
- same-origin iframe 与第二 origin 的 OOPIF；
- overlay、scroll、部分可见、零尺寸与 paint order；
- dynamic DOM 和 same-document mutation；
- new-document navigation 与旧 ref；
- interactive/compact/full、character budget 与 explicit diff。

证据要同时检查渲染文本、ref identity、bounds、completeness 和真实动作命中，不能只 snapshot 一段字符串。

## 九、Locator Engine

### 9.1 Query AST

在 `sdk/ts/src/locators/query.ts` 定义不可变 public AST builder；在 generated wire 中定义封闭 Query union。Rust `selector/ast.rs` 先验证结构、深度和嵌套资源 owner，再执行。

第一版实现顺序：

1. CSS + first/last/nth/count；
2. role + accessible name；
3. text/label/placeholder/alt/title/test-id；
4. filter(has/hasText/visible)、and/or；
5. frame scope 与 open shadow pierce。

每增加一种 query 都要在 Rust executor、SDK 类型、Skill reference 和真实 fixture 同批完成，不能只加 SDK builder。

### 9.2 执行

- CSS 与 DOM relation 在固定 isolated selector runtime 中执行，并转换到 backendNodeId；
- role/name 优先使用当前 AX 数据或即时 AX query，不以 innerText 冒充 accessible name；
- Locator 每次操作在当前 document 重新执行；
- query 返回 exact node identities，不把 selector string 交给 page 侧任意 eval；
- 单值/动作 multiple 立即 strict violation；
- query budget 防止恶意/错误 AST 无限递归；
- cross-frame 必须显式 frame scope。

### 9.3 Locator 与 AXRef 的关系

AXRef 是一次 observation 中对已看到节点的引用，适合 Agent 的即时动作；Locator 是可重复查询，适合确定结构。二者最终都解析成 `ResolvedElementTarget` 进入 ActionRunner，但 retain/retry/stale 规则不同。禁止把 AXRef 反向转成文本 Locator 来“增强成功率”。

## 十、Action Runtime

### 10.1 公共动作

第一版必须支持：

- click/doubleClick/hover；
- focus/scrollIntoView/wheel；
- fill/type/press；
- check/uncheck；
- selectOption；
- setFiles 与 file chooser；
- dragTo；
- textContent/innerText/getAttribute/boundingBox/screenshot；
- explicit DOM invoke，仅作为与 pointer 不同的 API。

### 10.2 Actionability

每个动作建立适用检查矩阵：

| 检查 | click | hover | fill | type/press | select | setFiles | drag |
|---|---:|---:|---:|---:|---:|---:|---:|
| unique/attached | 是 | 是 | 是 | 是 | 是 | 是 | 是 |
| visible | 是 | 是 | 是 | 目标需可见 | 是 | file input 可隐藏但需类型正确 | 是 |
| enabled | 是 | 否 | 是 | 是 | 是 | 是 | 是 |
| editable | 否 | 否 | 是 | 按目标 | 否 | 否 | 否 |
| stable geometry | 是 | 是 | 视需要 | 否 | 视需要 | 否 | 是 |
| hit-test | 是 | 是 | focus 前检查 | 视目标 | 视需要 | 否 | 是 |

隐藏 file input 的支持是 `setFiles` 明确机制，不扩散成所有动作可对 hidden node 强制执行。

### 10.3 坐标与 hit-test

- 使用当前 layout quad，不依赖 observation 中旧 bounds 直接点击；
- scroll 后重新取 geometry；
- 连续样本确认 rect 稳定；
- 计算 iframe/OOPIF offset、scroll、DPR；
- 选取可点击点并用 `DOM.getNodeForLocation`/同等 CDP 事实 hit-test；
- 命中目标自身或允许的 descendant 才派发；
- overlay/interceptor 返回其 node 摘要和坐标，便于 Agent 重新观察。

### 10.4 事件先于动作

ActionRunner 在派发前建立：

- navigation/document watcher；
- dialog watcher；
- file chooser watcher；
- download watcher（调用者请求时）；
- action stage trace。

派发后按明确等待条件结束。默认只保证浏览器机械动作完成，不猜“页面业务成功”。`observe: "diff"` 表示动作后执行一次 explicit observation diff；它不是业务完成判断。

### 10.5 重试规则

- Locator 的 not-found/not-visible/not-stable/hit-target 暂态可在 deadline 内重新解析；
- strict multiple、document replaced、frame detached、unsupported、permission/protocol failure 不重试；
- AXRef/ElementHandle 只重查同一 node 的机械状态；
- 同一 input dispatch 不自动重复；
- response 丢失后的副作用结果是 `outcome_unknown`；
- public API 不提供把 pointer 转成 DOM click 的 `force` fallback。

## 十一、资源、artifact 与长期页面逻辑

### 11.1 ResourceRegistry

Rust ResourceRegistry 统一 client owner、scope、state、sequence、buffer 和 dispose，但各 resource 保持自己的浏览器语义。client socket 关闭时只批量释放该 client 的资源；target/frame/document 失效按 scope 关闭所有相关 client resource。

### 11.2 Network

实现 request、response、loadingFinished/Failed、WebSocket frame 和 response body：

- observer 创建前 enable Network；
- OOPIF/new child session 按 registration 自动加入；
- event 带 session/frame/request identity；
- body retention 有 byte budget、eviction reason 与 unavailable；
- observer buffer overflow 产生 sequence gap；
- `waitForRequest/Response` 只消费已经建立的 observer，不在动作后补订阅。

### 11.3 Console 与 exception

Runtime/Log domain 事件规范化为 console/exception，保留 frame/session/context、level、timestamp、stack 与可安全序列化参数。RemoteObject 只在必要时 materialize 并及时 release。

### 11.4 Dialog

dialog-opened 建立独立 dialog identity，accept/dismiss 只能作用于仍打开的同一 dialog。页面 realm 被 alert 阻塞时仍能通过 Page domain 处理。无 watcher 的 dialog 也要更新 tab blocked state，使后续动作返回 `dialog_blocked`。

当前未闭环事实：click fixture 从首次运行起都会留下原生 confirm，尚无一次通过。`Input.dispatchMouseEvent` 返回不能证明本轮 click 不会随后打开 dialog；renderer 的 DOM event + timer barrier 也不能作为完成边界，因为原生 dialog 的 nested event loop 会让 timer 在 dialog 仍打开时运行。该方案已经排除，不再继续调参或重复 headed 测试。

最终实现必须采用 target/page CDP session 上从 `Page.enable` 开始常驻的 dialog owner，持续接收 `Page.javascriptDialogOpening` / `Page.javascriptDialogClosed`，再把精确 frame/session 归属投影到 tab blocked state 和 `Dialog` resource。只有 headless fixture 能稳定捕获、accept/dismiss、解除 blocked state，并且 headed 复验不再遗留弹窗后，本项才算完成。

### 11.5 Download 与 upload

- 使用 Browser download behavior/events；
- 每个 download 有 guid/url/suggestedFilename/path/receivedBytes/totalBytes/state；
- 文件完成后做 path containment、size/hash 检查；
- interrupted 保留原因，不返回假 path；
- `setFiles` 验证本地显式路径，使用 DOM.setFileInputFiles；
- 路径和文件内容不进入普通日志。

### 11.6 Init script

把当前 userscript 的真实价值收敛为：

- registration：name/world/frames/source/args；
- injection：current document + new document；
- instance：frame/document/state/error；
- `Runtime.addBinding` command/event channel；
- dispose 时停止未来注入并通知当前 instance cleanup。

页面 patch helper 可以作为 SDK/Skill 可选 helper，但 Rust 核心只拥有注入与通信生命周期，不拥有站点业务 hook。

### 11.7 ArtifactStore

截图、大 observation、network body、evaluate 大值和 trace export 使用同一 Rust ArtifactStore：

- 私有目录与 `0600` 文件；
- basename 净化和 resolved-path containment；
- temp write + hash + fsync + atomic rename；
- descriptor 包含 id/mediaType/encoding/bytes/sha256/path；
- runtime lease/dispose 与 TTL 回收；
- SDK 读取前验证 descriptor 与文件；
- 不返回截断数据冒充完整结果。

## 十二、Codex-style Skill

Skill 是完成质量的组成部分，不能等 API 写完后把方法列表复制进去。

### 12.1 默认决策梯

`SKILL.md` 要把 Agent 路由固定成：

```text
不知道页面结构
  -> tab.ax.write("state")
  -> 看 ref/name/role/state
  -> tab.ax.<action>(ref)

已知并会重复的稳定结构
  -> getByRole/getByLabel/Locator

没有语义节点的视觉目标
  -> screenshot
  -> CUA + viewportId

页面专有数据/非 UI 计算
  -> evaluate(function, args)

协议或浏览器机制诊断
  -> CDPSession
```

Skill 不再用 `document.querySelector` 作为普通第一步，也不教 Agent 捕获异常后盲换另一种机制。

### 12.2 动作后观察

- AXRef 动作默认示例使用 `observe: "diff"`；
- Locator 重复动作按任务需要选择 diff 或精确 getter；
- navigation 后取新 observation；
- 无变化先检查 action result/stage/document/dialog，不立即重复 click；
- 网络任务在动作前建 observer；
- screenshot/CUA 后重新截图或读语义状态验证。

### 12.3 Agent 输出

- `tab.ax.get("state" | "screenshot" | "both")` 只返回 typed object，不呈现、不推进展示基线；
- `tab.ax.write(...)` 通过当前宿主 `AgentPresenter` 真正呈现；state/both 成功后推进当前 Agent session + tab 的 last-presented observation，screenshot 不推进；
- `tab.ax.click("e7")` 等便利动作只使用最后一次成功呈现的 state，但发送到 Rust 的仍是显式 `observationId + refId`；
- `write("both")` 直接使用 Rust 原子组合观察，不默认让每次操作同时支付 AX 与截图成本；
- 页面 AX/DOM/console/network 文本必须包在明确的 origin/observation/untrusted-content boundary 内；
- Core `AXState`、`Screenshot` 和 `PageObservation` 保持完整，Presenter 不改变 browser identity 或底层生命周期。

### 12.4 Bootstrap

Skill 直接在 Agent 已有的 Node/JavaScript 执行环境中 import SDK：

```js
const { connect } = await import("ab/agent");
const agent = await connect();
```

- 不经过 `ab run`、shell wrapper 或管理 CLI；
- 同一 Node.js ESM 会话持续复用 `agent`、AgentTab、last-presented observation 和 observer binding；
- SDK 先连接固定 Unix socket，缺失时内部自动拉起 daemon；Skill 不检查 server 状态；
- JavaScript 会话结束或显式 `agent.disconnect()` 时只清理当前 client resource，Chrome/daemon 继续常驻；
- Codex 安装包从同一 release 携带 Skill、bootstrap、SDK 与 native runtime，并通过绝对 bundle 路径 import，避免依赖全局 npm resolution；
- 普通 Node module 直接 import npm `ab` 或 `ab/agent`。Skill 不安装 Bun，也不依赖 Bun REPL。

### 12.5 Skill 验收

不是检查 Skill 是否包含关键词，而是让 Agent 实际完成三类任务并查看 trace：

1. 陌生表单：AX write -> 短 ref 填写/点击 -> diff write 验证；
2. 稳定后台流程：Locator + 预先 network observer -> 多步操作；
3. canvas/视觉目标：screenshot -> CUA -> 新 screenshot 验证。

普通表单任务的 trace 若持续出现 Agent 自写 querySelector/evaluate、重复全页截图或盲 click，说明 Skill/SDK 操作面仍未完成。

## 十三、外部源码吸收与许可证

### 13.1 agent-browser

agent-browser 是 AB 唯一底层引擎源码基底。保留完整可追溯源码，`ab-runtime` 只链接 native CDP、Chrome、snapshot/ref/action 等引擎模块；不运行它的 CLI、MCP、chat、dashboard、skill manager 或 daemon 产品壳。

AB 自己拥有 profile 策略、Unix socket、client/session/resource identity 与公共协议。agent-browser 原有全局 RefMap 不能直接成为 AB 合同：Core 始终使用 observation id，Agent facade 的短 ref 也必须在客户端还原成 `observationId + refId`。本地改动逐文件审计；只保留进入 AB 真实调用链的修改，不扩张未被 AB 使用的 CLI/daemon action 分支。

### 13.2 browser-use

以固定 commit 的 DOM service 作为差异对照，检查 agent-browser-derived engine 是否缺少：

- DOMSnapshot、deep DOM、AX tree 的采集顺序；
- backendNodeId merge；
- layout/paint/visibility；
- frame、shadow DOM、cross-origin/OOPIF 处理。

发现真实缺口时，只把必要算法和 fixture 结论落回同一 Rust engine；不建立 browser-use provider、第二套 observation pipeline，也不引入 Python 包、Agent、LLM 或 cloud/session API。吸收以共同 fixture 的 observable result 为准，不以逐行形似为准。

### 13.3 Codex Browser

Codex Browser 是唯一 Agent UX 基准。借鉴当前可见的 Skill 和 operation semantics：AX-first、`get/write`、ref、Playwright-style、CUA、CDP、post-action observation、resource cleanup、model-visible observation、内容边界与 state/screenshot 组合观察。AB 用自己的 Presenter 与显式 observation/document/viewport identity实现；不复制不可见的私有 service、bundle、WASM 或闭源协议。

Codex 风格的“最近一次已展示 state”只存在于 `ab/agent` 的 Agent session + tab，并在 wire 上还原成显式 observation id；它不进入 Rust 全局状态。这保留了低摩擦操作语义，同时避免无身份的全局数字 index。

### 13.4 Stagehand、browser-harness、BrowserGym、Playwright

- Stagehand：只吸收“模型提议结构化动作、确定性 runtime 执行、必要时再观察”的分层；本计划不实现模型提议层；
- browser-harness：只吸收同一 Node 会话中的 short code、helper composition 与持久 handle 体验；不是依赖、引擎或运行时；
- BrowserGym：吸收 fixture task、observation/action/result/termination 评测记录；不成为生产依赖；
- Playwright：吸收 Locator/actionability 语义作为行为参照；不链接 Playwright driver。

### 13.5 源码台账

实施中同步维护 `source-ledger.md` 或单独 `THIRD_PARTY_NOTICES.md`：repository、commit、license、读取文件、移植文件、保留/改写范围。Apache-2.0/MIT 文件必须保留要求的 copyright/notice。专有来源只记录行为借鉴，不列为代码来源。

## 十四、施工批次

每批是一条能运行的完整语义链。生产代码先写完整，再做编译检查，然后跑真实边界试验，最后做对应提交。不存在“先建一堆空 trait/目录，之后再接”。

### 批次 1：Native spine 与持久 Chrome 最小闭环

生产链：

```text
TS connect/tabs/navigation/screenshot/CDP
  -> protocol v3
  -> Rust RPC
  -> Chrome profile/process
  -> Browser CDP connection
  -> target list/create/navigate/capture
```

改动：

- 根 `Cargo.toml` 与 `server/rust` 单 crate；
- Chrome path/profile lock/process/DevToolsActivePort；
- SDK Unix socket transport、daemon auto-start、handshake、request/response/error；
- Rust daemon singleton lock、stale socket recovery、client registry 与 exact-version handover；
- CDP connection 和最小 target registry；
- `sdk/ts` package、connect、Browser/Tabs/Tab、native binary resolver；
- root verify 切到 Rust + TS；
- `ab` Core public export 切到 `sdk/ts`；`ab/agent` 在同 package 中建立但不复制 Core。

这一批接管 public entry 后，旧 extension/Python relay 不再启动，也不参与 verify。尚未迁移的方法明确不存在或返回 compile-time/API absence，不能转发旧 provider。

真实完成证据：

- 空 test root 启动可见 Chrome；
- 两个独立 Node 进程并发 `connect()` 只出现一个 Rust daemon/Chrome，且连接获得不同 client id；
- list/open/navigate/screenshot/raw CDP 成功；
- 第一个 client 打开 tab 并设置 cookie/localStorage/IndexedDB，断开后第二个独立 Node 进程仍看到同一 tab 与状态；
- profile 被无 CDP endpoint 的进程占用时硬失败，没有第二 Chrome/临时 profile；
- `browser.disconnect()`、socket EOF 和 Node 正常退出只释放对应 client resource，daemon/Chrome 保持运行；
- daemon crash 后重新 `connect()` 会重启 daemon并接管仍存活的 Chrome，不丢 tab。

### 批次 2：Target/Frame/Document/Realm/CDP Session 内核

改动：

- Target auto-attach、session route、domain lease；
- Frame/Document/Realm registry；
- navigation result/waits；
- scheduler、deadline/cancel/outcome_unknown；
- function evaluate 与完整值；
- public Frame/Realm/CDPSession；
- runtime id 与失效传播；
- client-owned ResourceRegistry 基础。

迁移现有 frame/evaluate/cdp/navigation live 场景到 TS + Rust。旧 extension browser-state graph、CDP manager、page runtime 的 owner 在本批退出正式源码路径。

真实完成证据：

- main frame、same-origin iframe 与 OOPIF evaluate route 正确；
- new-document navigation 使旧 Realm 失败但 Tab/Frame 语义正确；
- target/session detach 立即 reject pending；
- 同 tab 写操作有序、跨 tab 并行；
- cancel 期间不会释放写锁导致下一动作重叠；
- daemon/Chrome 断线错误包含最后 CDP/stage，而不是 generic timeout。

### 批次 3：Observation Engine 与 ref

改动：

- DOMSnapshot/deep DOM/AX capture；
- agent-browser-derived Rust merge/normalize，并用 browser-use fixture/算法对照补足已确认缺口；
- layout/frame transform/visibility/paint；
- interactive/compact/full renderer；
- ObservationStore、AXState、AXRef、explicit diff；
- observation artifact 与 completeness；
- SDK `tab.ax`；
- `AXState` 的 Core inspect 只保留 metadata；Agent 内容展示留给后续 `ab/agent` Presenter。

旧 `snapshot-runtime.ts`、`PageSnapshot` 和简单 ref map 同批退出。Skill 的页面观察入口立即切成 AX-first，即使动作能力仍在下一批完善；不能继续保留 evaluate-first 作为过渡建议。

真实完成证据使用第八节 fixture 矩阵，尤其验证 OOPIF、shadow、overlay、dynamic DOM、document replacement 和 ref/stale，而不只比对文本。

### 批次 4：Locator Engine 与 ElementHandle

改动：

- Query AST/生成 wire union；
- Rust selector executor 与 isolated selector runtime；
- CSS/role/text/label/placeholder/alt/title/test-id；
- filter/composition/nth/frame scope/shadow；
- strict、等待、count/all/getter；
- ElementHandle registry/dispose/stale；
- SDK Locator builders 与类型。

旧 DOM locator capability 同批退出。真实完成证据：accessible name 不等于 innerText 的 fixture、duplicate strict、动态 replacement、frame/shadow scope、Locator 跨新 document 重查、ElementHandle 不重定位。

### 批次 5：Action Runtime、CUA 与 post-action observation

改动：

- ActionRunner 和检查矩阵；
- geometry/stability/frame coordinates/hit-test；
- pointer/keyboard/form/select/file/drag/scroll；
- navigation/dialog/file-chooser pre-arm；
- screenshot viewport identity 与 CUA；
- 同一 target/document/viewport transaction 的 `tab.observe({ ax, screenshot })` 与 `PageObservation`；
- ActionResult、`observe: diff`；
- stable error taxonomy 与 stage trace。

旧 element/pointer/input/form runtime 同批退出。真实完成证据：overlay interception、moving target、disabled/editable、hidden file input、OOPIF 坐标、old viewport、navigation click、dialog-blocked、response lost/outcome_unknown。不得以 DOM click fallback 让测试变绿。

### 批次 6：Signals、downloads、init scripts 与 artifacts

改动：

- ResourceRegistry 完整状态机与 sequence/completeness；
- Network/Console/Dialog/Download/FileChooser；
- response body retention；
- init script registration/instance/binding；
- Rust ArtifactStore；
- SDK resource handles；
- client socket EOF/target close/document change cleanup。

旧 extension resource runtime、userscript runtime、Python artifact store 同批退出。真实完成证据：动作前 network wait、OOPIF/new child session 订阅、buffer gap、body eviction、alert realm blocked、download complete/interrupted、script reload/frame instance、client 断开后的定向释放以及其他 client 不受影响。

### 批次 7：Agent 使用面、SDK bootstrap 与 Skill

改动：

- `ab/agent` AgentBrowser/AgentTab/AgentAX facade，只封装 Core 的真实公共 API；
- `AgentPresenter`、untrusted content boundary、`get/write(state|screenshot|both)`；
- per-Agent-session/per-tab last-presented observation 与显式 observationId/refId 动作；
- 重写 Skill、observation/action/resource/bootstrap reference；
- 在 Agent JavaScript 环境中直接 import SDK，并跨独立任务复用 daemon/Chrome；
- AX-first、Locator-repeat、CUA-visual、evaluate/CDP-diagnostic 路由；
- 动作后最小观察与不盲重试规则；
- 默认 Node Presenter 真实输出 AX 内容边界与截图 artifact/path；Agent 使用宿主图片查看能力打开截图，其他宿主可显式注入公开 Presenter；
- 安装包提供与 runtime 同版本的动态 `agent.documentation()` topic 文档，Skill 主文件保持短小；
- Agent task fixtures 与 trace inspection。

这一批不是文档收尾：若 Agent 仍被 API 迫使频繁写临时 querySelector，回到 observation/Locator/action 代码修产品面，不能只在 Skill 里劝它“正确使用”。

### 批次 8：彻底退出旧体系与发布闭环

改动：

- extension、`server/bridge`、protocol v2、旧 Python/extension tests 从正式产品结构退出；早期 SDK 与 Skill 不进入独立仓库，只作迁移阶段的阅读依据；
- root build/verify/package 移除所有 WXT、pytest relay 和旧 SDK 输入；
- README/API reference/package exports 只剩新链；
- source ledger/NOTICE 完整；
- `ab` 根导出、`ab/agent` 子路径、platform native optional dependency、SDK-daemon handshake 与版本接管；
- 完整真实 Chromium 与 Agent acceptance。

退出旧体系不是保留一个 legacy flag。仓库内不得存在能重新启动旧 provider 的正式脚本、依赖、文档命令或 fallback adapter。

## 十五、验证体系

### 15.1 静态与构建

最终 root verify 依次执行：

```text
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
pnpm --dir sdk/ts typecheck
pnpm --dir sdk/ts build
pnpm --dir sdk/ts test
protocol generation drift check
native Chrome integration suite
Agent acceptance suite / recorded trace assertions
```

具体 script 名在实现时写入 package/Cargo 配置，以配置为唯一入口；不让文档命令和实际项目脚本分叉。

### 15.2 Fixture browser

建立一个真实本地 HTTP fixture server，至少有两个 origin 以触发 cross-origin iframe/OOPIF。页面集合：

```text
profile-state.html
semantic-controls.html
dynamic-dom.html
shadow-dom.html
frames.html
actions.html
overlay-and-motion.html
dialog.html
download.html
network.html
init-script.html
canvas.html
```

fixture 只提供现实浏览器行为，不复制生产状态机。断言必须从独立页面结果、CDP 事件、下载文件或重新启动后的存储读取，而不是由被测实现自己生成 expected。

### 15.3 持久化验收

1. 用 test runtime root 与 test profile 调用 `connect()`，由 SDK 自动启动 daemon/Chrome；
2. fixture 设置 cookie、localStorage、IndexedDB 和权限允许状态；
3. 打开一个可识别 tab，记录 daemon pid、Chrome pid、target id 与 browser generation；
4. `browser.disconnect()` 并结束第一个 Node 进程，确认该 client resource 已释放而 daemon/Chrome pid 与 tab 保持不变；
5. 启动第二个独立 Node 进程调用 `connect()`，通过页面与 CDP 两个独立入口读取同一 tab 和存储；
6. 只终止 test daemon，保留 Chrome，再次 `connect()`，确认新 daemon 接管同一 Chrome pid、target id 与存储；
7. 用户式正常关闭 Chrome 后再次 `connect()`，确认新 Chrome 使用同一 profile 恢复持久存储，但旧 browser generation/target handle 硬失效。

真实网站登录可作为人工验收，但自动 gate 不依赖外部账号和网络。

### 15.4 Identity/stale 验收

- Tab 跨导航保持 target identity；
-旧 Realm/ElementHandle/AXRef 按各自规则失败；
- same-document DOM replacement 不能让 old ref 点到“看起来相似”的新节点；
- OOPIF process/session 变化不串 frame；
- old screenshot viewport 坐标硬失败；
- target close、Chrome crash、daemon exit 和新 browser generation 都使对应旧 handle 失效；client 断开只使该 client 的 handle 失效。

### 15.5 动作验收

每种动作至少有一个会在现实错误实现下失败的 fixture：

- duplicate selector 暴露 strict；
- overlay 暴露 hit-test；
- moving element 暴露 stability；
- disabled/readonly 暴露 enabled/editable；
- iframe offset 暴露坐标 route；
- alert 暴露 pre-armed dialog；
- navigation click 暴露 watcher ordering；
- file chooser/download 暴露 resource lifecycle。

不为常量、类型映射或文档措辞写伪行为测试。

### 15.6 Runtime ownership 与故障验收

- 同一 Node 会话和两个独立 Node 进程的 `connect()` 都复用一个 daemon/Chrome；
- 不同 socket connection 获得不同 client id，断开一个只释放它自己的 resource；
- 跨 tab 可以并行，同 tab 写动作由 Rust 排序；
- `browser.disconnect()`、socket EOF 和 Node 退出释放当前 client resource，daemon/Chrome 与其他 client 不受影响；
- daemon crash 时 SDK pending 失败，新 daemon 接管经过 profile、pid 与 `DevToolsActivePort` 验证的 Chrome；
- stale socket 与并发 auto-start 不会产生第二 daemon 或第二 Chrome；
- exact-version mismatch 在 daemon 空闲时内部接管，在仍有其他 client/副作用请求时返回 `daemon_version_in_use`；
- RPC 断开后的 click 返回 outcome_unknown，不自动重复；
- artifact hash/size 损坏能被 SDK 拒绝；
- buffer overflow 交付 gap，而非无声丢事件。

### 15.7 Agent 验收

使用实际 Codex-style Skill 完成固定任务，不直接给 selector：

- 在陌生设置页找到并修改表单；
- 进入 iframe/shadow 页面完成多步动作；
- 建 observer 后触发网络请求并读取结果；
- 处理 dialog/download；
- 在 canvas 页使用 screenshot/CUA。

验收读取 SDK/Rust trace，确认：

- 初始使用 AX observation；
- `ax.get()` 不产生模型输出或推进 baseline，`ax.write()` 才产生可见输出；
- write(state/both) 后短 ref 精确落到已展示 observation，write(screenshot) 不改变 AX baseline；
- ref 与 Locator 的选择符合任务稳定性；
- 同时请求 AX 与截图时，两者属于同一 document/viewport；
- watcher 在动作前建立；
- 普通控件没有反复自写 JS 搜索；
- 动作后使用 diff/精确事实，而非盲点第二次；
- 失败时 Agent 能从 error stage 继续决策。

## 十六、性能与资源预算

Chrome 本身是主要内存使用者，不能用“Rust 很轻”掩盖页面和 snapshot 成本。每次 release 验收记录：

- Rust daemon 与 Chrome idle RSS/CPU；
- cold `connect()` 到 daemon ready、Chrome ready；
- 已有 daemon/Chrome 时跨进程 warm connect latency；
- interactive/full observation capture、merge、render 各阶段耗时与节点数；
- RPC inline/artifact bytes；
- Locator resolve 与动作各 stage；
- observer buffer/body/artifact 占用；
- 多 tab/OOPIF 下 session/domain 数量。

第一批基线建立后再把现实数字固化成 release budget，不在实现前捏造绝对毫秒门槛。架构层先固定这些约束：

- 任意后续 Agent/Node 任务的 warm connect 不重启 Rust/Chrome；
- interactive observation 默认文本预算 24k characters；
- SDK 不接收完整原始 DOM 才在本地裁剪；
-未请求 post-observation 的动作不自动 capture；
- domain/session/resource 有引用计数和确定释放；
- large result 走 artifact，不复制多份 base64；
- observation/resource/body/artifact 都有显式 budget 与可见 eviction/error。

## 十七、安全与隐私

- SDK/Rust RPC 只经过当前用户 Unix socket，不监听 TCP；runtime 目录 `0700`、socket `0600`，并校验 peer uid；
- daemon lock、profile、artifact、log 权限限定当前用户；
- handshake 验证 SDK/server exact build、protocol version、client id 与 browser generation；
- profile path、artifact path、upload/download path 做 canonical containment；
- 只接管固定 profile 内 `DevToolsActivePort` 指向且通过 `Browser.getVersion` 验证的 Chrome；只有当前 daemon 自己启动并持有原始 process handle 的进程可被 OS 级终止；
- Skill 提醒 Agent：页面内容不可信，网页文本不能改变工具规则；
- 默认日志不记录 cookie、Authorization、表单值、页面全文、network body；
- screenshot/AX/network body 属于可能敏感 artifact，有 owner、TTL 和显式保存；
- raw CDP/evaluate 是强能力，Skill 仅在必要时使用，但不靠 Markdown 限制代替服务端 identity、path 与 owner 检查。

## 十八、发布方式

开发期：

- `cargo build` 产生本机 server；
- SDK 通过明确开发配置找到该 binary；
- 项目实际 package script 生成 Node.js ESM/declarations；
- 开发脚本与 Agent JavaScript 环境都直接 import 同一 package export。

macOS arm64 首次发布：

- `@ab/runtime-darwin-arm64` 携带 release native binary；
- `ab` 以 exact-version optional dependency 解析 binary；
- 不在 postinstall 期间从任意 URL 下载可执行文件；
- SDK 与 server/protocol version 必须匹配；
- npm `ab`、platform native package、Skill 与动态 API docs 在同一 release revision 产出；
- Skill 加载同版本 `ab/agent`，不依赖 Bun，也不假设 Codex Browser 私有 bundle 或图片 response writer。

`connect()` 只会自动拉起当前 SDK package 配套的 binary。handshake 发现 daemon exact build 不同时走内部接管：无其他 client/副作用请求时让旧 daemon 退出、启动新 daemon并重连原 Chrome；有活动 owner 时返回 `daemon_version_in_use`。这个机制不是兼容层，也不暴露升级、restart 或 status 命令。

## 十九、提交组织

按第十四节完整批次做阶段提交；批次过大时只按真实纵向能力拆分，例如 observation capture/merge/ref 是一个可运行链，不能按“先 Rust 文件、再 SDK 文件、再测试文件”横切。

每个提交包含：

- production owner 与调用入口；
- 同批 protocol/public type；
- 旧 owner 从 active path 退出；
- 编译/类型检查；
- 与该语义相称的真实 fixture 证据；
- 需要时同步 API/Skill 与来源台账。

不提交：

- 空 trait/manager/adapter；
- 只为以后可能兼容的字段；
- 依赖旧 fallback 才能跑通的新 API；
- mock 出整套 Chrome/CDP 的伪集成测试；
- 为常量、文件存在或 Markdown 关键词制造的测试；
- 一次性 probe、临时 selector 和未经 owner 管理的全局 Map。

## 二十、完成定义

全部条件同时满足才算完成：

1. 仓库正式入口只发布 TypeScript SDK、Rust Server 与 Skill；
2. Rust Server 独占并持久管理专用 Chrome profile；
3. Chrome 可见、重启后登录/站点状态仍在；
4. target/frame/document/realm/session identity 与失效在 OOPIF/navigation/crash 下通过真实验证；
5. observation 合并 AX/DOM/layout，ref/diff 有明确 revision 与 stale 语义；
6. Locator AST 在 Rust 执行，strict/actionability/hit-test 不靠 fallback；
7. ref、Locator、CUA、evaluate、CDP 五种入口各有清楚边界；
8. network/console/dialog/download/file chooser/init script/resource/artifact 可创建、消费、诊断和释放；
9. daemon singleton、Unix socket auto-start、client ownership、socket EOF、版本接管、Chrome 重连、cancel、disconnect 和 outcome_unknown 有真实故障证据；
10. Skill 让 Agent 在普通页面实际使用 AX/ref/Locator，而不是继续频繁自写 querySelector；
11. extension、Python relay、Node Server、WASM、Playwright runtime、at-browser 和旧 protocol/public API 不在构建、运行、文档或 fallback 中；
12. 来源、许可证、package、native binary 与 SDK/binary release version 闭环完整。

满足这些条件后，AB 才不是“一个更自由但 Agent 仍然不会用的 CDP 库”，而是一套由成熟观察引擎、确定性浏览器 runtime、TypeScript 操作面和 Codex-style Skill 共同组成的 Agent 浏览器底座。
