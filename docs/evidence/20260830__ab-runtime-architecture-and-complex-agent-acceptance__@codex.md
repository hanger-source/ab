# AB 运行架构与复杂 Agent 验收审计

## 文档定位

本文审计 `codex/ab-runtime-plan` 分支形成的 AB 产品链，记录它的由来、实际运行架构、已经成立的设计判断，以及仍需验证或收敛的风险边界。它不是新的目标架构、施工计划或完成报告，也不把通过过的局部测试解释成项目已经完成。

长期产品边界由[《AB 目标架构》](../architecture/20260810__ab-target-architecture__@hanger.md)定义；施工选择与验收体系由[《AB 实施计划》](../plans/20260810__ab-implementation__@hanger.md)定义。本文只回答：代码和真实运行证据已经证明了什么、尚未证明什么，以及实现与最初设计之间有哪些值得保留或重新审视的关系。

## 最初要解决的问题

早期方案依赖扩展、relay 和多层 provider。它虽然有较强的 JavaScript 组织能力，但 Agent 经常绕过 AX/Locator，临时写页面 JavaScript 找元素；扩展安装、浏览器连接和多进程复用也给实际使用增加了摩擦。

AB 的初始选择因此不是再做一层浏览器命令包装，而是同时满足以下条件：

- 不安装扩展，不依赖 Python relay、Node Browser Server 或 Playwright runtime；
- 由一个原生 Rust owner 启动和管理专用 headed Chrome；
- 使用一份固定持久 profile，保留登录态、tab 和页面现场；
- 让独立 Node/Agent 任务自动连接同一个 daemon 和 Chrome，不向用户暴露 server 管理面；
- 复用成熟项目已经验证过的 CDP、AX/ref 和输入算法，不从零重写全部浏览器机制；
- 用 TypeScript SDK 提供 Browser、Tab、Frame、Realm、Locator、AXState、ElementHandle、CDPSession 和 Resource；
- 用 Codex-style Skill 把观察、定位、动作和验证组织成 Agent 实际会遵循的操作面；
- 用独立官方 evaluator 判断陌生复杂任务，而不是让实现自己的 fixture 给自己打分。

外部项目从一开始承担不同角色：

| 来源 | 在 AB 中的角色 |
|---|---|
| agent-browser | Rust native CDP、AX snapshot/ref、element、interaction 和 screenshot 的源码基底 |
| Codex Browser | AX-first、`get/write`、短 ref、post-action observation、CUA/CDP 分层和 Skill 编排的 UX 基准 |
| browser-harness | 同一 JavaScript 会话、短代码和 helper composition 的低摩擦体验参考 |
| BrowserGym / WebArena / VisualWebArena | 与产品运行时独立的任务和评测体系 |
| Playwright | Locator、strict、actionability 和等待语义的行为参考，不作为运行时依赖 |

## 实际运行架构

当前正式链路是：

```text
Agent
  -> skills/ab
  -> ab/agent
  -> ab Core TypeScript SDK
  -> ab-runtime
  -> BrowserOwner
  -> SessionManager
  -> agent-browser native modules + AB runtime semantics
  -> CDP
  -> headed Google Chrome
  -> ~/Library/Application Support/ab/chrome-profile
```

这条链路没有 extension、Python relay、Node Browser Server、Playwright、Electron、CEF 或 WASM。Node.js ESM 只承载 SDK 和 Agent facade；浏览器状态只由 Rust runtime 持有。

### Rust 所有权已经收敛

`server/rust/ab-runtime/src/browser/owner.rs` 持有一份 `BrowserOwner`，`session_manager.rs` 持有一份共享 `CdpClient`、target/session/frame/realm registry、domain lease、feature owner 和生命周期广播。每个 target 的 `TargetLane` 只序列化该 target 上的 mutation，不再创建另一份浏览器事实或 CDP connection。

因此，早期“registry 一份 EngineState、每个 tab 再一份 EngineState/CDP”的结构已经退出。当前多 tab 并发建立在同一 owner 下的 target lane，而不是多份相互同步的 browser state。

### Chrome 和 daemon 是两个生命周期

SDK 连接当前用户的固定 Unix socket。socket 不存在时，它解析与 SDK build identity 匹配的 native binary，detached 拉起 daemon；Rust singleton lock 把并发启动收敛到一个进程。

daemon 使用固定 profile 的 `DevToolsActivePort` 判断受管 Chrome 是否仍然存在。daemon 消失而 Chrome 继续运行时，新 daemon 接管同一 endpoint 和 browser generation；它不会启动第二个 Chrome，也不会切临时 profile。当前现场已经验证过 daemon 不在、Chrome 仍在时重新 `connect()`，原 browser generation 和三个既有 tab 均被保留。

### agent-browser 的准确位置

`server/rust/ab-runtime/src/agent_browser_engine.rs` 只向 AB 暴露 agent-browser 的 `cdp`、`element`、`interaction`、`screenshot` 和 `snapshot` native 模块。AB 没有运行 agent-browser CLI、MCP、chat、dashboard、skill manager 或 daemon。

但“agent-browser 是底层源码基底”不等于“AB 原封不动运行 agent-browser engine”。当前准确关系是：

```text
agent-browser 提供成熟的底层 CDP / AX / ref / interaction 算法
AB 修改其中一部分，使其支持显式 identity、domain lease、OOPIF、断线和嵌入式调用
AB 另外拥有 daemon、protocol、selector、observation transaction、resource 和 public SDK 语义
```

### Agent 操作面已经成为真实产品面

`ab` 与 `ab/agent` 来自同一份 TypeScript 源码和 transport。Core 保持显式 observation、resource 和 lifecycle；Agent facade 增加 Presenter、最近一次已成功展示的 per-tab observation、短 ref 和动作后展示便利，不建立第二套浏览器状态。

`skills/ab/` 当前包含一个主 Skill、按需加载的主题文档、bootstrap、编译后的 SDK 和 macOS arm64 native runtime。普通 Agent 不需要安装 npm package、Bun 或手工启动 daemon。主题文档覆盖 observation、actions、forms、tabs、frames、network、dialog、download、init script、CUA、evaluate、CDP、recovery 和 task recipes。

## 已经成立的设计判断

### 单一 Rust Browser Owner

Chrome、profile、Browser CDP socket、target/session/frame/document/realm、dialog blocked state 和 resource domain lease 都由 Rust 决定。SDK 只持有不可变 handle 和 client-owned resource id。

这是整个设计最重要的收敛：调用者不再知道扩展 origin、relay endpoint、active-tab 猜测、provider generation 或多套 session registry。

### 固定持久 profile 与自动接管

固定 profile 是 Agent 本地浏览器的核心价值，不是实现细节。AB 同时守住了三个边界：

- 不碰用户日常 Chrome profile；
- 不因 daemon 或 Node 任务结束丢失登录态；
- profile 被无可用 CDP endpoint 的其他进程占用时硬失败，不通过临时目录 fallback 掩盖所有权冲突。

daemon 隐藏且自动启动，也符合“不回到 CLI server start/status/stop 老套路”的初始选择。

### 显式 identity 和禁止静默 fallback

AB 的 ref 绑定 observation、frame、document generation 和 backend node。agent-browser 原有的“backend node stale 后按 role/name 再找一个节点”对单次 CLI 操作很方便，但不满足 AB 的确定性要求；AB exact ref 直接返回 stale，避免把同名危险动作落到另一个元素。

同样合理的还有：

- 副作用请求超时或取消后返回 `outcome_unknown`，不自动重放；
- checkbox 机械点击失败后不 fallback 到 DOM `.click()`；
- CUA 必须携带 screenshot 的 `viewportId`；
- screenshot、AX 和 viewport identity 在一次 `observe()` transaction 中校验；
- Presenter 成功之前不推进 Agent 的短 ref baseline。

这些约束让失败仍然保留事实，而不是用“看起来成功”的兼容行为污染下一步决策。

### agent-browser 中确有必要的嵌入式改动

当前 fork 中以下变化具有明确的 AB owner 或合同需求，应当保留其行为：

- `CdpClient` 提供断线订阅和显式 command timeout；
- snapshot 支持 caller-owned domain lease，不自行改变共享 domain 状态；
- snapshot 返回 captured frame ids 和具名 gaps，不静默吞掉 OOPIF/child-frame 缺失；
- iframe traversal 不再只展开主 frame 的一层 child；
- `RefMap` 支持 exact identity 和独立的 model-visible display name；
- screenshot 支持 CSS scale，保证图像坐标与 CUA CSS 坐标一致；
- interaction 暴露 coordinate click、dialog event identity、真实键盘事件和无 DOM fallback 的 check/uncheck；
- fill/type/clear 在修改前区分 disabled、readonly、文本控件和 contenteditable。

这些不是为了保留某个 benchmark 的答案，而是把单会话 CLI 算法变成可由多 client Rust runtime 安全调用的机制。

### Observation 把“能看见”建模成可验证事实

AB 没有把 AX 文本本身当成完整页面。Rust capture 同时组织：

- agent-browser AX/ref 输出；
- DOMSnapshot、pierced DOM 和 layout/bounds；
- frame/session/document generation；
- captured/expected frame coverage 和 gaps；
- observation identity、diff、truncation 和 completeness；
- 与 screenshot 共用的 document/viewport transaction。

这正面解决了早期方案中 Agent 不爱用 AX、反复自己写 JavaScript 找元素的问题：Agent 现在得到的是可以直接动作、又能判断覆盖范围的 observation，而不是一棵没有 identity 和 bounds 的原始 AX tree。

### Resource 所有权和动态 session 纳入

Network、console、dialog、download、file chooser 和 init script 都是 client-owned Resource。domain lease 按 session/domain/owner 引用计数；新 OOPIF session attach 后，现有 observer 会动态 acquire 相同 domain，失败则生成 `resource.gap`，而不是继续冒充完整事件流。

这属于真实独立生命周期，不是为了包装 API 而增加的 Manager。

### Core SDK 与 Agent facade 共用一份事实

Core 面向程序组合，Agent facade 面向模型操作，但两者不复制 selector、capture 或 action。`ab/agent` 的 last-presented state 只是一份 per-Agent-session/per-tab 展示便利，wire 上仍还原为 observation id；它不能成为 server-global latest snapshot。

这个分层同时保留了库形式的自由组织能力和 Codex-style 的低摩擦操作语义。

### 评测进程与产品运行时分离

WebArena/VisualWebArena evaluator 使用 Playwright、captioning 或官方 evaluator，不代表 AB 产品依赖这些工具。Agent 只获得任务意图和已安装 Skill，不读取 evaluator、期望动作、task source 或项目实现。

这种 source-blind、implementation-independent 的边界是正确验收方向，应继续保持。

### 六个复杂 WebArena 任务的知情诊断与陌生 Agent 对照

六个任务都使用官方 WebArena-Verified `1.2.3` 任务、真实本地站点、AB 持有的 headed Chrome、完整 HAR 和官方 evaluator。每个站点在 source-aware 与 source-blind 之间重置；root 先阅读任务和 evaluator，用于区分能力缺口与题意/evaluator 差异；fresh Agent 只得到任务原文、正式安装的 AB Skill 和 tab id，不读取项目源码、benchmark 数据、evaluator、HAR 或数据库。

浏览器执行边界是 AX state/ref、语义 Locator、Locator 的 typed inspect/state read、表单和键盘动作。计入对照的轮次不使用 screenshot/image/vision、坐标/CUA、`evaluate`、页面 JavaScript、raw CDP 或 HTTP/API 直改。`domInvoke` 只在普通 pointer action 已经被可见结果证实为 no-op 后，作为 Skill 明文公开的 Locator mutation 使用并披露 dispatch，不是隐藏 fallback。

733 的一次 root 尝试误调用未指定 observation shape 的 `tab.ax.get()`，虽然没有读取或使用生成的图片，仍因产生 screenshot artifact 而从 AX-only 证据中剔除。重置后的干净 root 轮次落在独立目录并重新取得官方 `score = 1.0`。这说明“未使用图片”不能替代“没有调用图片能力”的 provenance 边界。

| 任务 | 真实压力 | source-aware | fresh Skill-only | 差异归因 |
|---|---|---:|---:|---|
| 544 | 评论聚合、商品 child tab、Magento 复合编辑器、描述字段 | 1.0 | 0.0 | root 根据 evaluator 写入 `short_description`；fresh Agent 把自然语言中的 description 解释为主 Description。保存动作和复杂 UI 都成功，失败来自两个并存字段的语义选择与 evaluator 的单字段合同，不是底层无法输入或保存。 |
| 549 | 新增尺寸属性值并生成一个指定颜色/尺寸变体 | 1.0 | 0.0 | fresh Agent 正确新增 XXXL，却把颜色与尺寸做成九个组合；evaluator 只接受唯一 `XXXL + Green` 新变体。是计划约束和集合裁剪错误，不是 AX/Locator 机械失败。 |
| 769 | 跨五个 simple SKU 更新库存并保存 | 1.0 | 1.0 | 两轮都通过五个独立 POST，证明重复检索、编辑、保存和多对象完成性可由正式操作面完成。 |
| 771 | 从待审评论中识别四星/五星并批准 | 1.0 | 1.0 | AX 文本把五颗星显示为同名控件，fresh Agent 用正式 Locator `isChecked()` 读出选中项，准确批准两条。能力存在，但纯文本 presentation 对单选组状态的表达仍偏弱。 |
| 610 | 在指定论坛发帖后继续评论 | 1.0 | 1.0 | 两轮都通过创建与评论两个独立 evaluator 事件；论坛选择、连续导航和后续表单没有需要题目专用 helper。 |
| 733 | 在当前用户历史中找到指定帖子并编辑正文 | 1.0 | 1.0 | root 与 fresh Agent 都可用站内搜索、精确可见结果、普通表单完成；fresh Agent 没有失败恢复。搜索高亮会把可访问名称渲染为 `StarTrek`/`StarfleetAcademySeries`，是值得继续定位的通用 name/text 边界，但没有阻断唯一结果的编辑。 |

官方落盘结果如下；Agent 自报 `SUCCESS` 不计入得分：

| 任务 | source-aware evaluator | Skill-only evaluator |
|---|---|---|
| 544 | `webarena-knowledgeable-round/544/eval_result.json` | `webarena-skill-only-ax-round-r2/544/eval_result.json` |
| 549 | `webarena-source-aware-round/549/eval_result.json` | `webarena-skill-only-ax-round/549/eval_result.json` |
| 769 | `webarena-source-aware-round/769/eval_result.json` | `webarena-skill-only-ax-round/769/eval_result.json` |
| 771 | `webarena-source-aware-round-r2/771/eval_result.json` | `webarena-skill-only-ax-round/771/eval_result.json` |
| 610 | `webarena-source-aware-round/610/eval_result.json` | `webarena-skill-only-ax-round/610/eval_result.json` |
| 733 | `webarena-source-aware-ax-only-round/733/eval_result.json` | `webarena-skill-only-ax-round/733/eval_result.json` |

source-aware 6/6 与 fresh Skill-only 4/6 证明了两件不同的事。底层能力足以完成这组六类复杂任务；陌生 Agent 已能独立完成其中四类，但仍会在字段语义和组合约束上做出错误决定。把 544 或 549 的答案、页面路径、字段名或机械步骤补进 Skill，只会把 Agent 判断问题伪装成产品能力，属于为过题硬编码，本轮没有这样做。

### 对照过程中确认的通用缺陷与边界

任务 544 确认了 active surface 的通用 observation 缺陷：Magento 展开侧栏后，一个覆盖全视口、透明且没有内容的 click-catcher 被误认为当前操作面，导致 AX 返回空页面。修复要求普通 fixed layer 除了覆盖阈值，还必须拥有可见文字、背景图、语义/可操作节点或 replaced content；它不包含站点、任务、商品或控件特例。

Agent facade 的 `{ write: "none" }` 原先只关闭 Presenter，却仍可能继承 Core action 的默认 post-action observation。它违反“调用者明确不观察就不捕获”的合同，也会让 AX-only provenance 难以解释。现在 `write: "none"` 在调用者没有显式指定 `observe` 时一并映射为 `observe: "none"`；显式 `observe` 仍由调用者决定。`skill-client` live case 通过真实点击同时验证了副作用发生、`observationOutcome.status = "notRequested"`、`observation = null` 且 Presenter 数量不变。这是操作合同修复，不是 benchmark helper。

WebArena session coordinator 原先等待完整 `load` 且只给 60 秒。Magento 冷启动多次在页面已可交互时仍卡住 `load`；现在 coordinator 等待 `domcontentloaded`，保留站点自己的业务状态观察，并把冷启动上限调整为 120 秒。它修复 benchmark 进场条件，不改变 AB 产品运行语义。

任务 771 暴露了 agent-browser 继承的 pointer action 问题：CDP 坐标 click 可能返回 dispatch 成功，但动态页面 handler 没有产生任何可见结果。上游已有同类问题 [vercel-labs/agent-browser#1011](https://github.com/vercel-labs/agent-browser/issues/1011)。本轮没有把 `domInvoke("click")` 变成自动 fallback；root 只在普通 click 已被新 AX state 证实为 no-op 后显式选择该 Locator action。继续收敛时应修 actionability/dispatch 真实性，而不是让所有 click 暗中切 DOM 方法。

同一任务还证明 AX 文本与语义状态不是一回事：五个 rating control 的文本名称都只是 `★`，但 Locator `isChecked()` 能准确恢复选中星级。现阶段不应新增“读星级”API；更合理的问题是通用 AX presentation 是否应把 checked/radio group 状态表达得更直接。

root 第一次从 Pending Reviews 保存 771 时，真实 HAR 已包含 `status_id=1` 和 302，但 URL 为 `/review/product/save/id/<id>/ret/pending/`；evaluator 只接受没有 `/ret/pending/` 的精确路径，因此返回 0。改从 All Reviews 进入同一编辑页后产生 evaluator 指定路径并得到 1。这里同时存在真实成功和 evaluator 的路径过窄约束，不应据此制造 route-specific API。

另外两类恢复问题暂时只记录，不用局部补丁掩盖：保存后偶尔出现 `Cannot find context with specified id`，但 HAR 和重新观察证明 mutation 已完成，说明 navigation/document 切换中的 Locator read race 仍需独立复现；本地 reset wrapper 对 `127.0.0.1` 的额外 probe 偶发超时，而官方环境自身已经 ready，属于 benchmark adapter 的健康检查边界。

## 设计风险与待验证边界

这些问题的含义不是“当前能力全部无效”，而是它们尚未证明自己位于正确的抽象层，或已经留下与当前主链不一致的维护面。

### agent-browser fork 仍保留旧架构修改

相对精确上游 commit `fbd046c23a2c1156891bda294aaaee715c23b3f1`，当前 fork 修改了 16 个文件，约增加 1033 行、删除 340 行。真正处于 AB 调用链上的主要是 `cdp/client.rs`、`element.rs`、`interaction.rs`、`screenshot.rs` 和 `snapshot.rs`。

最大的可疑残留是 agent-browser `native/actions.rs`，约增加 300 行、删除 141 行。它包含早期为 AB 增加的：

- `DaemonState.attach_cdp` 和 `external_browser_owner`；
- get-by-role、semantic locator、strict、count、index 和 visible；
- 扩展后的 `find` subaction。

当前 `ab-runtime` 不调用 agent-browser `DaemonState`、`execute_command` 或这些 semantic locator；它已经使用自己的 `BrowserOwner`、`SelectorEngine` 和 `ActionRunner`。因此这批修改是架构转向后没有退出的旧路径，不应继续被描述为 AB 必需的 engine patch。

`network.rs`、`recording.rs`、`tracing.rs`、`stream/*` 和部分 test utility 中还有只为 workspace strict clippy、测试环境或编译兼容产生的修改。它们不会直接破坏 runtime，但扩大了 fork 审阅和上游同步面。

### Locator 的所有权正确，当前实现成熟度仍可疑

AB 需要自己的不可变 Locator AST、strict、composition、frame scope 和 observation/document identity；不能直接把 agent-browser 字符串 command 暴露为公共合同。这个 owner 选择是正确的。

但当前 `selector/executor.rs` 和 `selector/runtime.rs` 自行实现了大量 DOM query、label/text/test-id、shadow traversal、contains、visibility 和 AX role 查询。它已经重新承担成熟 selector engine 的高风险细节：

- DOM 查询与 AX role 查询是两套执行路径；
- accessible-name 只在 role 查询中来自 AX，其他 diagnostic 仍有 DOM/innerText 近似；
- relation composition 需要大量跨对象 `Runtime.callFunctionOn`；
- query validation 的 frame 分支当前重复访问同一子查询；
- `contains` 仍携带一段在实际分支中不会使用的函数和参数，暴露了迁移残留。

因此，问题不是“AB 不该拥有 Locator”，而是它尚未证明当前自研 executor 已达到我们想借用的成熟度。后续应收敛为一套清楚的 query execution core，并用真实复杂页面证明语义，而不是继续按失败页面增加 selector 特例。

### autocomplete 工作流被提升进了 Rust 合同

`fill()`/`type()` 当前返回 `popupBacked`、`signals` 和 `next: "selectSuggestion"`；Rust 还识别 `ui-autocomplete-input` 这一 jQuery UI class。SDK 进一步公开 `fillAndSelectSuggestion()`，Skill 把它作为 popup-backed form 的推荐路径。

这个能力没有硬编码城市、任务 id 或 benchmark URL，因此不是直接作弊；它也确实抽象了常见 autocomplete 提交问题。但其层级值得怀疑：

- “字段当前值、readonly、role、aria 属性和页面变化”是浏览器事实；
- “下一步应该选择 suggestion”是 Agent 工作流判断；
- jQuery UI class 是具体 widget 实现知识。

更稳健的边界可能是 Rust 报告事实，TypeScript helper 组合 fill、observe、select 和 committed-value verification，Skill 决定何时使用，而不是让 Rust action result 给出下一步建议。当前复杂评测不足以证明这组字段应成为长期 wire/public API。

### active surface 是有价值、已修正一次、但尚未成熟的启发式

Agent facade 默认 `surface: "active"`。Rust 从视口中心的 `elementsFromPoint()` 向上寻找操作面。显式 `dialog[open]`、`aria-modal=true` 和 `role=dialog` 直接成立；普通 fixed layer 除了覆盖视口至少 85%，现在还必须实际拥有可见文字、背景图、语义/可操作节点或 replaced content，才会被当成 active subtree。

这次约束来自任务 544 的真实 Magento 现场：旧规则选择了一个空透明全屏 overlay，导致 active observation 显示 `(empty page)`，而 document observation 中实际菜单和保存成功信息都存在。修复后，同一现场会回落到 document surface；真实 Chrome 聚焦用例同时证明空透明 overlay 不再遮住正文，而包含实际 Editor action 的全屏层仍被选为 active surface。

这个修复没有把站点知识写进引擎，因而是正当的通用修复；但 active surface 仍不是 CDP 或 AX 给出的原生事实，而是产品启发式：

- 85% 是人为阈值；
- “可见且有意义的内容”仍由 DOM/style/semantic selector 近似；
- 固定导航、复杂 canvas、跨 frame overlay 和非模态 editor 仍可能产生误判；
- 任务有时仍需要背景上下文；
- 当前只在少数真实复杂页面中取得证据。

因此 active surface 适合作为显式 presentation 策略继续验证；在覆盖充分之前，不应把它描述成已经成熟的统一 observation engine 事实。

### Skill 主路径混入了 benchmark 压力经验

Skill 中的 AX-first、fresh ref、semantic Locator、viewport-bound CUA、resource-before-action 和 failure recovery 是通用且正确的操作纪律。

但主 `SKILL.md` 还直接包含 START 按钮、短倒计时、250ms Codex terminal yield、倒计时内关闭 post-action diff 等细节。这些规则来源于真实时间压力，放在按需 task recipe 中有价值；进入所有浏览器任务都会让主路径被 MiniWoB 风格 episode 塑形。

Skill 应继续把通用决策梯放在主文件，把 countdown、bulk table、autocomplete 和特定 widget workflow 留在按需主题，不让 benchmark 经验反向定义整个产品。

### dialog 是明确未闭环行为

当前 dialog 设计方向是必要的：SessionManager 常驻接收 `Page.javascriptDialogOpening/Closed`，dialog identity 进入 tab blocked state，watcher 只操作仍打开的同一 dialog，pointer release 在 dialog 处理后恢复。

但最近一次独立 headed dialog live case 仍然在第一次 confirm click 后超时。默认 `verify` 的 12 个 live cases 不包含 `dialog`，所以默认绿色不能证明 dialog 已经完成。

这是已证实失败，不是一般风险。继续工作时必须保留“dialog 未闭环”的状态；在新的机制证据出现前，不重复运行同一种会遗留原生弹窗的尝试，也不能把 dialog API 存在当成通过。

### 默认 verify 容易制造过强印象

当前完整 `verify` 会运行 strict clippy、整个 Cargo workspace tests、TS typecheck/build/package 和 12 个默认真实 Chrome cases。它是有价值的工程检查，但需要正确解读：

- Rust 输出中的 1156 个通过测试主要来自完整 agent-browser crate；
- `ab-runtime` 自身只有一个 Rust unit test；
- AB 的主要实现证据来自 12 个 live cases；
- dialog 和 version-handover 都不是默认 case；
- package dry-run 不等于 registry 发布和全新机器安装。

因此 `verify` 证明当前选定链路没有已知编译/打包/live regression，不证明整个 Agent Browser 已经完成。

### 复杂 Agent 验收形成了首轮对照，不代表完整覆盖

当前最强评测事实如下。这里以落盘的官方 evaluator 结果为准，不以 Agent 自报 `SUCCESS` 代替通过；source-blind 和 AX-only provenance 仍由 coordinator 输出、Agent 操作记录与人工审计共同证明，尚未成为 evaluator 文件里的机器可验证字段：

| 套件 | 官方范围 | 当前落盘事实 | 能证明什么 |
|---|---:|---|---|
| MiniWoB++ 选择集 | 11 个操作族 | 每个族最终取得过至少一次官方页面通过；过程中也存在失败、无效页面和后续新 seed 通过 | 基本 interaction surface 可以被 Agent 使用，不等于复杂网站通用性 |
| WebArena-Verified Hard | 258 | 本轮六题 root/source-aware 6/6，fresh Skill-only 4/6；另有早期 694、701 等通过样例 | AB 通用能力可覆盖本轮六类复杂任务；陌生 Agent 在多对象 mutation、状态读取和连续流程上已有真实成功，但字段语义与集合约束仍明显影响成功率 |
| VisualWebArena | 910 | 执行过 1 个 Reddit `url_match` 任务并通过；其余任务未形成覆盖 | 只证明一条 Reddit 导航样例，不证明 screenshot+AX+CUA 的复杂组合成熟 |

六题不是 WebArena Hard 的全部范围，也不是随机抽样统计，因此 4/6 不能外推为总体成功率。它的价值在于把三种此前混在一起的失败分开：browser mechanics、Agent planning、evaluator contract。后续扩展样本时应继续保存 root/source-aware、fresh Skill-only、正式操作面限制和官方 evaluator 四条 provenance，而不是只累计绿色数字。

此外，`test/benchmarks/miniwob-ab-live.ts` 是 task-specific SDK regression：它解析固定 MiniWoB instruction 并执行预定操作。它适合验证 SDK 机械边界，不属于 source-blind Agent acceptance，不能混入上述 Agent 通过数量。

### 发布合同尚未成立

当前 native package 可 dry-run 打包，release binary 约 4.8MB；Skill bundle 自带 version-matched SDK 和 darwin-arm64 runtime，已能从本地安装路径启动。

但正式发布仍有两个事实缺口：

- npm 公共名称 [`ab`](https://www.npmjs.com/package/ab) 已属于另一个 benchmark package，当前 `sdk/ts/package.json` 的 unscoped `ab` 名称不能直接按设想发布；
- 当前全局 Skill 是指向仓库 `skills/ab` 的 symlink，不是一次独立 release 安装和升级验证。

macOS arm64 是当前明确的首个支持平台，不是架构偏差；但它也意味着 Linux、Windows 和 Intel macOS 不能被 README 的通用措辞暗示为已支持。

## 应保留与继续审视的边界

### 应当保留

- 单一 Rust BrowserOwner、共享 SessionManager 和 per-target mutation lane；
- 固定持久 profile、自动 daemon、Chrome reattach 和 exact-version handshake；
- client-owned Resource、domain lease 和动态 OOPIF session 纳入；
- observation/document/viewport identity、completeness、gaps 和 atomic AX+screenshot；
- exact ref、无副作用重放、无 semantic/DOM fallback；
- agent-browser `cdp`、`element`、`interaction`、`snapshot`、`screenshot` 中确有调用者的嵌入式能力；
- 一份 TypeScript Core 加同包 Agent facade；
- Codex-style Skill 的 AX-first、Locator/CUA/evaluate/CDP 分层；
- source-blind Agent 与独立官方 evaluator 的验收边界。

### 在继续扩能力前应重新审视

- 把 agent-browser fork 缩回当前真实调用面，退出未使用的 `native/actions.rs` AB 修改和无关产品壳 patch；
- 明确 Locator query core 的唯一实现，停止同时维护 agent-browser command locator 与 AB executor；
- 检查 autocomplete 的 Agent 策略是否应从 Rust protocol 下沉到 TypeScript helper/Skill；
- 继续用不同复杂页面检验 active surface 的内容判定和回落行为，而不是因为修过一次就默认成熟；
- 把 countdown 等 benchmark/task 经验从主 Skill 路径继续下沉到按需主题；
- 将 dialog 作为明确失败单独处理，不让默认 verify 遮蔽；
- 解决 npm package identity 和独立 Skill release 安装后，再宣称发布闭环；
- 把 source-aware/source-blind、Skill-only/AX-only 和官方 evaluator provenance 从人工记录提升为 coordinator 的正式 run metadata；
- 扩展不同站点和不同任务族的复杂样本，用失败分布继续区分 Agent 判断、browser mechanics 与 evaluator 过窄约束，不用重复通过的简单 fixture 扩大结论。

## 总体判断

AB 不是 agent-browser CLI、Playwright 或扩展的另一层包装。它已经形成一条真实工作的产品链：Codex-style Skill、TypeScript SDK、单一 Rust owner、CDP 和固定持久 Chrome；生命周期、identity、resource 和观察事务中有一批清晰且有价值的原创设计。

当前尚不能把它描述为“成熟 agent-browser 引擎加 Codex Browser 体验已经完成”。更准确的结论是：

> AB 的核心架构已经成立，基础运行链和主要对象真实可用；六题对照证明正式 Skill-only Agent 已能独立完成四类复杂任务，也证明剩余失败主要落在 Agent 语义选择和组合计划，而不是靠新增题目函数才能补齐。底层复用边界仍夹杂旧架构 fork，部分 Agent 工作流被过早提升为 core/public concept，dialog、pointer action 真实性、复杂任务覆盖和发布合同仍未闭环。

后续判断应继续区分四种状态：已通过、已证伪、明确受阻和未验证。只有 source-blind Agent 在足够多的官方复杂任务上，通过独立 evaluator 得到稳定结果，才能把“操作面完整”提升为“Agent Browser 成熟”。
