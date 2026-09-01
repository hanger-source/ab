# Intent Selectors

本档案研究根据文本和空间关系选择元素的高层机制。它参与动作目标选择，但不能替代 target/session/frame identity，也不能把启发式命中包装成确定事实。

## Taiko

定位：直接基于 CDP 提供面向人类表达的元素查找和页面动作 API。

已确认机制：

- 文本查找在页面内遍历 DOM，先 exact 再 contains，跳过 head/script/style/body 等节点，并以“子节点已有匹配”避免祖先吞掉目标；
- `$function` 递归进入 open ShadowRoot，把调用者提供的查询函数序列化进页面执行；结果转成 runtime object/Element wrapper；
- proximity selector 不是语义关系：先找候选与参照元素的 rect，再按 above/below/near 等几何条件过滤，并按位置距离排序；
- 元素 get 默认通过 `waitUntil` 重复执行 selector；超时返回空数组，再由动作层决定 not found；
- `doActionAwaitingNavigation` 在动作前注册 XHR/frame/navigation/target/reconnect 事件，动作后等待已收集 promise 和 `document.readyState === complete`，并在 finally 清理 listener 与 timeout；
- wait 的事件集合、waitForStart、navigationTimeout 可配置，说明“动作后等待什么”并非浏览器统一事实。

源码入口：`packages/taiko/lib/elementSearch.js`、`proximityElementSearch.js`、`doActionAwaitingNavigation.js`、`actions/pageActionChecks.js`。

边界：Taiko 证明意图 selector 需要大量启发式、DOM world 扫描和等待策略。它可作为高层便利 API 的风险样本，不支持在 AB SDK 中加入一个宣称通用可靠的 `clickByText/near`；若调用者需要这类逻辑，普通 Agent 脚本/helper 函数更透明。

## SikuliX

定位：在桌面截图区域中以图像模板或 OCR 文本寻找视觉目标，再通过 OS-level mouse/keyboard 操作坐标。当前读取 [SikuliX `c6f17990`](https://github.com/oculix-org/SikuliX1/tree/c6f17990494541974353a7c64987f41c6761e612) 的 `Region`、`Finder`、`Match` 与 input device 实现。

已确认机制：

- `Region` 是明确的屏幕矩形，find/wait/exists 每次从该区域重新截图；`Match` 保存 rect、相似度、click target、所用图像/OCR text 和查找耗时；
- wait 不是等待浏览器事件。`Repeatable` 按 `waitScanRate` 周期重新 capture + image match，单次扫描耗时会从 sleep budget 扣除；
- image 的 last-seen rect 可先被局部复查，失败后再扫描整个 Region。这是性能优化，也意味着“同一个视觉目标”实际由每次相似度重匹配决定；
- click 接受 Pattern/File/Text/Region/Match/Location：前几种先转成新的 location，最后用 OS mouse 点击。无参 click 在 `FindFailed` 时直接返回 0，说明 convenience API 会压缩失败信息；
- 视觉命中没有 browser、tab、frame、document、DOM node 或 event-listener identity；前台窗口、遮挡、缩放、DPR、动画和相似图都会改变目标含义。

源码入口：`API/src/main/java/org/sikuli/script/Region.java`、`Finder.java`、`Match.java`、`Mouse.java`、`org/sikuli/support/devices/ScreenDevice.java`。

边界：SikuliX 证明图像匹配是独立的观察与输入 provider，不是 DOM/CDP selector 的 fallback。AB 的 screenshot/CUA 结果必须保留 screenshot/viewport generation、region、DPR 与目标坐标；未来若增加 template matching，还要记录 template/hash 与 score，不能藏进普通 click 或在 DOM 失败后静默启用。
