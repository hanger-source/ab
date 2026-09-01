# AB Agent API 形态收敛计划

这份计划定义 `@hanger-source/ab/agent` 的公开 API 形态收敛。它解决 Agent 面对完整 Core `Tab`、Agent facade 和多套相似词汇时产生的高频误调用，同时保留已经在真实 Chrome、复杂站点和官方 WebArena-Verified Hard 任务中成立的执行与观察语义。

本计划只负责 Agent API 的公开形状、对象分区、命名、可发现性及相应 Skill。Rust Browser Server、协议、Core SDK 和动作—观察机制不是这一批的重写对象。旧 API 不保留兼容层；已经验证的行为通过新的明确对象继续提供。

## 一、完成后的使用面

Agent 只从一个入口取得浏览器：

```ts
import { connect } from "@hanger-source/ab/agent";

const browser = await connect();
const tab = await browser.tabs.open("https://example.com");
```

公开对象不再带 `Agent` 前缀。模块路径已经表达 Agent 语境，因此入口直接导出 `Browser`、`Tabs`、`Tab`、`AX`、`Playwright`、`Locator`、`CUA`、`Resources`、`Dev`、`Presenter` 及其选项类型。

一个 `Tab` 只保留自己的身份和生命周期操作，其余能力按责任分区：

```text
Tab
├── id / url / title / active
├── goto / refresh / reload / goBack / goForward / activate / close
├── screenshot
├── ax
├── playwright
├── cua
├── resources
└── dev

ax
├── get / write
└── click / fill / type / press / check / uncheck / selectOption / ...

playwright
├── locator
├── getByRole / getByText / getByLabel / getByPlaceholder
├── getByAltText / getByTitle / getByTestId
└── waitFor

resources
├── network / console
├── dialogs
├── downloads / fileChoosers
└── initScripts

dev
├── evaluate
├── frames / mainFrame / realms
└── cdp
```

`playwright` 表示 Playwright-style 的 Locator 与页面等待语义，由 AB Rust Runtime 执行；它不引入 Playwright driver、BrowserContext 或 Playwright 浏览器进程。

典型未知页面操作保持现有 AX 行为：

```ts
await tab.ax.write("state");
await tab.ax.click("e12", { write: "diff" });
```

稳定、重复的结构通过明确命名空间进入 Locator：

```ts
const save = tab.playwright.getByRole("button", {
  name: "Save",
  exact: true,
});

await save.click({ write: "diff" });
```

底层诊断不会与普通页面操作混在一起：

```ts
const frames = await tab.dev.frames();
const cdp = await tab.dev.cdp();
```

## 二、本批必须解决的问题

### 1. Agent `Tab` 实际暴露整个 Core `Tab`

当前 `AgentTab` 是 `Omit<Core Tab, ...>` 与 Agent 成员的交叉类型，运行时再通过 `Proxy` 把 Core 成员转发出来。它导致：

- Agent 同时看到 facade 和 Core 的概念；
- Locator 像 Playwright，但 `waitForLoadState` 等页面语义并不位于一致的命名空间；
- `evaluate`、CDP、Frame、Realm、Resource 与普通 UI 操作平铺；
- `Object.getOwnPropertyNames()`、REPL inspect 和类型声明不能给出一致的能力表面；
- 新增 Core `Tab` 方法会在没有 Agent API 设计的情况下自动泄漏到 Agent。

完成后 `Tab` 必须是一个真实类，不继承 Core `Tab`，不与 Core `Tab` 做交叉类型，不使用 property forwarding Proxy。它通过组合持有一个内部 Core `Tab`，只显式委托本计划列出的公共能力。

### 2. 公开命名保存了包装层，而不是产品概念

当前 `AgentBrowser`、`AgentTab`、`AgentAX`、`AgentLocator`、`AgentCUA`、`AgentPresenter` 的前缀只表达“这是 Core 外的一层”。这些对象没有与另一个 Agent 生命周期并存，也不应要求调用者理解包装关系。

公开导出统一改为：

| 当前公开名 | 目标公开名 |
|---|---|
| `AgentBrowser` | `Browser` |
| `AgentTabs` | `Tabs` |
| `AgentTab` | `Tab` |
| `AgentAX` | `AX` |
| `AgentLocator` | `Locator` |
| `AgentCUA` | `CUA` |
| `AgentPresenter` | `Presenter` |
| `AgentConnectOptions` | `ConnectOptions` |
| `AgentWriteOptions` | `WriteOptions` |
| `AgentActionWrite` | `ActionWrite` |

Core 类型只在 Agent 实现内部使用 `CoreTab`、`CoreLocator` 等局部 import alias。`@hanger-source/ab` 的 Core 公共命名不因为这一批发生变化。

### 3. 能力选择依赖记忆，而不是对象结构

当前 Agent 需要记住 `tab.getByRole()` 属于 Agent Locator、`tab.waitFor()` 属于 Core 页面等待、`tab.cdp()` 是底层诊断、`tab.observeNetwork()` 是长生命周期 Resource。完成后对象关系本身必须表达选择：

- 未知或变化中的 UI：`tab.ax`；
- 稳定语义定位和重复操作：`tab.playwright`；
- 视觉坐标输入：`tab.cua`；
- 事件与监听生命周期：`tab.resources`；
- 页面脚本与浏览器协议诊断：`tab.dev`。

Skill 负责解释何时选择这些表面，但不再负责记忆一张平铺方法表。

## 三、本批冻结的行为

下列语义已经进入真实执行链或复杂评测证据。本批只能重新安放入口，不得顺手简化、替换或重写。

### AX 与 presentation

- `ax.get("state" | "screenshot" | "both")` 返回 typed object，不产生模型输出；
- `ax.write(...)` 通过当前 Presenter 输出内容；
- `write("state" | "both")` 只有在 presentation 成功后才推进当前 tab 的 last-presented observation；
- `write("screenshot")`、`get()` 和 presentation 失败不推进 AX baseline；
- 短 ref 在调用 Rust 前仍还原为显式 `observationId + refId`；
- ref、document、frame、session、surface 和 viewport 的 stale 检查保持不变；
- `AXState`、`PageObservation`、`Screenshot` 和 artifact 的返回值及释放规则保持不变。

### 动作与动作后观察

- Agent mutation 继续接受 `write: "diff" | "state" | "none"`；
- 默认 mutation 继续使用当前的 `write` 策略；
- `write: "diff"` 继续使用 action transaction 已产生的 post-action observation，不另做一次 snapshot；
- `write: "state"` 继续在同一 action transaction 请求并展示完整 post-action state；
- `write: "none"` 必须同时表示不展示、不请求 observation，并保留既有 baseline；
- `outcome_unknown`、dispatch/settle、取消和 deadline 语义保持不变；
- pointer action 不增加 DOM click fallback，失败后仍由调用者根据新状态显式选择其他机制。

`click(); ax.write()` 是否应替代 action 自带 `write`，不是这一批的决定。它只有在新 API 形态通过同一批官方复杂任务后，才能作为独立 A/B 课题重新评估。

### Locator、表单和 typed reads

- Locator AST、strict、filter、`and/or`、descendant、`first/last/nth` 保持不变；
- `inspect()`、`isVisible()`、`isEnabled()`、`isChecked()`、`inputValue()` 保持不变；
- `fill()`、`type()` 的 settled value、popup signals 和 ActionResult 保持不变；
- `fillAndSelectSuggestion()` 暂时保留当前行为和位置，只从 `tab.getBy...` 移到 `tab.playwright.getBy...`；
- ElementHandle、AXRef 和 Core Locator 的显式 observation ownership 不变化。

autocomplete 是否应继续作为协议级能力，是另一个已经记录的架构判断，不在 API 形态迁移中处理。

### Runtime、Core 和 Resource

- Rust BrowserOwner、SessionManager、target lane、固定 profile、daemon/Chrome reattach 不变化；
- protocol v3 不因命名空间迁移新增消息或字段；
- Core SDK `@hanger-source/ab` 的 Browser、Tab、Frame、Realm、Locator、AXState、Resource 不变化；
- network、console、dialog、download、file chooser、init script、CDP 的 owner、lease、sequence、gap 和 dispose 语义不变化；
- benchmark coordinator 继续使用 Core SDK，不改官方 task、HAR 或 evaluator。

## 四、官方复杂任务是行为基线

API 形态收敛不能只用 typecheck、fixture 或自写 live case 判定成功。旧仓库已经在 WebArena-Verified `1.2.3`、真实容器站点、完整 HAR 和官方 evaluator 上完成六个 Hard 任务的 source-aware/fresh Skill-only 对照。

| 任务 | 已验证压力 | source-aware | fresh Skill-only |
|---|---|---:|---:|
| 544 | 评论聚合、child tab、Magento 复合编辑器、两个 description 字段 | 1.0 | 0.0 |
| 549 | 属性值、颜色/尺寸组合、唯一变体约束 | 1.0 | 0.0 |
| 769 | 五个 SKU 的重复检索、编辑、保存和完成性 | 1.0 | 1.0 |
| 771 | 星级状态读取、审核动作、pointer no-op 辨识 | 1.0 | 1.0 |
| 610 | 发帖后继续评论的连续 mutation | 1.0 | 1.0 |
| 733 | 历史搜索、唯一结果定位、正文编辑 | 1.0 | 1.0 |

这些结果证明的是旧公开形态下已经成立的行为，不自动证明新形态。它们也不代表全部 258 个 Hard 任务或总体成功率。

新形态必须继续满足：

- source-aware 六题仍为 `6/6`，否则属于可操作能力或迁移错误；
- fresh Skill-only 不低于原来的 `4/6`；
- 544、549 的旧失败仍按 Agent 字段语义/集合规划判断，不允许把题目答案、字段名、商品或站点路径写进 Skill；
- Agent 操作仍限制在正式 AX/ref/Locator/typed read/form/keyboard 表面；
- AX-only 对照不调用 screenshot、CUA、evaluate、页面 JavaScript、raw CDP 或 HTTP/API 直改；
- 每个站点在 source-aware 与 fresh Skill-only 之间重置；
- 成绩以官方 `eval_result.json` 为准，不以 Agent 自报成功、页面截图或日志代替。

从旧评测中得到的通用行为必须继续存在：

- active surface 不选择没有可见内容或可操作节点的透明全屏 click-catcher；
- action 后的 diff 可以继续驱动下一次短 ref 决策；
- `isChecked()` 可以读取 AX 文本没有充分表达的控件状态；
- child tab、导航、HAR 和多对象 mutation 保持完整；
- pointer dispatch 没有产生可见结果时不宣称完成，也不自动切换 DOM click；
- navigation/document 切换后旧 ref、handle 和 realm 不漂移到新对象。

## 五、代码结构

当前 `sdk/ts/src/agent/index.ts` 同时承担 presentation、documentation、AX、CUA、Locator、Tab wrapping、Browser 和 connect，已经超过一千行。拆分不是为了目录整齐，而是让五个公开操作面拥有清晰边界，并消除 Proxy forwarding。

```text
sdk/ts/src/agent/
├── index.ts
├── browser.ts
├── ax.ts
├── playwright.ts
├── cua.ts
├── resources.ts
├── dev.ts
├── presentation.ts
└── documentation.ts
```

各文件职责如下。

### `agent/index.ts`

```text
means: @hanger-source/ab/agent 的唯一导出入口
main path: connect -> Core connect -> Browser
change: 只组合和导出公开类型，不保存 Tab forwarding 逻辑
verify: package 的 ./agent export 和生成的 .d.ts 只出现目标公开名
```

### `agent/browser.ts`

```text
means: Browser、Tabs、Tab 的身份和生命周期
differs: 不实现 AX、Locator、Resource 或 CDP，只拥有对应操作面
main path: Core Browser/Tab -> explicit Agent Tab composition
change: 删除 Proxy；构造 ax/playwright/cua/resources/dev；缓存每个 target 的稳定 Tab
verify: REPL inspect 与 TypeScript 类型都能看到相同命名空间；Core 新成员不会自动泄漏
```

`Tab` 的顶层成员限定为：

- identity/state：`id`、`url`、`title`、`active`、`openerId`；
- lifecycle/navigation：`goto`、`refresh`、`reload`、`goBack`、`goForward`、`activate`、`close`；
- pixels：`screenshot`；
- surfaces：`ax`、`playwright`、`cua`、`resources`、`dev`。

`goto()` 委托当前 Core `navigate()`，保持 `waitUntil`、timeout、AbortSignal 和 refresh 行为。Core 继续使用 `navigate()`，不增加别名或兼容逻辑。

### `agent/ax.ts`

```text
means: 模型可见 observation 与 presented short-ref 操作
differs: last-presented state 是 per-Browser client/per-tab presentation state，不是 Core 或 server-global state
main path: get/write/action -> Core AX/Tab -> Presenter -> baseline replacement
change: 迁移现有实现并使用无 Agent 前缀的公开类型；不改 get/write/action 合同
verify: presentation 成功/失败、write:none、short-ref stale 和 diff baseline 行为保持
```

### `agent/playwright.ts`

```text
means: Playwright-style、由 AB Rust 执行的语义 Locator 操作面
differs: 不是 Playwright package，也不拥有 BrowserContext 或独立页面状态
main path: Tab.playwright builder -> Core Locator -> Agent presentation semantics
change: 承接当前所有 semantic builders、Locator composition/read/mutation 和 waitFor
verify: 现有 Locator live cases只改调用路径，返回数据和错误不变
```

这一批不伪造尚不存在的 `waitForLoadState()`、`waitForURL()` 或 `expectNavigation()`。是否补齐这些页面语义，应根据真实缺口单独设计；不能因为命名为 `playwright` 就宣称完全兼容 Playwright。

### `agent/cua.ts`

```text
means: screenshot viewport identity 约束下的坐标输入
main path: CUA action -> Core CUA -> Rust viewport/stale validation -> optional presentation
change: 只迁移当前行为并清理公开命名
verify: stale viewport 被拒绝；有效坐标动作与 observation 行为不变
```

### `agent/resources.ts`

```text
means: 长生命周期事件、监听和文件资源的发现入口
differs: Resource 本体和 lifecycle 仍由 Core/Rust owner 决定
main path: tab.resources.* -> Core Tab resource factory
change: 显式委托 network/console/dialog/download/fileChooser/initScript
verify: owner、sequence、gap、response body、dispose 和 OOPIF session 行为不变
```

### `agent/dev.ts`

```text
means: 普通 Agent UI 操作之外的页面脚本和协议诊断
main path: tab.dev -> Core evaluate/frame/realm/cdp
change: 将现有低层入口集中，不增加 fallback 或 capability
verify: evaluate 值编码、frame/realm identity 和 CDPSession lifecycle 不变
```

### `agent/presentation.ts` 与 `agent/documentation.ts`

```text
means: MCP/terminal 内容输出与按 topic 获取的操作指导
differs: Presenter 输出模型内容；documentation 只提供指导，不拥有浏览器状态
change: 迁移现有 Node REPL/terminal Presenter 和 topic registry；公开 Presenter 去掉 Agent 前缀
verify: text boundary、图片 bytes、documentation_required 和 topic 输出行为不变
```

## 六、Skill 与文档形态

Skill 只教新的 Agent 入口，不同时保留旧调用示例。主 Skill 继续保存选择顺序、生命周期、安全边界和失败纪律，专题文档承载具体 API。

需要在同一批中共同更新：

- `skills/ab/SKILL.md`；
- `skills/ab/references/*.md`；
- `sdk/ts/docs/*.md`；
- `sdk/ts/README.md`；
- 根 `README.md` 中的 Agent 示例；
- `skills/ab/scripts/ab-client.mjs`；
- package 生成的 `dist`、Skill runtime SDK 和 manifest。

文档中的调用统一为：

```ts
tab.ax.*
tab.playwright.*
tab.cua.*
tab.resources.*
tab.dev.*
```

以下旧形态必须从正式 Agent 文档中退出：

```ts
tab.getByRole(...)
tab.locator(...)
tab.evaluate(...)
tab.cdp()
tab.frames()
tab.observeNetwork()
tab.watchDialogs()
```

退出旧形态不等于删除 Core SDK 的同名能力。Core 文档仍描述 `@hanger-source/ab` 的显式对象。

## 七、实施批次

### 施工起点

当前工作树已有 active-surface identity 的独立改动。它解决 observation surface replacement，不属于 API 形态迁移。在开始本计划前必须先把该改动完成相称验证并形成独立提交，或明确保留为另一个未完成工作面；不能与 API 重组混为一个 diff、一个验证结论或一个提交。

新 API 施工以一个可追溯的干净 Git 基线开始。旧仓库中 `e42343c`、`5bb2132`、`c5c46d1`、`b0e0d4d` 形成的设计演变继续作为解释来源；新仓库的根导入提交不能替代这些历史证据。

### 批次一：一次建立全部公开操作面

这一批同时创建 `browser/ax/playwright/cua/resources/dev/presentation/documentation` 的最终文件和公开关系，不能先只做 AX 或 Locator，让其他能力继续通过 Proxy 泄漏。

改动包括：

- 拆分 `sdk/ts/src/agent/index.ts`；
- 建立真实 `Browser`、`Tabs`、`Tab`；
- 建立五个 Tab 操作面；
- 移除 Proxy 和 `Omit<Core Tab> & ...`；
- 清理全部公开 `AgentXxx` 名称；
- 保持现有参数、返回值、默认值、错误和 presentation 行为；
- 更新 `sdk/ts/src/agent/index.ts` 的出口和 package `.d.ts` 生成面。

完成整批生产代码后运行：

```bash
bun run typecheck
bun run build:sdk
bun run benchmark:typecheck
```

这里的目标是发现漏改调用方、类型泄漏和 package export 问题，不以新增 mapping test 冻结类名或目录。

### 批次二：共同迁移所有正式调用方和 Skill

这一批把 Agent 使用面整体迁到新命名空间：

- 主 Skill 与全部相关 topic；
- SDK Agent 文档和示例；
- Skill client、Node package live case；
- 使用 `/agent` 的真实 live cases；
- 根 README 和发布示例；
- 生成的 Skill runtime SDK、docs 和 manifest。

Core benchmark coordinator、Core live cases和官方 evaluator adapter只在 import/build 需要时修改，不为了新 API 改写其业务流程。

整批同步后运行：

```bash
bun run docs:check
bun run typecheck
bun run build:sdk
bun run package:skill
bun run package:check
```

### 批次三：验证同一运行行为

先运行能直接反驳 facade 迁移错误的现有真实入口：

```bash
bun test/ab/live-suite.ts --case skill-client
bun test/ab/live-suite.ts --case observation-actions
bun test/ab/live-suite.ts --case locator-semantics
bun test/ab/live-suite.ts --case resource-locator-cancel
bun test/ab/live-suite.ts --case scenario-active-surface-overlays
```

随后运行完整默认真实 Chrome suite：

```bash
bun run test:ab
```

`skill-client` 应扩展为真实检查：

- REPL/Node 获得的 `Tab` 有五个明确 namespace；
- Core-only 方法不会因 Core 新成员而自动出现在 Agent `Tab`；
- `write:"none"`、默认 diff、Presenter 次数和 ActionResult 保持；
- Node inspect/own properties 与 `.d.ts` 的公开面一致。

这些是跨 package/REPL 的真实运行行为，不另建一套镜像类型或静态关键词测试。

### 批次四：重跑官方复杂任务

使用原六个任务 id、官方容器站点、站点重置、HAR 和 evaluator，分别执行 source-aware 与 fresh Skill-only。每轮使用新的正式安装 Skill，Agent 不读取项目源码、声明文件、benchmark task source、evaluator 或旧操作记录。

会话入口保持：

```bash
bun run benchmark:webarena-session -- <task-id> <output-root>
```

必须保存：

- `agent_response.json`；
- `network.har`；
- 官方 `eval_result.json`；
- 使用的 AB package/Skill version、Git commit 和任务 provenance；
- source-aware 或 fresh Skill-only、AX-only 限制是否成立。

验收以六题完整对照结束，不在两三个绿色任务后提前判断。发生失败时先归类 browser mechanics、Agent planning 或 evaluator contract；不得把任务答案写进 Skill，也不得创建题目专用 API。

## 八、完成判定

本计划完成需要以下事实同时成立。

| 主张 | 能反驳它的证据 |
|---|---|
| Agent 只面对分区后的公开表面 | 真实 `/agent` import 的 `Tab` inspect、own properties 或 `.d.ts` 仍暴露平铺 Core 方法、Proxy 或 `AgentXxx` |
| API 重组没有改变动作—观察合同 | `skill-client`、observation/action live case 中 Presenter、baseline、`write:none`、ActionResult 或 stale 行为变化 |
| Locator、CUA、Resource 和 Dev 只是换入口 | 现有真实 Chrome case 的返回数据、错误、资源生命周期或 viewport/session identity 变化 |
| Core 与 benchmark evaluator 未被 Agent facade 绑架 | benchmark coordinator 需要 import `/agent`、官方 evaluator 输入被改写，或 Core SDK 为命名空间新增协议行为 |
| Skill 能让陌生 Agent 正确使用新形态 | fresh Agent 仍频繁调用平铺旧 API、把 Core options 传给 Agent action，或依赖源码查询方法 |
| 复杂能力没有因 API 美化退化 | 原六题 source-aware 低于 6/6，或 fresh Skill-only 低于 4/6 |
| 没有为通过任务作弊 | Skill、Runtime 或 SDK 出现任务 id、站点路径、商品名、字段答案或 evaluator-specific 分支 |

静态类型通过、package 可打包、默认 live suite 全绿都只是必要的工程证据，不能替代最后的官方复杂任务对照。

## 九、明确留给后续的判断

以下事项不会在本计划中顺手处理：

- 是否删除 action 的 `write`，统一改成 action 后显式 `ax.write()`；
- 是否让 `write()` 返回已经展示的 typed observation；
- Agent 入口是否隐藏 `AXState.ref()`，只保留短 ref；
- 是否补齐 `waitForLoadState`、`waitForURL`、`expectNavigation`；
- `fillAndSelectSuggestion()` 是否继续作为 public/protocol concept；
- `@hanger-source/ab` Core 是否迁到显式 `/core` 子路径；
- 是否增加 DOM CUA 操作面；
- 是否缩减 agent-browser fork 中未进入 AB 主调用链的修改。

这些问题各自会改变行为、包合同或底层 owner。只有本计划完成并取得新的官方复杂任务结果后，才能根据真实摩擦和失败分布分别决定，不能与 API 形态收敛打包成一次不可归因的重写。

## 十、发布边界

API 形态收敛是 breaking alpha 变化。代码、Skill、SDK docs、生成产物、native/package manifest 和 release identity 全部验证后，再统一发布下一个 prerelease；实施中不反复修改版本，也不让源码和安装 Skill 长期使用不同版本。

候选版本为 `0.3.0-alpha.2`。只有以下内容完整后才创建 tag/release：

- package 与 Skill 安装产物使用新 API；
- 默认真实 Chrome suite 通过；
- 原六题官方复杂对照完成并满足本计划阈值；
- release identity 和公共 registry package 检查通过；
- 发布说明明确列出公开 API 迁移、保留的行为语义和官方评测结果，不把历史 4/6 描述为全部 Hard 覆盖。

计划完成不自动授权 push 或 npm/release 发布；这些外部写操作仍在取得明确授权后执行。
