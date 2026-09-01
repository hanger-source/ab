# Observation And Action Implementations

本档案把页面观察拆成三层：协议事实、页面内启发式和对外序列化。三层混在一起时，调用者很难知道“页面没有该元素”还是“观察算法没有覆盖”。动作同样区分元素解析、actionability 和输入发送。

## Browser Use Browser Core

只研究 `browser/session_manager`、DOM serializer 和 actor element，不研究 Agent loop。

已确认机制：

- SessionManager 监听 `Target.attachedToTarget` / `detachedFromTarget`，设置 `Target.setAutoAttach(flatten: true)`，target 可拥有多个 session；
- target、session、frame 分别建图，OOPIF target 合并进统一 frame hierarchy；
- DOM node 元数据同时携带 `session_id`、`frame_id`、`target_id`，不是在动作时从当前 tab 猜；
- `cdp_client_for_node()` 依次按 exact session、frame、target 解析发送端；
- serializer 组合 DOMSnapshot、AX、paint order、visibility/clickability 等来源，对外索引只是这批事实的投影；
- `test_dom_serializer_session_identity.py`、selector index collision 和 frame hierarchy 测试直接覆盖跨 session 身份问题。

源码入口：

- `browser_use/browser/session_manager.py`
- `browser_use/browser/session.py`
- `browser_use/dom/serializer/`
- `browser_use/dom/service.py`
- `tests/ci/browser/test_dom_serializer_session_identity.py`
- `tests/ci/browser/test_dom_selector_index_collisions.py`

边界：Browser Use 仍包含 focus 恢复、about:blank 复用和 navigation fallback 等产品策略；这些不属于页面观察协议，不应随 session-aware 机制一起照搬。

## Stagehand Browser Core

只研究 `understudy`、a11y snapshot、frame registry、locator、CLI driver 和 deterministic action execution，不研究模型选择与 instruction 解析。

已确认机制：

- `FrameRegistry` 同时维护 frame topology、`frameId -> ownerSessionId`、`sessionId -> frameIds` 和 parent document 内 iframe owner backendNodeId；root swap 会迁移 root ordinal，OOPIF child session 会接管对应 frame ownership；
- `ExecutionContextRegistry` 按 CDP session 分别维护 frame/main-world execution context；locator 不把 main world 当成全 page 单例；
- a11y snapshot 分成 capture、DOM tree、coordinate resolver、session builder 与 frame merge，而不是一个页面内脚本完成全部观察；
- snapshot 中公开的编码是 `frame ordinal-backendNodeId`，同时生成 encoded id 到 absolute XPath 的 map。action inference 输出的 id 在执行前被转成 XPath；因此 encoded id 是本轮观察的索引，不是跨 DOM 世代的持久 node handle；
- locator 每次动作都重新解析 CSS/text/XPath/deep locator 得到当前 frame session 内的 RemoteObject，再在 finally 释放 objectId。未命中时硬失败，不保留旧 RemoteObject；
- click 只做 resolve、scrollIntoView、box model center 和 CDP mouse dispatch，没有 Playwright/Cypress 那套 attached/covered/stable/enabled actionability。DOM `sendClickEvent` 是独立方法，不在 click 失败后自动替换语义；
- fill 先由页面 helper 判定 native setter 或 keyboard input，再按明确 status 走 `Input.insertText`/key events。源码仍保留旧 bundle 无 status 时调用 type 的 compatibility 分支，该分支不属于 AB 借鉴候选；
- `LifecycleWatcher` 用 main-frame loaderId 区分本次导航、follow-up navigation 和被新导航 supersede，network idle 只统计与当前 loader/frame 相关且不在 ignored resource types 的请求；
- action 前的 `waitForDomNetworkQuiet` 是另一套较弱的 settle：500ms quiet、2s 后强制移除 stalled request、总 timeout 到点仍 resolve。它是“尽量等待”而不是完成性证明；
- CLI daemon/session manager 允许一组浏览器命令复用连接；近期源码和测试包含“不重复激活同一 tab，避免前台抢焦点”的明确处理；
- snapshot 默认只输出 accessibility tree，ref map 可选择完整输出；删除单独 refs 命令是为了避免重放旧 snapshot 的 stale map。

源码入口：

- `packages/core/lib/v3/understudy/a11y/snapshot/`
- `packages/core/lib/v3/understudy/frameRegistry.ts`
- `packages/core/lib/v3/understudy/executionContextRegistry.ts`
- `packages/core/lib/v3/understudy/locator.ts`
- `packages/core/lib/v3/understudy/lifecycleWatcher.ts`
- `packages/core/lib/v3/handlers/handlerUtils/actHandlerUtils.ts`
- `packages/core/lib/v3/handlers/actHandler.ts`
- `packages/cli/src/lib/driver/`
- `packages/core/tests/integration/shadow-iframe-oopif.spec.ts`
- `packages/core/tests/integration/locator-backend-node-id.spec.ts`

边界：Stagehand 的 frame/session registry 与 loader-aware navigation watcher 是可直接比较的底层机制；snapshot id 转 XPath 后重解析是一种“位置描述重新求值”，并不能证明仍是观察时的同一节点。上层 self-heal 会重新观察并选择新 selector，属于 Agent 决策层，本研究明确排除。其 click 的成功也只证明输入已派发，不证明元素可操作检查或业务结果完成。

## Alibaba Page Agent PageController

只研究 `page-controller`，不研究 PageAgentCore 的 LLM tool loop。

已确认机制：

- 页面内 DOM tree 脚本来自 Browser Use 的早期实现并有本地修改；通过 WeakMap 缓存 rect/style/client rect，在单次采样中降低重复 layout 查询；
- interactive index 不只依赖语义标签，还结合 visibility、cursor、onclick、tabindex、iframe offset 等启发式；
- 每次 `updateTree()` 清理旧高亮、重建 flat tree、simplified HTML、`index -> Element` selector map 和 index 文本 map；首次完成前所有 index action 硬失败；
- PageController 按 index 保存真实 Element 引用，再由 actions 对该 Element 执行 click/input/select/scroll。index 本身没有 target/session/document generation，也没有在动作前确认引用是否仍属于最新页面世代；
- `getPageInfo()` 单独返回 viewport、document 尺寸、滚动位置和剩余页数，这些是明确页面事实；
- click 会滚动元素和所属 frame，计算中心点并做 `elementFromPoint` hit-test，再人工派发 pointer/mouse/focus 序列，最终调用命中节点的 `.click()`；它没有 CDP Input 的真实浏览器输入语义；
- input 对普通 input/textarea 使用 native value setter 加 input event；contenteditable 先尝试 synthetic beforeinput/input，结果不符时再用 deprecated `execCommand`。源码明确列出 Monaco、CodeMirror、Draft.js 等无法由这套通用策略覆盖的边界；
- action 对外统一返回 `{ success, message }`，内部不同阶段的失败会被压进字符串；click/input 尾部还有固定 100/200ms 等待。它提供易消费结果，但损失了 target、stage、chosen node 和 changed semantics 等诊断事实。

源码入口：

- `packages/page-controller/src/PageController.ts`
- `packages/page-controller/src/actions.ts`
- `packages/page-controller/src/dom/dom_tree/index.js`
- `packages/page-controller/src/dom/getPageInfo.ts`

边界：它证明页面内观察与动作可以做成轻量、可嵌入组件，也展示了真实 Element map 比 JS-in-string 方便。但 index/Element 引用只在当前 document/page world 中成立，不能替代 CDP target/session/document generation；人工事件序列、contenteditable fallback 和固定等待也不能成为 AB 的透明原语。更值得吸收的是采样缓存、明确 `updateTree` 边界和页面事实拆分，不是整个“index action”承诺。

## Chrome DevTools MCP Snapshot And Locator

- snapshot 来源是 Puppeteer AX snapshot，UID 由 `loaderId + backendNodeId` 复用；
- UID 解析回 snapshot 内 AX node 和 ElementHandle；detached 后硬失败；
- click/fill 使用 Puppeteer Locator，因此 actionability 来源可追到 Puppeteer，不是自写 DOM click；
- snapshot 可插入额外 DOM handle，但额外节点的来源和作用域显式保存在 page state。

与 Browser Use/Page Agent 的关键差异：它把启发式补节点限制在 snapshot 生成阶段，动作仍由 ElementHandle/Locator 执行；Page Agent 的观察和动作更多都发生在页面 JS 内。

## agent-browser Snapshot And Ref

- AX tree 是主来源，页面 JS 扫描 cursor/onClick/tabindex/contenteditable 作为补充来源；
- ref 保存 backendNodeId、role/name/nth 和 frameId；
- OOPIF 使用 frame 到 child session 的映射；
- stale backendNodeId 后按 role/name/nth 重查属于隐式语义恢复。

这套实现很适合研究“协议节点与页面交互提示如何合并”，但它把再定位藏在 ref 动作内部，和 AB 希望失败可解释的契约冲突。

## 原理差异

| Dimension | Browser Use | Stagehand | Page Agent | Chrome DevTools MCP | agent-browser |
|---|---|---|---|---|---|
| Primary observation | CDP DOM/AX/snapshot composite | CDP/a11y snapshot and frame merge | in-page DOM traversal | Puppeteer AX snapshot | CDP full AX tree |
| Interaction supplement | serializer clickability/paint | locator/frame resolver | page JS heuristics | extra handles + Locator | page JS cursor/listener scan |
| Frame/session identity | stored on node | frame registry/session builders | document/iframe recursion | delegated to Puppeteer | frameId and OOPIF session map |
| Public ref | serializer index/node | locator/ref | highlight index to Element | loader+backend UID | eN to RefEntry |
| Stale behavior | requires exact source review per action | snapshot id becomes XPath and is re-resolved; same-node identity is not preserved | map only refreshes on explicit update; no document generation guard | hard failure | implicit semantic requery |
| Action engine | CDP/page actor | per-frame locator + CDP box/input; DOM click is separate | DOM methods/events | Puppeteer Locator | CDP box/input or DOM object |

## 当前可确认的设计原则

1. 观察输出必须能追溯来源。AX、DOM、listener、layout 和 screenshot 是不同事实，合并后仍要能解释遗漏来自哪一层。
2. ref 应携带作用域，而不是只携带显示编号。至少需要 target/session/frame/document generation 中足以防串的一组身份。
3. 动作不能因为 ref 很方便就隐藏目标重选。重定位若存在，应成为调用者显式选择或独立结果事实。
4. 页面内启发式适合由普通 Agent 脚本和函数式 `evaluate()` 组合并快速演化；只有跨页面稳定、失败边界清楚的机制才适合进入 SDK 原语。
