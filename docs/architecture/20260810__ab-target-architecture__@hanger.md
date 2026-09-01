# AB 目标架构

这份文件定义最终产品的组成、状态所有权、公共对象和运行语义。施工顺序、替换边界和验收方式见[《AB 实施计划》](../plans/20260810__ab-implementation__@hanger.md)。

## 一、唯一运行链

```text
Agent process
  |
  | reads Codex-style Skill
  v
managed Node REPL MCP
  |-- Codex: built-in node_repl
  `-- other Agent hosts: Qwen node-repl-mcp
  |
  | persistent JavaScript session + MCP text/image content
  v
@hanger-source/ab/agent (Agent facade and Presenter)
  |
  | explicit observation identities
  v
@hanger-source/ab (Core TypeScript SDK, Node.js ESM)
  |
  | connect to fixed Unix socket; auto-start when absent
  v
ab-runtime (native Rust daemon, internal lifecycle)
  |
  | links the unique agent-browser-derived Rust engine
  v
agent-browser engine (Chrome/CDP, AX snapshot/ref/action)
  |
  | Chrome DevTools Protocol
  v
headed Google Chrome managed by the Rust server
  |
  +-- dedicated persistent profile
```

Chrome 显示真实页面。Rust Server 使用标准 headed Chrome，不嵌入 renderer，也不做 CEF/Electron 外壳。SDK 的 `connect()` 通过固定 Unix domain socket 连接 Rust daemon；socket 不存在时由 SDK 自动拉起 daemon。daemon 与 Chrome 跨 Agent/Node 任务常驻复用，但不暴露 `start/status/stop/restart` CLI、管理面或 TCP 端口。

## 二、部署单元

浏览器核心发布三个单元：

1. `@hanger-source/ab`：同一份 TypeScript 源码构建的 Node.js ESM 包和类型声明；根导出是显式 Core SDK，`@hanger-source/ab/agent` 子路径是 Codex-style Agent facade，两者共用同一 transport、对象与 native binary resolver；
2. `ab-runtime`：由 SDK 自动发现和拉起、在当前用户会话中常驻的 Rust 原生可执行文件；
3. `skills/ab/`：与 npm package/native binary 同版本发布的 Codex-style Skill、Agent bootstrap、API reference、操作路由和示例。

Agent host adapter 独立于这三个浏览器单元：Codex 使用自身已经启用的 `node_repl`；不具备同类 Tool 的 Agent host 在任务开始前配置仓库 `host/node-repl` 中的 Qwen `node-repl-mcp`。Skill 不在运行中安装或拉起 MCP，也不允许同时把两个 kernel 当成一个 session。Qwen host 的 reset/disconnect 只结束 JavaScript 状态，不改变 Rust daemon、Chrome 或固定 profile 生命周期。

Node.js ESM 是正式用户运行时。交互模式是宿主管理的持久 JavaScript MCP session；普通 `.mjs` 是无 MCP 环境的批处理入口，terminal REPL 只用于诊断。Bun 可以作为仓库开发期 package manager 或兼容执行器，但不是安装前提、Skill 前提或公共运行时合同。

初始正式支持平台是 macOS arm64 + 当前稳定版 Google Chrome。代码中的路径、进程和 IPC 边界保持可移植，但 Linux、Windows、Chrome Beta/Canary、Edge 与 Brave 不作为第一版完成证据。

## 三、状态所有权

| 状态 | 唯一 owner | SDK 持有什么 |
|---|---|---|
| daemon 单实例、版本与 Unix socket | Rust `DaemonRuntime` | 当前 client connection |
| SDK client session 与其资源 | Rust `ClientRegistry` | client id、transport 与 handle |
| Chrome 进程与 profile | Rust `ChromeRuntime` | 不可变 browser metadata |
| Browser CDP socket | Rust `CdpConnection` | 无 |
| target/tab | Rust `TargetRegistry` | target id handle |
| frame/OOPIF | Rust `FrameRegistry` | frame id handle |
| document/loader | Rust `DocumentRegistry` | document generation token |
| execution context/realm | Rust `RealmRegistry` | realm identity |
| CDP child session/domain lease | Rust `SessionManager` | resource id |
| observation 与 ref | Rust `ObservationStore` | observation id/ref token 的不可变对象 |
| Agent 最近一次已展示 observation | `@hanger-source/ab/agent` 的当前 Agent session + tab | observation id；只用于 `write()` 后续 ref/diff 便利，不成为浏览器事实 owner |
| Locator 查询 | TypeScript `Locator` | 不可变 Query AST；执行结果仍由 Rust 决定 |
| ElementHandle | Rust `ElementRegistry` | resource id + document identity |
| network/console/dialog/download/script | Rust `ResourceRegistry` | resource handle 与 sequence cursor |
| request Promise/AbortSignal | TypeScript client transport | request id |
| artifact 文件 | Rust `ArtifactStore` | path/hash/bytes/mediaType descriptor |

任何动态浏览器事实只能有一个 owner。Core SDK 不维护“当前 DOM”“当前 active tab”“最新 document”或 CDP domain refcount；Rust 也不解释 Agent 的业务目标。Agent facade 只记住它已经呈现给当前 Agent 的 observation id，不能据此改写 Rust 中的 document、ref 或 target 身份。

## 四、Rust Browser Server

### 4.1 隐藏 daemon 生命周期

`connect()` 执行以下确定流程：

1. 当前 Node module 已有健康 connection 时直接复用；
2. 否则连接当前用户固定 runtime 目录中的 Unix socket；
3. socket 不存在、拒绝连接或仅剩 stale inode 时，SDK 解析与自身版本匹配的 native binary，并以 detached 模式发起一次私有启动；
4. 多个 SDK 同时启动时，只有取得 daemon singleton lock 的 Rust 进程继续；其余启动进程退出，所有 SDK 都等待同一 socket ready；
5. daemon 持锁后才判断并清理 stale socket、绑定 socket，并把目录设为当前用户独占；
6. daemon 连接仍存活的专用 Chrome；若 Chrome 不存在才使用固定 profile 启动 headed Chrome；
7. SDK 与 daemon handshake 验证 exact server build、protocol version、当前 browser generation 和 client id；
8. Chrome、CDP 与 target registry ready 后，`connect()` 返回绑定该 client session 的 Browser。

`browser.disconnect()` 只结束当前 SDK client：拒绝该 client 的新请求，释放它拥有的 observer、CDP session、ElementHandle、observation 和 init-script resource，然后关闭 socket。Node 进程退出或 socket EOF 触发同一 client cleanup。它不关闭 daemon、Chrome 或其他 client 的资源。

daemon 没有 idle 自动退出；它在当前 OS 用户会话中持续运行，Chrome 与 tab 因此跨 Agent/Node 任务保留。用户主动关闭 Chrome或 Chrome crash 时，daemon 使当前 browser generation 的全部 handle 失效并拒绝 pending，不自动重放操作；下一次显式 `connect()` 才重新启动 Chrome。daemon crash 后 Chrome 可以继续存在，后续 SDK 自动拉起的新 daemon 通过固定 profile 的 `DevToolsActivePort` 重新接管，不重开第二个 Chrome。

Server 生命周期仍没有独立用户入口。不存在面向用户的 `server start/status/stop/restart`、管理 UI 或手工 daemon 配置；自动发现、单实例和版本接管只是 `connect()` 的内部语义。

macOS 第一版的内部 runtime 目录为：

```text
$TMPDIR/ab-<uid>/
  browser.sock
  daemon.lock
```

它在一次 OS 用户登录会话内固定，内容均可重建；持久 profile、artifact 与日志不放在这里。daemon 默认持续到系统注销/重启或内部版本接管，Chrome 可由用户正常关闭。

### 4.2 固定持久 profile

macOS 默认目录：

```text
~/Library/Application Support/ab/chrome-profile
```

daemon 只管理这一份 profile。启动参数至少包含：

```text
--user-data-dir=<固定 profile>
--remote-debugging-port=0
--no-first-run
--no-default-browser-check
```

Rust 从 `DevToolsActivePort` 读取 Chrome 的随机 loopback CDP 端口；这个端口只供 Rust 连接，不是 SDK transport。daemon singleton lock 与 Chrome 自己的 profile singleton lock 是两件事：前者保证一个 Rust owner，后者防止同一 user-data-dir 被两个 Chrome 使用。发现该 profile 已被一个带有效 `DevToolsActivePort` 的受管 Chrome 使用时必须重连；发现 profile 被无可用 CDP endpoint 的进程占用时返回 `profile_in_use_unmanaged`，不得切到临时 profile、连接用户日常 Chrome或启动第二个 Chrome。

profile 保存 cookie、localStorage、IndexedDB、Cache Storage、权限和其他 Chrome 持久状态。普通 SDK 断开和 daemon 版本接管都不关闭 Chrome。用户主动关闭 Chrome时由 Chrome 自己 flush profile；只有当前 daemon 自己启动、仍持有原始 process handle 且 pid/profile/browser generation 全部匹配的 Chrome，才允许在启动失败清理等内部场景中被 OS 终止。重新接管的 Chrome 不做 OS 级终止。

### 4.3 私有 Unix socket RPC

SDK 与 Rust 使用 versioned、length-prefixed JSON RPC over Unix domain socket：

- socket 位于当前用户独占的 runtime 目录，不监听 TCP；
- daemon 日志写入权限受限的滚动日志文件，不与 protocol frame 混流；
- 每条 connection 在 handshake 后获得独立 client id，并验证 SDK/server exact build 与 protocol version；
- 每个 request 有 id、method、target、params、deadline 与 trace context；
- terminal response 只能出现一次；
- SDK 超时会发送 cancel，但 cancel 不把已经产生的副作用说成“没有执行”；
- transport 断开不自动重放 navigate、click、fill、press 等操作；
- Rust 可以发送 stage、resource event、resource closed 与 browser-generation event；
- 大结果通过本地 artifact descriptor 交付，SDK 校验 sha256/bytes/mediaType 后读取，不在 JSON 中截断。

RPC 不引入 provider、workspace、extension origin、Node relay、TCP admission 或 token 服务。runtime 目录为 `0700`、socket 为 `0600`，daemon 在平台允许时校验 peer uid。多个 SDK 进程可以连接同一 daemon；每个 connection 的 pending、resource 与 cleanup 独立，浏览器事实 registry 仍只有 Rust 一份。

### 4.4 CDP 运行时

`CdpConnection` 维护 Browser endpoint 的 request correlation、event dispatch 与 pending rejection。`SessionManager` 使用 flattened target session 组织 page、OOPIF、worker 和其他 child target：

- target attach/detach 与 session identity 一一记录；
- frame tree 与 OOPIF session 通过 frame/target 事实关联，不按 URL 猜；
- domain enable/disable 按 session + domain 引用计数；
- 高层能力和 public `CDPSession` 共用一个 manager；
- session detach 立即关闭相关 pending 与 resource；
- Rust 不允许 capability 各自维护 CDP socket 或全局 domain 开关。

## 五、浏览器身份模型

### Browser

`Browser` 绑定当前 SDK client id、daemon runtime id 和 browser generation，暴露：

- `capabilities()`；
- `tabs.list/get/open()`；
- `resources.list/get/close()`；
- browser-wide download observer；
- `disconnect()`。

不暴露 extension provider generation、Chrome tab group 或 extension API matrix。

### Tab

`Tab` 绑定 CDP page target id，跨同一 target 的导航保持稳定。它提供：

- metadata、activate、navigate/reload/goBack/goForward、close；
- mainFrame、frames、frame 查找；
- `ax`、Locator、screenshot、CUA、evaluate、waitFor；
- CDP、network、console、dialog、download、file chooser 与 init script。

public id 使用 CDP target id 字符串，不伪造 extension 的数值 `tabId`。runtime 活着时不会因某个临时 handle 释放而隐式关闭 tab；关闭页面必须显式调用 `tab.close()`。

### BrowserContext

第一版没有 public BrowserContext。系统只有由固定 profile 支撑的 Chrome default context，这是产品需要持久登录态的直接结果。临时 context、incognito 和多 profile 会改变所有权与持久化语义，不作为隐藏选项存在。

### Frame

`Frame` 绑定 frame id 和所属 target/session。same-process iframe 与 OOPIF 在公共 API 中都表现为 Frame；Rust 内部保留它们不同的 session route。

frame detach 后 handle 失效。导航不会创建假 Frame identity，但会更新当前 document generation，使旧 Realm、AXRef 与 ElementHandle 按各自规则失效。

### Document 与 Realm

Document generation 由 server 在 loader/document/execution-context 变化时产生，不暴露成调用者自行维护的计数。MAIN 与 ISOLATED realm 是明确不同的执行环境：

- `frame.evaluate()` 默认 MAIN；
- selector helper、观察补充脚本和 init script 可以使用版本化 ISOLATED world；
- 一个 realm 失败时不自动切换另一个 realm；
- document replacement 立即拒绝旧 realm pending。

## 六、Core SDK 与 Agent 操作面

### 6.1 两层公共入口

`@hanger-source/ab` 根导出面向库调用者，所有 observation、ref、diff、screenshot 和 resource 都是显式对象：

```ts
import { connect } from "@hanger-source/ab";

const browser = await connect();
const tab = (await browser.tabs.list())[0];
const state = await tab.ax.snapshot({ mode: "interactive" });
await state.ref("e12").click({ observe: "diff" });
```

`@hanger-source/ab/agent` 面向 Codex-style Skill。它不复制 Core 或 Rust 引擎，只增加 Presenter、最近一次已展示 observation 与低摩擦 ref 动作：

```ts
import { connect } from "@hanger-source/ab/agent";

const browser = await connect();
const tab = (await browser.tabs.list())[0];
await tab.ax.write("state");
await tab.ax.click("e12");
```

Skill 默认只教 `@hanger-source/ab/agent`。需要完整类型、显式 observation 生命周期、资源编排或构建程序时直接使用 `@hanger-source/ab` Core；两层最终都发送同一组带 identity 的 AB RPC。

### 6.2 `get()`、`write()` 与展示基线

Agent AX 表面固定为：

```ts
type AXContent = "state" | "screenshot" | "both";

const observation = await tab.ax.get("state", options?);
await tab.ax.write("state", options?);
await tab.ax.write("screenshot", options?);
await tab.ax.write("both", options?);
```

`get()` 返回完整 typed object，既不向模型输出，也不推进展示基线。`write()` 通过注入的 `Presenter` 把结果真正交给当前 Agent：state 写入有来源和 observation 边界的文本；screenshot 交给宿主图片输出；both 同时呈现二者。普通页面文本、AX 名称、console、network body 都放在不可信内容边界内，不能被当作 Skill 指令。

`write("state")` 和 `write("both")` 成功呈现后，把该 state 的 observation id 记为当前 Agent session + tab 的 `lastPresentedObservationId`。`write("screenshot")` 不改变 AX 基线；`get()` 永远不改变基线。展示失败时不推进基线，避免 Agent 对一个自己没有看到的 state 使用短 ref。

`write("both")` 不是 SDK 顺序调用 snapshot 与 screenshot。它请求 Rust 在同一 capture transaction 中取得 AX、document/frame topology、viewport、scroll、DPR 与像素，返回前再次验证全部 identity；任一事实变化则整次失败，不交付错位的部分结果。

### 6.3 Agent ref 动作与 Core AXState

Agent 可以对最近一次已展示 state 使用短 ref：

```ts
await tab.ax.click("e12");
await tab.ax.fill("e8", "agent@example.com");
```

这不是把 `e12` 作为 server-global index 发送。Agent facade 必须解析当前 tab 的 `lastPresentedObservationId`，向 Core 发出显式 `observationId + refId`；Rust 再验证 client、tab、frame、document generation 与 backend node。没有展示基线时返回 `agent_observation_required`，基线属于其他 tab/document 时返回明确 stale error，不按 role/name 猜替代目标。

需要自由组织时仍使用 Core 对象：

```ts
const state = await tab.ax.get("state");
const submit = state.ref("e12");
await submit.click({ observe: "diff" });
```

`AXState` 是一次不可变 observation：

- `id`：server 生成的 observation id；
- `tabId`、frame scope、document generations；
- `text`：适合 Agent 阅读的层次化渲染；
- `refs()`：这次 observation 的 ref 描述；
- `diff(previous)` 或 capture 时显式 `diffFrom`；
- `dispose()`。

Core 的 `snapshot()`/组合 observation 是 AX 采集和 ref identity 的显式入口。`AXState[inspect.custom]` 只显示紧凑 metadata，不承担 Agent 内容呈现，也不推进任何 diff/ref 基线；程序读取正文使用 `state.text`，Agent 看页面使用 `tab.ax.write()`。

`AXRef` 绑定 observation id、tab、frame、document generation 与 backend node identity。新 observation 不会仅因“更新了 snapshot”就神秘地使旧 ref 失效；动作时 Rust 会重新确认同一 document 与同一 backend node。document 被替换返回 `stale_document`，节点被移除返回 `stale_ref`，不得按文本或相似度寻找替代元素。

### 6.4 Locator

稳定、重复的结构使用 Locator：

```ts
await tab.playwright.getByRole("button", { name: "提交" }).click();
await tab.playwright.getByLabel("邮箱").fill("a@example.com");
```

TypeScript Locator 保存不可变 Query AST，Rust 在每次读取或动作时针对当前 document 执行。第一版 Query AST 包含：

- CSS；
- role + accessible name；
- text；
- label；
- placeholder；
- alt text；
- title；
- test id；
- descendant/frame scope；
- `filter({ has, hasText, visible })`；
- `and`、`or`、`first`、`last`、`nth`。

单值读取和动作默认 strict。零匹配可以在 deadline 内等待；多匹配直接返回 `strict_violation`，不会随机选择。Locator 可以在同一 Frame 的新 document 中重新查询；ElementHandle 和 AXRef 不会。

这套 API 借鉴 Playwright 的使用语义，但不是 Playwright driver，也不宣称完整 Playwright compatibility。

### 6.5 ElementHandle

`locator.elementHandle()` 或 `state.ref().elementHandle()` 创建 server-owned ElementHandle。它绑定具体 frame、document generation 和 backend node/remote object：

- 适合连续读取同一实际节点；
- 必须显式 dispose，client session 关闭时统一释放；
- document replacement、frame detach 或 node detach 后硬失败；
- 不自动重新执行 Locator。

### 6.6 CUA

canvas、地图、远程桌面和没有可用语义节点的界面使用显式视觉入口：

```ts
const shot = await tab.screenshot();
await tab.cua.click({ x, y, viewportId: shot.viewportId });
```

坐标以 CSS viewport 为基准，并绑定 screenshot/viewport identity。viewport、DPR、scroll 或 document 已改变时返回 `stale_viewport`；不得把旧截图坐标直接派发到新页面。CUA 不伪装成 DOM/AX 定位，也不作为 Locator 失败后的自动 fallback。

### 6.7 evaluate 与 raw CDP

```ts
const title = await tab.dev.evaluate(() => document.title);
const session = await tab.dev.cdp();
await session.send("Performance.getMetrics");
```

函数式 evaluate 使用函数源码与结构化参数，支持 Promise、完整值与页面异常。raw expression 只经 CDPSession 使用。Agent `tab.dev.cdp()` 绑定 root session；Core `tab.cdp()` 与 `frame.cdp()` 继续绑定各自的 same-process/OOPIF session。对象由 server ResourceRegistry 持有，`Domain.enable/disable` 与高层 observer 共用 session + domain lease，dispose/client disconnect/target close 释放其全部 lease。Skill 不用 evaluate + `querySelector` 代替普通观察和交互；它只在需要页面专有数据、非 UI 计算或诊断时使用。

### 6.8 Core 组合观察

AX observation 与 screenshot 是不同事实面。Core `Tab` 提供显式组合采集，`@hanger-source/ab/agent` 的 `ax.get("both")` / `ax.write("both")` 直接调用这一个 primitive：

```ts
const view = await tab.observe({
  ax: { mode: "interactive", diffFrom: state },
  screenshot: true,
});

view.state
view.screenshot
```

```ts
type PageObservation = {
  state?: AXState;
  screenshot?: Screenshot;
};
```

`PageObservation` 只是一次原子操作的组合结果：`state` 仍是正常的 `AXState`，拥有 observation id、ref 与 dispose 生命周期；`screenshot` 仍是带 artifact、viewport identity 和像素信息的 `Screenshot`。组合对象不保存第三份页面真相。只有 Agent facade 在成功呈现 state 后更新自己的展示基线。

Rust 在同一 tab operation 内固定 target、frame topology、document generation、viewport、scroll 与 DPR，完成请求的 AX/DOM/layout 和 screenshot 采集后重新确认这些 identity。采集期间发生 document、viewport、scroll 或 DPR 变化时不交付互相错位的结果，而是返回明确的 observation consistency 错误。screenshot 在 Core 中仍是独立页面能力；`@hanger-source/ab/agent` 把 `state/screenshot/both` 放进同一个 `ax.get/write` 只是 Agent observation 的消费语义，不改变 Rust/Core 的事实分类。

## 七、观察引擎

### 7.1 采集

每次 observation 以明确 tab/frame scope 执行：

1. `Page.getFrameTree` 和 target/session registry 固定 frame 拓扑；
2. `DOMSnapshot.captureSnapshot` 获取 DOM nodes、attributes、layout tree、DOM rect、paint order 与必要 computed styles；
3. `DOM.getDocument(depth: -1, pierce: true)` 补充可解析 node tree 与 shadow DOM identity；
4. `Accessibility.getFullAXTree` 分 frame/session 取得 AX tree；
5. 读取 viewport、scroll、DPR、frame offset/transform；
6. 在版本化 isolated world 中补充 CDP 没有直接给出的少量交互事实，但不向页面写临时 attribute；
7. 以 `backendNodeId` 为主键合并 AX、DOM 与 layout；
8. 统一 same-process frame、OOPIF 和 open shadow root 的坐标与父子关系。

computed styles 只采集判断可见性和交互性所需字段，例如 display、visibility、opacity、pointer-events、cursor、overflow。观察引擎不抓取整份 CSS，也不把全 DOM 原样塞给 Agent。

Core `tab.observe({ ax, screenshot: true })` 以及 Agent `tab.ax.get/write("both")` 使用同一 Rust capture transaction：AX/DOM/layout 规范化并登记 `AXState` 后，在同一 target/document/viewport 约束内取得 screenshot；结束前再次核对 document generation、viewport、scroll 与 DPR。任一 identity 改变都使整个组合调用失败，不返回来自两个页面时刻的部分结果。

### 7.2 规范化节点

合并后的内部节点至少记录：

- frame/session/document/backendNodeId；
- AX role/name/description/value/states；
- tag、重要 attributes、DOM text 与表单关系；
- bounds、viewport intersection、paint order、visibility；
- focusable/editable/clickable/checkable/selectable 等确定性 hint；
- shadow/frame boundary 与来源缺失信息。

role/name 以 Chromium AX 结果为准；DOM text 和 cursor 只能补充交互判断，不能覆盖 AX 名称。没有 AX 映射但真实可交互的 DOM 节点可以进入 observation，并明确标记来源。

### 7.3 渲染、ref 与 diff

观察支持：

- `interactive`：可操作节点、表单上下文、必要标题与状态；
- `compact`：只保留当前任务后续操作最可能需要的结构；
- `full`：调试时输出完整语义树；
- `depth`、frame scope 和字符预算。

ref 只分配给可操作或对操作有必要语义的节点，显示名如 `e12`，其真实 token 不依赖这个短编号。

Rust/Core diff 必须显式指定 `diffFrom: observationId`，server 比较同 tab、兼容 document scope 的两个 observation。Agent facade 可以把当前 tab 的 `lastPresentedObservationId` 显式填入请求，但 Rust 不维护隐式“上一次 snapshot”。跨 document diff 可以报告 document replacement，但不能把新旧节点当作同一个元素。

ObservationStore 按 client session 保存有界记录；AXState lease 存在时不回收，`dispose()` 或 client 断开后释放。达到上限且全被 lease 占用时返回明确 resource limit，不静默丢掉仍可操作的 ref。

## 八、Locator 与动作执行

### 8.1 Selector engine

Rust 负责 Query AST 的执行计划。CSS/DOM 关系使用 CDP DOM 与一个固定版本的 isolated-world selector runtime；role/name 使用 AX；label、placeholder 等由 DOM 关系和 AX 结果联合确定。selector runtime 是产品代码，不接受任意外部 JavaScript，也不在页面中保留标记。

open shadow root 默认 pierce。iframe 必须通过 Frame 或明确 frame locator 进入，不跨 frame 猜匹配。closed shadow root 只有 Chromium CDP 能给出可操作 node identity 时才支持，否则返回明确 unsupported boundary。

### 8.2 Action pipeline

所有 Locator、AXRef 和 ElementHandle 动作进入同一个 Rust `ActionRunner`：

```text
bind target/session
  -> resolve exact node
  -> verify document identity
  -> strictness
  -> attached/enabled/editable checks
  -> scroll into view
  -> sample stable geometry
  -> compute frame/OOPIF coordinates
  -> hit-test
  -> arm navigation/dialog/file-chooser observers
  -> dispatch CDP input/form command
  -> collect action result
  -> optional post-action observation/diff
```

不同动作只启用适用的检查：fill 要 editable，check 要 checkable，select 要 select element，pointer click 要 hit target。`focus()`、DOM property invocation、pointer click 和 keyboard input 是不同方法，不能互相 fallback。

Locator 在 `not_found`、尚不可见、尚不稳定等可恢复机械状态上可以在 deadline 内重新查询。多匹配、document replacement、frame detach、权限错误与协议错误立即失败。AXRef/ElementHandle 只允许对同一 backend node 重做机械检查，绝不语义重定位。

动作返回 `ActionResult`：目标 identity、实际派发机制、开始/结束时间、navigation/document 变化、dialog/file chooser、最后 stage，以及调用者明确要求的 post-action observation。它不声称业务完成。

## 九、资源与信号

全部长期能力是当前 client session-owned Resource：

- `CDPSession`；
- `NetworkObserver`；
- `ConsoleObserver`；
- `DialogWatcher`；
- `DownloadWatcher` / `Download`；
- `FileChooserWatcher`；
- `InitScriptRegistration` 与 frame/document instance；
- `ElementHandle` 与 `AXState`。

每个 resource 有 id、owner、scope、state、createdAt、sequence、buffer completeness、close reason。event 从 sequence 递增；buffer overflow 必须产生 gap/overflow 事实，不能让 Agent误以为历史完整。

Network body 是否仍在 Chrome inspector cache、download 文件是否完整、dialog 是否仍打开、script instance 是否属于当前 document，都是各自资源的明确状态。

Init script 使用 `Page.addScriptToEvaluateOnNewDocument`、isolated world 与 `Runtime.addBinding` 建立 registration/instance/command/event 生命周期。它不依赖 extension userscript API，也不把站点 hook 固化成核心能力。

`browser.fetch()` 不进入目标 API：extension service-worker fetch 的凭证、CORS 和权限语义在直接 CDP 架构中没有等价 browser-level owner。需要页面登录态请求时显式使用目标 Frame 的 `evaluate(fetch)`；需要进程侧 HTTP 时由调用者使用自己的 HTTP client，并自行决定 cookie 边界。两者不得用同一方法名伪装成等价。

## 十、并发、调度与清理

- 每条 SDK connection 对应一个 client session；socket EOF 只回收该 client 拥有的临时 resource，不关闭共享 Chrome 或其他 client；
- 同一 tab 的写动作顺序执行；只读 capture 可在不会打断 domain/realm 的前提下并发；
- 跨 tab 独立调度；
- navigation、dialog 和 file chooser watcher 必须在动作前装配；
- SDK cancel 立即结束调用者等待，但 Rust 要把底层命令真实终态记录为 completed/cancelled/outcome_unknown；
- `browser.disconnect()` 与 socket EOF 释放当前 client resource；target close、frame detach、document replacement、Chrome crash 和 daemon exit 按 identity 向下传播失效；
- daemon crash 不要求 Chrome 跟着退出；新 daemon 只能重连经过固定 profile 与 `DevToolsActivePort` 验证的受管 Chrome；
- Rust/Core 没有隐式 active tab、current frame、latest observation 或全局 capture 开关；Agent facade 只有按 Agent session + tab 隔离的 last-presented observation id。

## 十一、错误与诊断

稳定错误至少包括：

```text
daemon_start_failed
daemon_handshake_failed
daemon_exited
daemon_version_in_use
runtime_socket_unavailable
profile_in_use_unmanaged
profile_mismatch
chrome_not_found
chrome_launch_failed
cdp_disconnected
target_closed
frame_detached
document_replaced
realm_destroyed
stale_ref
stale_element
stale_viewport
document_replaced_during_observation
not_found
strict_violation
not_visible
not_enabled
not_editable
not_stable
hit_target_intercepted
dialog_blocked
timeout
cancelled
outcome_unknown
resource_closed
resource_limit
buffer_overflow
artifact_corrupt
unsupported
protocol_violation
```

错误携带 request/runtime id、tab/frame/document/observation/ref/resource、action stage、CDP method、原始 cause 和可安全重试性。`retryable` 只描述机械上是否可再次发起请求，不触发 SDK 自动重试。

结构化 trace 使用同一 correlation id 贯穿 SDK request、RPC、Rust scheduler、CDP command/event 和 artifact。正常 stdout 只输出调用者结果；诊断日志不默认记录 cookie、输入值、页面全文、Authorization 或 response body。

## 十二、目标源码结构

```text
Cargo.toml                         Rust workspace

server/rust/
  Cargo.toml
  build.rs
  cdp-protocol/                    pinned browser_protocol.json / js_protocol.json
  src/
    main.rs
    config.rs
    daemon.rs                      singleton lock, detach, socket lifecycle, version handover
    chrome/                        executable, profile, lock, process, launch
    rpc/                           framing, handshake, protocol, request
    cdp/                           connection, generated types, session, domains
    browser/                       targets, frames, documents, realms, navigation
    observation/                   capture, merge, normalize, render, diff, refs
    selector/                      AST executor and isolated-world runtime
    actions/                       actionability, geometry, hit-test, input, form
    resources/                     registry, network, console, dialog, download, script
    artifacts/                     atomic file, hash, lease, cleanup
    diagnostics/                   stages, errors, trace

protocol/
  generated/                      Rust-derived TypeScript wire types
  schema/protocol-v3.schema.json

sdk/ts/
  package.json
  tsconfig.json
  src/
    connect.ts
    agent/                         Browser/Tab namespaces, Presenter, AX get/write/ref actions
    runtime/                       native binary, daemon discovery/auto-start, client session
    transport/
    errors/
    browser/
    tabs/
    frames/
    ax/
    locators/
    elements/
    actions/
    cdp/
    resources/

skills/ab/
  SKILL.md
  api-reference.md
  page-observation.md
  action-routing.md
  resource-lifecycle.md
  sdk-bootstrap.md

test/
  fixtures/browser-pages/
  rust/
  sdk/
  chromium/
  agent/
```

第一版保持一个 Rust server crate，通过模块表达责任；只有出现真实独立发布、编译或复用边界时才拆 crate。TypeScript SDK 只有一份 TS 源码，`dist/` JavaScript 和 `.d.ts` 都由构建生成。

## 十三、能力边界

最终存在：

- 持久 headed Chrome；
- tabs、frames、documents、realms；
- AX/DOM/layout observation、ref、diff 与 Agent `get/write` 展示面；
- Playwright-style Locator 语义；
- deterministic actions、screenshot 与 CUA；
- evaluate、wait、navigation、raw CDP；
- network、console、dialog、download、upload/file chooser、init script；
- 隐藏常驻 daemon、自动发现/拉起、多 client session、artifact、trace、版本匹配动态文档与直接 import 的 Skill bootstrap。

最终不存在：

- extension、Python relay、Node Server、WASM；
- 面向用户的 server 管理 CLI、status/start/stop/restart、TCP 端口和 runtime descriptor；
- Window/TabGroup extension 产品面；
- extension browser.fetch；
- public BrowserContext；
- Playwright runtime 或兼容层；
- Agent planner/model/self-heal 进入 Rust 核心；
- 旧路径 fallback、双协议、双 SDK 或双 server。
