# Action target change presentation

## 问题边界

AB 的 SessionManager 已经能够发现、初始化并发布微博登录窗口这类独立 Chrome page target，PopupWatcher 也能在预先建立后返回准确 child。但是 source-blind Agent 不知道一个普通点击是否会打开新窗口：原 `ActionResult` 只返回 source target 的 navigation、document、dialog 和 timing；动作后 source URL/document 都不变时，Agent 会把已经发生的 popup 误判为没有反应。要求每次点击前猜测 popup，或每次点击后轮询 `tabs.list()`，都不能构成自然的 Agent 操作面。

这里缺少的不是 AX、DOM 或另一个 target registry，而是把 Runtime 已经拥有的有限浏览器生命周期事实关联到一次动作，并在 Agent 边界可靠呈现。

## 参照实现

- Playwright 同时保留 BrowserContext/Page lifecycle event 与 pre-armed `waitForEvent("popup")`：持续发现和确定性 expectation 是并存语义。
- Puppeteer `BrowserContext.waitForTarget()` 合并 target-created、target-changed 和当前 target 集合，避免把事件订阅时刻当成唯一事实来源。
- agent-browser 在命令边界 drain target created/changed/destroyed；命令后的 dialog 会再次 drain 并主动报告。它证明有限控制面事实适合随命令边界刷新，但不会替 Agent 证明页面业务结果。
- browser-use 每个 Agent step 都把 available tabs 放进 BrowserState，并可附带 recent browser events；盲 Agent 因而不必预知所有 target 变化。
- Stagehand 用 `Page.windowOpen` 作为短时信号，只在近期可能产生 popup 时等待新 Page 注册。AB 吸收这个有信号才延长等待的机制，不吸收其 latest active page 自动选择。
- Codex Browser 在同一次微博登录操作中能够产生独立原生窗口，但公开 tab API 没有把它交给当前 Browser session；因此它不是该场景的实现来源。其值得保留的约束仍是动作不冒充观察、失效对象明确失败。

## Owner 分工

- `SessionManager` 唯一拥有 target/session/frame/realm registry，并且只在 root session 初始化完成后发布 `SessionLifecycle::Attached`。
- `BrowserOwner` 唯一拥有 target mutation lease、child lease 继承、per-target lane 和 headed Chrome input surface。
- `PopupWatcher` 是 opener-scoped Resource，拥有显式订阅的 sequence、gap 与 dispose；popup target 本身不是 Resource。
- `ActionTransaction` 只拥有从 dispatch 前到动作结算的短生命周期关联窗口。它不创建、不关闭、不选择、不长期缓存 target。
- `ActionResult.targetChanges` 是不可变事实副本。Agent Presenter 只展示非空集合，不成为 lifecycle owner。

代码中不能增加 SDK pending-target cache、全局 BrowserChangesManager、active/last/same-origin fallback，或由 Presenter 保存 current target。child 仍须由调用方使用真实 `targetId` 显式取得。

## 采用的动作语义

ActionTransaction 在 dispatch 前同时武装 source browser-event stream 和 SessionManager lifecycle stream：

1. 普通动作沿用 100ms discovery window，与现有 navigation discovery 并行，因此没有 popup 信号时不增加串行等待。
2. source session 出现 `Page.windowOpen`，或者 lifecycle 直接发布 exact-opener child 时，只把当前动作的 target 关联窗口延长到最多两秒。
3. 只有已经完成 root session 初始化、能从 SessionManager 寻址且取得非空 URL metadata 的 page target 进入 `opened`。这不承诺页面 load 或 application document 已稳定；调用方取得 child 后仍显式等待所需 lifecycle fact。结果发布前由 BrowserOwner 应用并读取 opener lease 继承。
4. source root 或本次已打开 child 在窗口内关闭时进入 `closed`。
5. Agent Presenter 对非空结果输出有不可信内容边界的 `AB_BROWSER_CHANGE`；URL/title 只是浏览器元数据，不能作为指令。

已知必须产生 popup 的调用仍使用 `expectPopup(action)`。它能把“没有产生 child”表达成 expectation timeout；普通 `targetChanges` 只是发现实际发生的 target 生命周期，不承诺某个 target 必须出现。

DOM/AX mutation、toast、modal、异步业务成功、XHR 和下载不进入 `targetChanges`。这些事实分别属于显式 observation、typed wait 或预先建立的 Resource，不能借 popup 修复重新塞回 action completion。

## 可证伪证据

`test/ab/scenarios/background-tab-popup-action/` 在真实 headed Chrome 中让隐藏 source tab 通过可信 pointer 打开跨 origin `target="_blank"` child。场景不再用 sleep 或 `tabs.list()` 轮询发现 child，而是要求：

- source action 在既有 deadline 内返回；
- `targetChanges.opened` 只含准确 child，并携带 source opener、目标 URL 和 `owned`；
- 自定义 Agent Presenter 收到包含该 target id 的 `AB_BROWSER_CHANGE`；
- 调用方能直接 `browser.tabs.get(targetId)` 并取得 child AX heading；
- child 内的关闭按钮在同一次动作结果中返回准确的 `closed targetId`，Presenter 同步展示关闭事实；
- source 只收到一次可信点击，目标 endpoint 只请求一次。

这个场景会在以下现实错误下失败：订阅建立晚于 dispatch、ActionTransaction 把无关 client target 纳入结果、SessionManager 在 child ready 前发布、BrowserOwner 未继承 lease、Presenter 未展示、实现仍依赖 tab-list 轮询，或为了等待 child 重放 source 点击。

真实 headed Chrome 运行中，打开动作约 218ms 返回准确 child，关闭动作约 215ms 返回同一 target 的关闭事实；普通异步 SPA 导航另行要求 `targetChanges` 为空。这里验证的是生命周期归属和呈现，不以固定耗时或测试通过数量作为契约。

安装态盲测另由一个没有项目上下文的 Agent 完成：它只读取 `~/.agents/skills/ab`，新开微博首页并从 AX 状态点击“登录/注册”，任务说明没有预告 popup，也禁止动作前后轮询 tab 集合。source URL 和 document 未变化时，动作直接呈现微博 passport 登录 target；Agent 使用结果中的 `targetId` 读取扫码、验证码、账号和微信登录界面，没有输入凭据。最后只关闭该任务创建的 source/child 并 disconnect。这个结果证明新增语义解决的是 source-blind Agent 的发现断点，而不是仅让本地 fixture 通过。
