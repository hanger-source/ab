# Observation usability and coverage

## 场景与错误事实

多个首次使用 AB 的 Agent 在动态、多 frame 页面反复遇到四类摩擦：把 Playwright 的 `scrollIntoViewIfNeeded()` 名字带入 AB；从 `AXState` 读取 `url` 得到 JavaScript `undefined`；每份主文档可操作的状态都因一个未捕获 child frame 显示 `complete:false`，必须展开 `sources.gaps` 才能定性；页面加载期 document、frame topology、viewport、scroll 或 DPR 在一次原子捕获前后变化，使整次 observation 被拒绝，紧接着人工重做又成功。

这些事实来自公开 API 的跨页面使用，不依赖站点 URL、文案、坐标或任务答案。它们也不是同一种 owner：前两项属于 Skill 的首用归属提示；第三项由现有 `complete` 与 `sources.gaps` 准确诊断；第四项的原子拒绝属于 Runtime 正确性，而重复调用纪律属于 Agent facade。

## 判断历史

`20260901__xiaohongshu-agent-operation-comparison__@codex.md` 已记录一次页面初始加载期间的 `observation_consistency_error`，随后一次新 capture 在约 100ms 完成。当时明确把“内置重试”列为 `inconclusive`，禁止凭单次现场加入隐藏重试。这一历史结论没有被回写或抹掉。

此后另一个首次使用 AB 的 Agent 在独立会话中再次遇到同类错误：页面加载期间 document、frame topology、viewport、scroll 或 DPR 改变，下一次观察立即成功。重复事实仍不足以决定 owner；本轮继续用成熟源码和 Codex Browser 当前调用面区分 Core 正确性与 Agent 读取摩擦。

## 与成熟操作面的关系

Codex Browser 的公开 `domSnapshot()` 操作面简短，模型不需要处理 frame coverage，但它也不公开某个 child frame 是否缺失。以下判断固定到实际源码，而不是从项目名推断：

- [Playwright `9e3157b5c50b`](https://github.com/microsoft/playwright/blob/9e3157b5c50b91e194040d25a8dcdb89318587c8/packages/playwright-core/src/server/page.ts#L1024-L1079)，`ariaSnapshotJSONForFrame`：root snapshot 在同一 progress/deadline 中按 1000/2000/4000/8000ms 间隔重试；已渲染 child iframe 的 snapshot 失败被归为空子树，不把整个 root observation 失败。
- [browser-use `67e7194c0690`](https://github.com/browser-use/browser-use/blob/67e7194c069060453f2701e23d733d3f945b4ded/browser_use/dom/service.py#L384-L399)，`_get_ax_tree_for_all_frames`：root AX 失败向上传播；detached 或不可达 child frame 被跳过，其他节点继续返回。
- [BrowserGym `9e779f087de9`](https://github.com/ServiceNow/BrowserGym/blob/9e779f087de9a65668b6974d11f9ce9816026e96/browsergym/core/src/browsergym/core/env.py#L634-L664)，`_get_obs` 与 `constants.py`：对 frame detached、execution context destroyed 等 observation extraction 竞态最多尝试五次，重试间隔 500ms，mutation 不在这条路径。
- [agent-browser `eb05921bad87`](https://github.com/vercel-labs/agent-browser/blob/eb05921bad874cd2a1b4fa5d1149f1ed26576cae/cli/src/native/snapshot.rs#L475-L490)，`take_snapshot`：child iframe snapshot 错误被静默忽略。AB 不复制其静默缺口，而继续保留严格 `complete`、frame 计数和 `sources.gaps`。

共同做法是保住 root、对子 frame 尽力捕获、对瞬时读取竞态有限重试，而不是增加一组公共完整性布尔值。

### Codex Browser 当前调用链

2026-09-02 使用公开 runtime `openai-bundled/browser/26.831.20005` 新建临时 in-app tab，按正常 Agent 顺序执行：

```js
await tab.goto("https://www.xiaohongshu.com/explore");
const snapshot = await tab.playwright.domSnapshot();
```

`goto()` 用时 1141ms；紧接着的 `domSnapshot()` 用时 458ms，返回 19,109 字符的当前页面结构，没有向 Agent 暴露 capture consistency 错误、frame coverage 字段或重试步骤。公开定义只承诺“including expanded iframe body content when available”，并另有 `frameLocator()` 处理显式 iframe 作用域。这个现场不能证明私有 runtime 内部重试次数，但能证明它的 Agent 操作面把一次只读 observation 当成一个调用边界；对照 tab 随后已关闭。

## 采用的变化

### Skill 直接消除两个错误猜测

主 Skill 在第一次 AX 循环旁明确：页面 URL 来自 `tab.url`，`AXState` 不拥有导航状态；AB 的常用动作名包括 `scrollIntoView()`，不提供 `scrollIntoViewIfNeeded()` 兼容别名。完整签名仍留在按需 API reference，不把主 Skill 扩成方法目录。

### Agent 只吸收一次读取竞态

Rust/Core 的每次原子 observation 继续在 identity 改变时整体失败。Agent `ax.get/write("state" | "both")` 捕获开始时固定调用方原始 deadline；第一次仅当错误类型为 `observation_consistency_error`、signal 未取消且 deadline 仍有余额时，立即重新发起一次完整捕获。第二次结果无论成功或失败都直接返回。两个尝试不会拼接 AX、截图或 observation identity，也不会扩大 timeout。

这不是新的公共抽象：SDK 类型、Rust 协议、Core capture 和 `AXState` 均不增加字段或状态。它只把成熟框架在 observation 边界内部吸收的可恢复读取竞态放到 AB 的 Agent facade；Core 调用者仍完整看到第一次 consistency error。

## 明确不采用

- 不向 `AXState` 添加 `url`、隐式 getter 或 Proxy fallback；
- 不增加 `scrollIntoViewIfNeeded()` 兼容别名；
- 不增加 `primarySurfaceComplete`、`frameTopologyComplete` 或其他由现有 frame 计数与 gaps 派生的公共字段；
- 不把 child-frame gap 隐藏、降级为 `complete:true`，也不根据当前任务猜 frame 是否重要；
- 不无限重试、不增加固定 sleep、不在 Core 中隐藏第一次 capture 结果；
- 不重试 click、fill、press、navigation 或任何可能产生副作用的操作；
- 不加入页面、站点、benchmark 或特定 iframe 规则。

## 可证伪的不变量

实现必须满足：现有 `complete`、frame 计数与 `sources.gaps` 继续准确表达严格覆盖；不能因为缺失 child frame 与当前任务看似无关就改写为完整；Agent 原子捕获最多执行两次并共享原始 timeout，Core 调用仍只执行一次并直接返回 consistency error。
