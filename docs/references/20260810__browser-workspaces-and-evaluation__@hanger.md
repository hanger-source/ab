# Browser Workspaces And Evaluation

本档案只研究浏览器脚本如何成为可复跑、可审计的工作产物，以及环境如何分段记录 action、observation 和 validation。不研究 Agent loop、prompt 或模型策略。

## BrowserGym

定位：把浏览器交互包装成 Gym environment，以固定 observation/action space 支撑可重复评测。

已确认机制：

- 每次 reset 创建独立 Playwright BrowserContext，显式建立 page history、active page、last action/error 和 observation space；
- `step()` 依次记录 action execution、page loading wait、task validation 和 observation extraction 的起止时间，失败保留 `last_action_error`，不会只返回一个总耗时；
- observation 同时提供 open pages、active page index、screenshot、AX tree、DOM snapshot、focused element、last action/error 等不同来源，不把它们混成一个“页面理解”字段；
- DOM extraction 先临时给页面元素标 BID，再通过 `DOMSnapshot.captureSnapshot` 获取 DOM/layout；AX tree 按 frame 单独抓取后合并，并处理 iframe owner 与 child root 关系；提取结束后移除临时标记；
- task validation 前后保存 active page 与 page history；validator 若污染浏览器状态，会恢复环境状态并记录 warning。

源码入口：`browsergym/core/src/browsergym/core/env.py`、`observation.py`、`action/base.py`、`action/highlevel.py`。

边界：post-step 包含固定 pre-observation sleep、调用 `context.cookies()` 触发 Playwright callback 等评测环境 hack；这些证明“状态阶段要可观测”，不证明某个固定等待适合作为 AB 默认行为。

## Webwright

定位：让浏览器探索直接发生在 shell/Python workspace 中，逐步沉淀为可复跑脚本和文件证据。

已确认机制：

- LocalWorkspaceEnvironment 每一步先把命令写为 `steps/step_N.sh`，把完整输出写独立 log；对外 observation 只返回截断投影和 log path；
- workspace 固定包含 task metadata、steps、logs、screenshots、临时目录、command history 和 final script，最近文件清单成为下一步可发现的上下文；
- LocalBrowserEnvironment 把每一步 Python 写成 `step_N.py`，同时追加到整体 `script.py`；执行环境直接注入 page/context/browser/playwright/task，避免字符串 shell 在每一步重建浏览器语义；
- local CDP、local launch 和 persistent context 的资源归属分开；connect-over-CDP 时可只关闭自己新建的 page，而不默认关闭外部 browser；
- persistent browser helper 把 pid、connectUrl、userDataDir、createdAt 写入 session JSON；后续步骤 attach 后使用 disconnect 保留 browser，release 才显式终止进程和回收 profile。

源码入口：`src/webwright/environments/local_workspace.py`、`local_browser.py`、`tools/persistent_local_browser.py`。

边界：Webwright 的 browser provider 是 Playwright/CDP，它不解决 extension relay、真实用户 tab ownership 或 frame/session routing。可比较的是 runner 工作区、脚本沉淀、完整输出与摘要分离、外部 browser ownership，而不是其 Agent 配置。

## Web Platform Tests

定位：以可复现 fixture、协议断言和结果分类验证 WebDriver、WebDriver BiDi 与浏览器行为；它是实验 oracle，不是另一套面向用户的浏览器操作 runtime。

已确认机制：

- WebDriver session 可以跨 pytest 用例复用，但 capability 变化会显式结束不匹配的 session；测试运行结束时统一关闭仍存活的 session；
- Classic 用例结束后恢复 timeout、有效窗口、prompt、额外窗口、窗口状态和顶层 browsing context；异常则结束 session，不把未知污染带入下一条用例；
- BiDi fixture 对 event subscription、preload script、cookie、临时 tab/window 分别记录资源标识，并在 `yield` 后逆序取消或关闭；
- stale element 用例先取得 element reference，再从 DOM 移除元素，随后断言协议返回 `stale element reference`；context destroyed 用例同时断言关闭新 context 会发事件，而普通顶层 navigation 不应销毁同一个 context；
- wptrunner 为每条 testharness 用例创建独立窗口，测试前后关闭遗留窗口；内部异常、外部超时和 crash 会进入独立结果状态，并触发 runner/browser 重启，而不是被归并成普通失败；
- 结果记录区分文件级 status、subtest status、expected、known intermittent、unexpected pass/fail、timeout、browser pid 与 crash evidence。

源码入口：`webdriver/tests/support/fixtures.py`、`webdriver/tests/support/classic/fixtures.py`、`webdriver/tests/support/classic/helpers.py`、`webdriver/tests/support/bidi/fixtures.py`、`webdriver/tests/classic/element_click/click.py`、`webdriver/tests/bidi/browsing_context/context_destroyed/context_destroyed.py`、`tools/wptrunner/wptrunner/executors/executorwebdriver.py`、`tools/wptrunner/wptrunner/testrunner.py`。

边界：测试清理中的 best-effort exception suppression 是为了恢复 fixture，不是产品命令的错误语义；WPT 按测试 session/window 重置资源，AB 则让 daemon 与专用 Chrome 跨 SDK client 常驻，只清理断开 client 自己的资源。

## BackstopJS

定位：把页面状态展开为 scenario、viewport 和 selector 的截图矩阵，再用 reference/test/diff artifact 形成视觉回归结果。

已确认机制：

- 一次运行复用一个 Playwright Browser，每个 scenario/viewport 创建独立 BrowserContext 与 Page；捕获并发和图片比较并发分别限流；
- 捕获前依次执行 before script、navigate、readyEvent、readySelector、delay、remove/hide selector 和 ready script；页面脚本负责 selector expansion、存在性与可见性投影；
- document、viewport 和 element screenshot 是不同路径；element 可按 body bounding box 扩大 viewport，未找到、不可见和截图异常分别写入占位图片；
- 每个 test pair 保存 reference、test、selector、scenario、viewport、dimension difference、mismatch percentage 和 diff image；缺 reference/test 文件、数量不符、尺寸或像素阈值不符进入失败；
- JSON/browser/JUnit report 与 reference approval 是 artifact 生命周期的一部分，不把截图文件本身当作完整判定。

源码入口：`core/util/createBitmaps.js`、`core/util/runPlaywright.js`、`core/util/compare/index.js`、`core/util/compare/compare-resemble.js`、`core/command/report.js`、`capture/backstopTools.js`。

边界：`readyEvent` 超时会记录错误后继续捕获，截图失败会写占位图参与后续比较，selector capture 的 viewport resize 也会改变 presentation。它证明视觉 oracle 需要完整 artifact schema，也同时证明“生成了一张 PNG”不能代表采集成功或页面已就绪。当前源码 ref 最后提交在 2024 年，不作为现代 Playwright 行为的替代证据。

## 对 AB 的当前参照

| Concern | BrowserGym | Webwright | WPT | BackstopJS | AB direction |
|---|---|---|---|---|---|
| Step evidence | structured timings and last error | source step + full log + output projection | file/subtest status、expected、intermittent、timeout、crash | capture logs + test pair + report；部分采集失败被投影为占位图 | SDK 调用、daemon trace、artifact 与 result 使用同一个 trace context |
| Browser reuse | one context per episode | persisted CDP session across shell steps | session 可复用，测试窗口隔离，污染或能力变化时结束/重启 | one browser per run、one context/page per scenario view | daemon 与专用 Chrome 跨 client 常驻，tab 显式创建、选择和关闭 |
| Observation | multi-source structured state | script-defined plus screenshot/console | protocol command/event 与独立断言 | readiness + selector state + screenshot pixels | SDK primitives provide facts, caller composes interpretation |
| Final reusable work | benchmark trajectory | final script in workspace | conformance test + expectation metadata | reference/test/diff images + JSON/browser/JUnit report | confirmed exploration should become a script/library, not App runtime |
| Cleanup | context-owned | ownership-aware disconnect/release | 资源逐项回收，异常 session 结束，runner 强停后重建 IPC queue | scenario context closes after capture; browser closes after matrix | disconnect 只释放当前 client 资源；tab、Chrome 与 daemon 不随 client 退出 |

这些项目共同支持 AB 的使用方向：交互式 Node REPL 用于短探查，复杂或需要反复修改的流程应尽快成为 workspace 内 TypeScript/JavaScript 脚本；完整输出和 artifact 可以很大，但交互返回应是可定位它们的紧凑证据。可复跑脚本还需要明确 client resource 归属、预期结果和异常终止条件。这是 Agent 代码组织原则，不需要 AB 自建 runner。
