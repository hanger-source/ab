# Action、Wait 与 Observation 所有权审计

## 结论

AB 当前最需要修正的不是某个站点的点击、动画或导航，而是 Agent 默认调用合同：一次 mutation 默认同时派发输入、推断有限页面影响、采集 observation、输出 diff 并推进短 ref baseline。这个合同让一个普通动作的耗时、返回含义和失败责任取决于页面随后发生的未知工作，也使 Agent 难以区分“输入尚未派发”“页面仍在变化”“观察失败”和“业务结果没有出现”。

目标边界是：

```text
action
  = exact target + actionability + trusted dispatch + immediate action facts

wait
  = caller-selected navigation/load/element/resource postcondition

observation
  = caller-selected model-visible AX/diff/screenshot fact
```

Agent mutation 不再默认请求或展示 post-action observation；Agent `Locator.waitFor()` 也不再在条件成立后自动采集完整 state。动作之后，由 Agent 根据下一次决策显式选择最便宜的事实：继续已确定的动作、等待 URL/load/元素/resource，或调用 `ax.write("diff" | "state")`。

Core SDK 的显式 `observe` 暂时保留。它是库调用者主动选择的 action-and-observation transaction，具有明确 baseline、capture shape、observation identity 和结构化失败结果，并已进入复杂任务与确定性场景。当前证据能够否定它作为 Agent 默认动作语义，尚不能证明这个显式 Core primitive 本身没有合理用途。是否从协议和 Rust Runtime 删除它，需要独立的 Core 使用面与复杂评测对照，不能借 Agent API 修正顺手决定。

## 可追溯的设计演变

| 时间/基线 | 已留下的判断 | 对当前结论的意义 |
|---|---|---|
| 根导入 `0a36ab3` 的机制比较 | `target resolved`、`input dispatched`、`navigation started`、`requests settled`、`DOM changed`、`business result appeared` 是分阶段证据，不是一个布尔值 | 最早的参考原则已经要求分离 action 与后置事实 |
| 根导入 `0a36ab3` 的目标架构 | `ActionRunner` 允许调用者明确要求 optional post-action observation，`ActionResult` 不声称业务完成 | 显式组合原语从独立仓库起就存在，不是最近为某个 case 新造的概念 |
| 小红书对照，记录于根导入 `0a36ab3` | Codex Browser 的动作成功后由 Agent 主动观察；AB 的 immediate observation 曾早于关闭动画。记录明确提出区分 dispatch 后即时事实与调用方要求的 settled 条件 | 真实 Agent 对照在 API 收敛前已经暴露当前问题 |
| `65213db` Agent API 形态计划 | 为隔离公开对象重组，明确冻结 mutation `write`、post-action observation 和 Core/Runtime；把 `click(); ax.write()` 列为通过同批复杂任务后再做的独立 A/B | 这是有意识的范围冻结，不是对复合合同的永久认可 |
| `b3edd83` observation presentation identity | 在既有复合合同内保证 ActionResult observation、Presenter 输出和下一次 short-ref baseline 是同一个对象 | 修正了 identity，不回答 action 是否应默认观察 |
| `12c44bf` 与 Hard 记录 | source-aware 六题 6/6；fresh Skill-only 六题 4/6。deadline、stale observation、`write:none`、输入 settled value 等问题按通用语义修复 | 这是行为基线，不能因 API 拆分而丢失；也不能外推为全部 Hard |
| `31e979f` | 把 action navigation stream 与 optional observation effect stream 分开，但仍在一次 `finish_action()` RPC 中 join，仍由同一 mutation deadline 返回 | 内部阶段已经分流，对外责任仍未分离 |
| `33c642f` | 建立 browser-global input-surface owner，把 file chooser、popup、observation 分回各自 owner；同时更新目标架构 | 这些是必要底层机械事实，不应被误删成“复合动作补丁” |
| `4672ed6` | 修复 autocomplete 组合动作的 capture-shape/baseline identity | 再次说明 action 默认携带 observation 会把高层组合、capture shape 和动作结果耦合起来 |

当前独立仓库没有保存计划所引用的旧仓库 commit `e42343c`、`5bb2132`、`c5c46d1`、`b0e0d4d` 对象；早期 Hard 的原始 HAR 与临时日志也已在既有验收记录中明确标记为不存在。可长期追溯的是任务编号、分数、当时代码快照、后续候选 commit 和文档中的 provenance，不能声称仍可复核已丢失的原始运行材料。

## 反复修改实际分成四类

不能把 9 月 2 日的连续提交全部归咎于 post-action observation：

1. Pointer Action：layout shift、event-time hit target、double-click sequence。它修的是浏览器是否真的把可信输入发送到目标，属于 Action owner，必须保留。
2. Browser/Session：后台 tab 激活、paused popup 初始化、domain/init script 批量提交。它修的是 headed Chrome 的全局输入表面和 child session readiness，属于 BrowserOwner/SessionManager，必须保留。
3. Resource：file chooser interception、dialog 生命周期、popup target 发布。它们必须在动作前显式建立或由对应 registry 持有，不能塞回普通 action 猜测。
4. Action 后观察：XHR/Fetch effect stream、DOM/animation settle、capture shape、presentation baseline。这里才是 Agent 默认复合合同持续放大复杂度的部分。

因此正确修法不是回退最近所有 action 代码，也不是给小红书、CRM、Magento 或某种组件增加等待；而是保留前三类 owner，把第四类从 Agent 默认动作路径退出。

## 成熟实现对照

本轮对照固定在以下源码与发行快照，不按项目名或方法名推断语义：

- Codex Browser `openai-bundled/browser/26.831.20005` 的完整运行时文档与真实 Tool 操作；
- Playwright `9e3157b5c50b` 的 `server/frames.ts` 与 `client/page.ts`；
- Puppeteer `5ecc6947cd52` 的 `ElementHandle.ts`、`Frame.ts` 与 `Page.ts`；
- agent-browser `eb05921bad87` 的 core Skill 与 MCP schema；
- browser-use `67e7194c0690` 的 action/DOM watchdog；
- Stagehand `4d88741a0e22` 的 TypeScript Page、Locator 与 `act/observe/extract` RPC facade；
- browser-harness `3586ec29983d` 的 helpers、daemon 与 recorder。

对照得到的同层事实是：

| 实现 | Action 的公开定义 | 导航/业务后置条件 | 下一次 Agent 观察 | 对 AB 的约束 |
|---|---|---|---|---|
| Codex Browser | Locator/坐标动作独立返回；strict 定位失败直接给候选诊断 | `expectNavigation(action)`、`waitForURL()`、`waitForLoadState()` 独立表达 | 独立 `domSnapshot()`；Skill 要求按下一决策选择最便宜事实 | Agent UX 可以流畅，但不能靠 action 返回 observation 冒充完成 |
| Playwright | actionability、可信输入，以及本次输入直接触发的顶层导航 signal barrier | Page/Frame wait 与事件 waiter 独立；不会等待任意 SPA 业务结果 | Playwright 本身不定义模型观察循环 | AB 可以吸收 action-owned 自动等待，但不能把它扩张成通用 settle |
| Puppeteer | `ElementHandle.click()` 是 scroll、clickable point、mouse input | 调用方先注册 waiter，再和 click 并发 | 无模型观察层 | race-free expectation 必须在动作前装配，动作后轮询只能覆盖可重读状态 |
| agent-browser | ref validation、hit-test、输入派发；阻挡时明确报告 covering element | URL/load/text/function/download 是独立 wait 命令 | 标准 Skill 明确 snapshot → action → fresh snapshot | 成熟 AX/ref/action 引擎不要求 mutation RPC 拥有 snapshot |
| browser-use | ActionWatchdog 处理输入、下载和控件策略 | BrowserSession/事件与独立 wait 处理影响 | DOMWatchdog 响应 BrowserStateRequest，统一构建 DOM/screenshot state | Agent loop 可自动取下一轮 state，但 Action 与 Observation 仍应是两个 owner |
| Stagehand | Page/Locator 是确定性 RPC；`act()` 是另一个模型驱动入口 | Page wait 独立 | `observe()`、`extract()` 独立于普通 click | AI 高层能力可以组合底层动作，不应污染确定性 SDK 合同 |
| browser-harness | helper 执行 raw CDP action | `wait_for_load/element/network_idle` 显式调用 | recorder/宿主可在 helper 后自动记录或观察 | 自动观察属于宿主策略，不属于 action primitive |

- Codex Browser 的可见 API 把 `click()`、`expectNavigation()`、`waitForURL()`、`waitForLoadState()`、DOM/AX observation 分开；Skill 要求动作后选择足以回答下一问题的最便宜状态，不盲目重试。它的 `ax.write()` 仍是独立观察调用，但会在合适时默认展示相对上次 AX state 的 diff；调用者用 `{ disableDiffing: true }` 强制完整树，而不是选择公开的 `"diff"` mode。
- agent-browser 的标准循环是 snapshot、action、fresh snapshot；wait URL/load/text 是独立命令。它另外提供显式 `diff snapshot`，由调用者要求相对上一份 snapshot 的差异。它的 Rust vertical slice 也只要求 ref validation、hit-test、CDP input 和明确动作结果。
- Playwright 的普通 click 负责 actionability、输入以及由本次输入直接触发的顶层 navigation signal barrier；`waitForURL()`、`waitForLoadState()` 和 event waiter 仍是独立 Page/Frame 能力。它不把任意 SPA 业务完成压成统一 action settle。
- Puppeteer 的 `ElementHandle.click()` 只做 scroll、clickable point 和 mouse input；navigation、popup、file chooser 都要求调用方先建立 waiter，再与 click 并发，说明 race-free expectation 与普通 input dispatch 是可组合的两个责任。
- Stagehand 把确定性 Page/Locator action、页面 wait 与模型驱动的 `act/observe/extract` 分成独立 RPC；它没有让普通 `Page.click()` 自动执行 `observe()`。
- browser-use 的 Agent step 会在下一轮统一取得 browser state，但底层 click watchdog 与 DOM state watchdog 仍是分开的 owner；它内部含大量 JS click fallback、download detection 和 widget 特判，不能作为 AB 精确动作合同照抄。
- browser-harness 的 recorder 会在 helper 成功后自动 observe，但它的生产 helpers 本身仍是 raw CDP action 与显式 `wait_for_load/element/network_idle`。这种“宿主循环自动观察”是 Agent UX 策略，不证明 action RPC 应拥有 observation。

AB 不复制这些框架的对象或内部实现。共同机制只用于验证一个产品判断：可靠 action 可以有严格、复杂的 pre-dispatch/action-owned 语义，但通用业务 postcondition 必须由调用者显式选择。

### Alpha.3 发布前复审

Git 历史表明，`waitForURL()` 与 `waitForLoadState()` 的 SDK 方法都首次进入 `0cea324`；`65213db` 计划曾明确把它们延后为“根据真实缺口单独设计”，而不是已经实现后又撤销。Action 默认 observation 退出后，调用者需要能表达 URL 与当前 document lifecycle 这两个机械后置事实，这个前提此时才成立。二者因此属于被推迟后补齐的成熟 Page primitive，不是围绕某个站点反复换名。当前实现也不把动作后的轮询冒充 race-free `expectNavigation(action)`；需要预先装配的事件期待仍未进入 Alpha.3。

`ax.write("diff")` 同样首次进入 `0cea324`，但它替代的是 action option `click({ write: "diff" })` 所承担的错误 owner，不是把同一实现换个入口。成熟实现对 observation 的调用边界有共识，对 diff 的选择策略没有统一接口：Codex Browser 在独立 `ax.write()` 内自动选择，agent-browser 让调用者显式执行 `diff snapshot`。AB 保留显式 mode，因为 `write()` 不只向模型输出文本，还返回带 observation identity、完整 ref map、capture shape 和 lease 的 typed `AXState`；调用点应明确自己取得的是完整正文还是差异正文。这个选择对齐 Codex 的 action/observation 分离，对齐 agent-browser 的显式 diff，同时明确不声称复刻 Codex 的自动 diff 策略。

复审发现并修正了一个真实合同漏洞：`write("diff", { maxChars })` 曾被宽泛 overload 接受、再由运行时拒绝。公开 overload 现在只让 `"state" | "screenshot" | "both"` 接受 capture-shape options，`"diff"` 在编译期和运行时都只接受 deadline/cancellation；同一句误用已从“TypeScript 通过、运行时报错”变为 TS2769。`page-wait-boundaries` 场景则用服务器扣住 parser-blocking script，证明 `navigate(waitUntil: "none")` 与 URL 已完成时 `DOMContentLoaded` 仍可保持 pending，只有资源释放后 `waitForLoadState("domcontentloaded")` 才完成。它验证的是浏览器生命周期合同，不包含站点 label、业务状态、任意 sleep 或专用 helper。

### 同页 Codex Browser 实际对照

2026-09-02 使用 Codex Browser 当前公开 Tool 与同一源码构建的 AB Agent facade，在 `https://github.com/microsoft/playwright/issues/42452` 复核同一页面边界：

- Codex Browser 的 `domSnapshot()` 暴露了两个同名 `om singhal (Om-singhaI)` 作者链接；不加 scope 的 strict Locator 直接列出候选并建议使用稳定 test id，`getByTestId("issue-body-header-author").getByText(...)` 得到唯一目标；
- Codex Browser 的 `expectNavigation(() => click(), { url: "**/Om-singhaI", waitUntil: "domcontentloaded" })` 在约 1.6 秒返回，随后独立 `domSnapshot()` 得到作者页内容；动作、导航 expectation 和 observation 是三个可见步骤；
- AB 的完整 AX state 同样暴露两个候选，`ABError.details.candidates` 也包含 tag、role、name、attributes 和 frame identity，但普通未捕获错误只显示 `locator matched 2 elements`；Agent 必须额外捕获并展开错误才看得到已经存在的诊断；
- AB 当时的 Agent `Locator` 没有 descendant `getByText()`，自然的 Playwright-style 组合直接抛 `getByText is not a function`，只能写成 `section.locator(tab.playwright.getByText(...))`；这个差距来自 SDK API 形态，不是 SelectorEngine 能力；
- 使用已有组合选中唯一作者后，AB `click()` 在约 1.9 秒返回，`ActionResult` 明确包含 destination URL、document generation、target 和真实 dispatch mechanism；独立 `waitForURL()` 立即命中，独立 `ax.write("state")` 得到作者页。它证明 action/wait/observation 拆分可用，也证明 AB 的动作事实比单纯 void click 更丰富；
- 同页另一次 `target="_blank"` 对照中，Codex Browser 的 click 很快返回而 child 没有出现；该结果没有被包装成 popup 成功，进一步说明 action 不应自动证明所有页面后果。

这组现场不用于给 Codex Browser 计算成功率，也不要求 AB 复制它的私有 runtime。它只验证当前公开定义确实允许 Agent把“输入是否完成”“预期导航是否发生”“下一步看什么”分别表达。

## 保留、迁移与退出

### 保留在 Action owner

- target/session/frame/document/ref identity；
- strict resolve、attached/visible/enabled/editable/checkable 和稳定几何检查；
- scroll、OOPIF 坐标换算、event-time hit target 与可信 CDP input sequence；
- action 实际使用的 mechanism、target、timing、直接 field settled value；
- dispatch 后 dialog/pending-release 与 transport cancellation 的 `outcome_unknown`；
- browser-global input-surface lease 和同一 tab mutation ordering。

### 迁移到显式 Wait/Resource owner

- URL pattern、document navigation、load state；
- 元素 attached/detached/visible/hidden 与业务可见文本；
- popup、download、file chooser、dialog、network、console 等生命周期事件；
- 任意“保存成功”“列表刷新”“搜索结果出现”等业务结果。

等待必须在可能丢事件的场景中先于动作装配；对可重读状态可以在动作后显式等待。等待成功只证明它自己的条件，不自动输出完整 AX state。

### 退出 Agent 默认路径

- mutation 的默认 `write:"diff"`；
- 首次 mutation 因无 baseline 自动改成 post-action full state；
- `Locator.waitFor()` 成功后默认 `ax.write("state")`；
- Skill 中把 action-returned diff 当作下一步观察的标准路径；
- 为让复合调用看似稳定而增加站点延时、全局 network-idle、重复 input 或隐式 fallback。

### 暂时保留在 Core

- 调用者显式传入 `observe/baseline/observation` 的组合 transaction；
- `ActionResult.observation` 与 `observationOutcome` 的 typed identity；
- 现有确定性场景对该显式能力的验证。

Core 的保留不是兼容承诺，也不允许 Agent facade 继续默认使用。它是一个尚有正面证据、需要独立评估的库级能力。

## 实施边界

下一批生产变化必须完整覆盖 Agent AX、Locator、CUA、Skill 和生成分发文档，不能只改某一种 click：

1. Agent mutations 只传 `observe:"none"`，不接受 `write`，不自动 presentation；typed action result 和文本输入的 settled-value 警告保留。
2. Agent `Locator.waitFor()` 变成纯 wait；观察由显式 `ax.write()` 承担。
3. Agent Playwright-style surface 补齐 URL/load 等显式页面 wait；若需要 race-free navigation expectation，应由明确组合 API 在动作前装配，不能用动作后的轮询假装没有 race。
4. Skill 把操作循环写成 `observe -> act -> cheapest explicit fact`；连续已确定动作可以同一托管 JavaScript cell 完成，到下一决策点再观察。
5. Core/Rust 的显式 action observation 不在本批删除，也不为 Agent 默认路径新增兼容分支。
6. Core 与 Agent `Locator` 补齐 descendant semantic builders，使 scope composition 与 Playwright/Codex Browser 的自然调用形态一致；它只构造现有 immutable query plan，不改变 Rust selector 语义。
7. strict violation 的候选诊断进入普通错误文本，同时继续保留结构化 `details`，让任意 Node REPL/MCP host 都能看到诊断而不依赖私有 response writer。
8. `ax.write("diff")` 只接受 operation deadline/cancellation，并机械继承 baseline capture shape；若调用者需要不同 observation contract，就显式建立新的 full state。

## 为什么这些证据可以支持改动

测试总数和绿色退出码只说明某次命令完成，不能证明 API owner 合理。本次判断依赖的是能够排除相反实现的独立事实：

- `async-spa-navigation` 让真实 pointer action 启动一个延迟 Fetch，只有响应回来后才 `pushState`。无 observation 的 action 在响应发出前返回，随后 `waitForURL()` 才观察到目标 URL。若 action 仍暗中等待应用 settle，这个边界会直接失败；因此它能支持“action 不拥有业务后置条件”和“URL 属于独立 wait”，而不是只支持某个站点。
- `page-wait-boundaries` 让新 document 的 parser-blocking script 保持未响应。`navigate(waitUntil: "none")` 返回且 `waitForURL()` 已命中时，`waitForLoadState("domcontentloaded")` 必须仍然 pending；释放脚本后同一个 wait 才完成。这个事实把 URL、当前 document lifecycle 和应用 readiness 分开，也能揭穿一个只检查 URL、固定 sleep 或无条件成功的伪实现。
- `large-document-local-mutation` 在被截断的大 AX 文档中保留一个靠后的稳定节点，并只插入局部内容。Action 不得替换展示 baseline；显式 `ax.write("diff")` 必须继承同一 capture shape、保留稳定节点 ref、给新节点非冲突 ref，并把模型输出限制为实际局部变化。若 diff 隐式切换 mode/surface/budget，或重新编号整棵树，这些事实都会失败。
- TypeScript 反例 `ax.write("diff", { maxChars: 8000 })` 曾因宽泛 overload 通过编译、再被运行时拒绝。收窄 overload 后同一句在编译期失败，而合法 diff 和完整 state 调用保持原类型。这个反例直接证明修的是公开合同不一致，不是为了增加类型测试数量。
- 同页 Codex Browser 对照证明它将 action、navigation expectation 和下一次 observation 分成可见调用；当前正式文档又证明它在独立 `ax.write()` 内自动选择 diff。agent-browser 则提供显式 `diff snapshot`。这些来源共同支持 owner 分离，但不支持“只有一种成熟 diff 拼写”；AB 的显式 mode 必须由自身 typed observation identity 与 capture-shape 合同来辩护。

其余编译、Rust/Host 检查、生成、package identity 和真实 Chrome 场景只承担一致性职责：确认协议、SDK、Runtime、self-contained Skill 与 npm 产物来自同一份 `ab-runtime@0.3.0-alpha.3+38740b80c983899f` 源码，并且本批没有破坏既有 owner。它们不能替代上面的设计证据，也不能外推为任意站点或全部 Hard 已成熟。

官方 WebArena-Verified Hard 771 仍保留为复杂 mutation 的独立结果：在 reset 的 `shopping_admin` 环境中，Agent 只通过 AX、semantic/CSS Locator、typed field reads 和 trusted pointer action 识别并批准符合条件的 review；官方 NetworkEventEvaluator 确认最终副作用正确。这个结果说明 action/wait/observation 分离没有迫使 Agent 使用 screenshot、CUA、evaluate、raw CDP、HTTP 直改或任务专用 helper，但它不决定 `waitForLoadState()` 的生命周期语义，也不决定 diff 应显式还是自动。
