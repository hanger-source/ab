# AB 的项目本质

## 一句话定位

AB（Agent Browser）是面向 Agent 的本地浏览器运行时：由一个原生 Rust daemon 启动和管理专用 Chrome，以固定持久 profile 保存登录态与站点状态；TypeScript Core SDK 把 CDP 的 target、frame、document、AX、DOM、输入和事件组织成稳定对象；`@hanger-source/ab/agent` 把这些显式对象变成 Codex-style 的 `get/write/ref/action` 操作面；Skill 决定 Agent 在什么时候观察、定位、操作、验证与降级到更底层能力。

`AB` 是产品简称，公开 npm package 固定为 `@hanger-source/ab`：根导出是 Core SDK，`@hanger-source/ab/agent` 是同包 Agent facade。研究材料中提到的 `agent-browser` 是 AB 唯一底层引擎源码基底，始终写全名，不把上游产品壳与 AB 当成同一个项目。

唯一产品主链是：

```text
Agent --reads--> Codex-style Skill
  -> 托管 Node REPL MCP Tool
       - Codex 内置 node_repl
       - 其他 Agent host 的 Qwen node-repl-mcp
  -> @hanger-source/ab/agent
  -> @hanger-source/ab Core TypeScript SDK
  -> Rust Browser Server
  -> agent-browser 引擎（链接进 Rust runtime）
  -> CDP
  -> Rust Server 管理的 headed Chrome
  -> 专用、固定、持久 profile
```

这里没有浏览器扩展、Python relay、Node Browser Server、Electron、CEF、WASM 或第二套浏览器 provider。Node.js ESM 是正式 SDK/Agent facade 运行时；Node REPL MCP 只管理 Agent 代码会话和 MCP content，不承担 Chrome/CDP 服务端职责。Bun 只可作为开发工具或兼容执行器，不是用户安装前提。

## 项目真正解决的问题

CDP 能发送命令，却没有直接给 Agent 提供一套好用、稳定、可解释的操作面。Agent 真正需要的是：

- 不必每次重新登录，且不会碰用户日常 Chrome profile；
- 能稳定区分 Browser、Tab、Frame、Document、Realm 和 CDP Session；
- 第一次面对页面时能得到紧凑、带 ref、带可操作状态的 AX/DOM 观察；
- 对已知结构能使用 Playwright 风格但由本项目执行的 Locator；
- 对普通控件、视觉界面、canvas 和底层诊断有明确不同的操作入口；
- 导航、节点替换、OOPIF、弹窗、下载、网络监听和断线不会把动作悄悄落到错误对象；
- 每次失败能指出发生在目标解析、可操作性、坐标、hit-test、输入派发、导航还是运输阶段；
- Skill 能让 Agent 优先使用成熟操作面，而不是反复写 `querySelector` 和临时 JavaScript。

因此，项目的含金量不在“又封装了一遍 CDP”，而在四件事：

1. Rust 运行时拥有并维护真实浏览器身份和生命周期；
2. 观察引擎把 AX、DOM、layout、frame 与 document 事实合成适合 Agent 消费的状态；
3. Locator/ref/action runtime 以确定性算法执行，不把模型猜测塞进浏览器核心；
4. Skill 把能力安排成 Agent 实际会遵循的观察—动作—验证习惯。

## 运行边界

### Rust Browser Server 是唯一浏览器事实所有者

Rust Server 负责：

- Chrome 进程、专用 profile、进程锁和启动参数；
- Browser CDP 连接、target/session/frame/document/realm 状态；
- AX/DOM/layout 采集、合并、ref、diff 与 observation 生命周期；
- Locator 查询执行、元素引用、actionability、hit-test 与输入；
- navigation、network、console、dialog、download、file chooser、init script 和 raw CDP resource；
- 隐藏 daemon 的单实例与 Chrome 接管、每个 SDK client 的私有 RPC、取消、deadline、artifact 和结构化诊断。

动态浏览器状态不复制到 SDK。SDK handle 只保存稳定 identity 和不可变查询/观察描述，每次调用都由 Rust Server 对当前浏览器事实做最终判断。

### TypeScript Core SDK 是公共编程接口

SDK 以 TypeScript 编写并编译为 Node.js ESM JavaScript 与类型声明。它负责：

- `connect()`、Browser/Tab/Frame/Locator/AXState/AXRef/CDPSession/Resource 等对象；
- 参数与返回值、AbortSignal、timeout、错误物化和资源释放；
- 不可变 Locator AST 与函数式 evaluate 的序列化；
- 固定 Unix socket 连接、daemon 缺失时自动拉起、跨 Node 任务连接复用，以及供 Agent 直接 import 的 bootstrap。

SDK 不承载第二套服务端逻辑，不建立自己的 DOM/AX 状态机，不在客户端猜当前 tab，也不实现浏览器动作 fallback。

### `@hanger-source/ab/agent` 是 Agent 呈现与操作面

Agent facade 不复制 observation、Locator 或 action engine。它只做三件事：

- `ax.get("state" | "screenshot" | "both")` 返回 Core typed object，不产生模型输出；
- `ax.write(...)` 通过宿主 Presenter 把 AX 文本或图片真正喂给 Agent，并对页面内容加不可信来源边界；
- state/both 成功展示后，按 Agent session + tab 保存 last-presented observation id，让 `ax.click("e12")` 等短调用在发往 Rust 前还原为明确 `observationId + refId`。

`get()`、`write("screenshot")` 和 Presenter 失败都不推进 AX 基线。Rust/Core 仍然没有全局 latest snapshot；Agent facade 的便利状态不能跨 tab、client 或 document 漂移。

### Node REPL MCP 是 Agent 宿主适配器

交互式 Agent 必须使用宿主管理的持久 JavaScript kernel。Codex 已经提供 `node_repl`，AB 直接使用它，不重复启动 Qwen；其他 Agent host 通过标准 MCP 配置使用 `host/node-repl` 中完整保留的 Qwen Code Apache-2.0 `node-repl-mcp`。两者都提供跨 Tool 调用持续存在的 binding/module 状态、top-level await、取消与标准 MCP text/image content，Agent 因而仍以 TypeScript/JavaScript 自由组合 SDK，而不再通过终端 PTY 手工输入和轮询。

被选中的 MCP host 不连接 CDP、不启动 Chrome、不维护 tab/frame/document/ref，也不复制 Rust resource。AB bootstrap 只负责把版本匹配的 SDK 装入受信任 kernel；Agent Presenter 把 AX/文档交给 `nodeRepl.write()`，把校验过的 screenshot bytes 交给 `nodeRepl.emitImage()`。普通 Node ESM 文件仍是无 MCP 宿主的批处理入口，共用完全相同的 SDK/Rust 链；普通 terminal REPL 只用于诊断。

Skill 不安装、启动或注册 MCP。MCP Tool 必须由 Agent host 在任务开始前提供；同时出现多个兼容 Node REPL 时，宿主选择其中一个，整个 Agent session 不跨 kernel 拆分状态。

### Skill 是 Agent 操作策略

Skill 不是 API 清单。它规定 Agent 的默认路径：

1. 复用一个 Browser 与 Tab handle；
2. 面对未知页面先 `ax.write("state")`；
3. 直接用最后一次已展示 state 的 ref 完成一次性动作；
4. 稳定、重复的结构才转成 Locator；
5. canvas、地图、远程桌面等视觉目标才使用 screenshot + CUA；
6. `evaluate()` 与 raw CDP 用于提取特殊事实和诊断，不作为普通找元素路径；
7. 动作后 `write()` diff 或最小必要观察，不盲重试同一动作。

Skill 不调用模型 API，项目本身也不需要 OpenAI Key。模型 token 只来自正在运行的 Agent；Rust Server、SDK 和观察引擎都是确定性本地代码。

## 专用持久 Chrome

Rust daemon 启动一个可见的标准 Chrome 窗口，并使用 AB 自己的固定 profile。这个 profile 在 daemon/Chrome 重启后继续保存 cookie、localStorage、IndexedDB、站点权限和登录态。

它不复用用户日常 Chrome 的默认 profile，因为同一个 `user-data-dir` 不能被两个 Chrome 实例安全共享，也不应让自动化直接控制用户日常标签页。它也不使用临时 profile，因为那会丢失 Agent 最需要的登录现场。

Rust Server 是隐藏常驻 daemon，但不是需要用户管理的服务。第一次 `connect()` 先连接固定 Unix socket；不存在时 SDK 自动拉起 Rust daemon，daemon 再启动或接管专用 Chrome。后续 Agent/Node 任务连接同一个 daemon 和 Chrome，因此登录态、tab 与页面现场都保留。

`browser.disconnect()`、SDK socket EOF 或 Node 进程退出只释放当前 client 的临时 resource，不关闭 Chrome/daemon。daemon 没有 idle 自动退出；用户关闭 Chrome、系统注销/重启或内部版本接管才改变全局进程。即使 daemon crash，只要受管 Chrome 仍在，新 daemon 也会从固定 profile 的 `DevToolsActivePort` 重新接管，而不是重开第二个 Chrome。整个生命周期不暴露 `start/status/stop/restart` CLI 或管理 UI。

## 从成熟项目吸收什么

| 来源 | 吸收 | 不吸收 |
|---|---|---|
| Qwen Code Node REPL MCP | 非 Codex Agent host 的可移植 JavaScript kernel：cell transform、持久 binding、module loader、取消、MCP text/image content 与生命周期测试 | Codex 路径的重复 MCP、Qwen Agent、模型、工具选择和浏览器能力 |
| agent-browser | 唯一底层引擎源码基底：native Rust CDP、Chrome、AX snapshot/ref/action | CLI、MCP、chat、dashboard、skill manager、daemon 产品壳和 server-global ref map |
| browser-use | DOM/AX/layout/paint、frame/shadow/OOPIF 算法对照 | 第二引擎、Python Agent loop、模型调用、云端服务和 Python runtime |
| Codex Browser | 唯一 Agent UX 基准：AX-first、get/write、ref、Playwright-style、CUA/CDP 分层、model-visible observation、内容边界、state/screenshot 组合观察和 Skill 编排 | 不可见的私有 Browser Runtime、协议、WASM 或闭源 bundle 实现 |
| Stagehand | 结构化 action proposal 与确定性执行分离、必要时二次观察 | 把模型选择或 self-heal 塞进核心 action runtime |
| browser-harness | 短代码、helper composition 与同一 Node 会话持久 handle 的低摩擦体验 | 作为依赖、引擎或运行时，及动态拼补核心浏览器语义 |
| BrowserGym | 可复现任务、observation/action/result/termination trace 与评测夹具 | benchmark 环境成为生产运行时依赖 |
| Playwright | Locator 的用户语义、strict、actionability 与等待纪律 | Playwright driver、BrowserContext 产品模型和“兼容 Playwright”宣称 |

外部代码只在许可证允许且确有必要时移植，并保留来源、commit、许可证与本地改动记录。Codex Browser 只借鉴公开可见的操作语义和 Skill 安排，不复制私有实现。

## 明确不建设

- 浏览器扩展和 extension provider；
- Python relay 或 Python/JavaScript 两份 SDK；
- Node Browser Server；Node REPL MCP host 不属于浏览器 owner；
- 面向用户的 server 管理 CLI、status/start/stop/restart、TCP 端口和 runtime descriptor；
- Electron、CEF、原生 WebView 或 at-browser 宿主；
- WASM 版本和 native/WASM 双 build；
- Playwright、Puppeteer、Selenium 或 WebDriver 兼容层；
- 自动切换到用户日常 Chrome、临时 profile 或任意已开 Chrome；
- Agent planner、模型调用、任务记忆或云端浏览器；
- 模糊 selector、相似元素替换、DOM click fallback、realm fallback 和副作用请求自动重放；
- tab group、Chrome 扩展 API 或其他只有 extension 才天然具备的产品面。

## 完成后的判断标准

AB 完成，不是因为 Rust 进程能连上 CDP，也不是因为 SDK 方法数量很多，而是因为一个 Agent 能在陌生、动态、带 iframe 和登录态的真实页面中：

- 先获得准确而紧凑的页面状态；
- 用 ref 或 Locator 命中正确元素；
- 在动作前后保持 tab/frame/document 身份一致；
- 从差异、事件或明确页面事实判断动作结果；
- 在失败时得到可继续决策的结构化原因；
- 重启后继续使用同一个专用 profile；
- 全程不安装扩展、不启动 Python/Node 浏览器服务、不手工管理 Rust daemon、不依赖模型 API；Agent host 自动管理 Node REPL MCP 会话。
