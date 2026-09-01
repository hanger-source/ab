# Browser Automation Core Capability Taxonomy

这套分类只描述浏览器自动化底座，不包含 Agent planning、prompt、LLM 决策、任务记忆或多 Agent 协作。比较项目时必须落到实现机制，不能用 API 数量或宣传语替代。

## 1. Browser Provider

决定浏览器从哪里来、谁拥有进程、是否复用用户现场。

- 浏览器来源：新启动、连接已有进程、扩展接入、远程托管、定制 Chromium；
- 宿主形态：独立 browser process、嵌入式 `WebContents` / WebView、browser remote end、extension provider；
- profile：临时 profile、持久 profile、用户日常 profile、context 级隔离；
- 宿主范围：Chromium-only、WebDriver 多浏览器、WebDriver BiDi、多引擎私有协议；
- 进程治理：启动参数、PID、崩溃重连、idle timeout、资源上限、浏览器版本匹配；
- 认证现场：cookies、storage、扩展、SSO、证书与代理是否原样可用。

底层实现通常是 `--remote-debugging-port` / pipe、WebDriver endpoint、浏览器扩展 API、native messaging、嵌入式 browser-content API、托管 browser WebSocket 或定制浏览器进程。使用相同 Chromium engine 不代表这些 provider 暴露相同的 target、frame、input、network 或 screenshot 能力。

## 2. Transport And Protocol

决定命令如何到达目标，以及断线、超时和并发时能否解释。

- transport：WebSocket、pipe、HTTP/WebDriver、native messaging、extension relay；
- request correlation：client request id、server request id、pending map；
- protocol surface：原始 CDP、生成式 domain API、WebDriver/BiDi、框架私有协议；
- lifecycle：connect、reconnect、detach、close、pending rejection、backpressure；
- concurrency：全局串行、同 target 串行、不同 target 并行、无序并发；
- diagnostics：method、target、session、phase、elapsed、pending 与断线原因。

## 3. Browser Topology And Identity

决定 window、tab、target、frame、worker、document 和 node 的身份是否稳定且不串。

- 浏览器对象：browser、context/profile、window、tab/page、target、CDP session；
- frame：同进程 frame 与 OOPIF 的统一或分离模型；
- document generation：导航、BFCache、prerender、portal、tab discard/revive；
- node identity：selector、DOM nodeId、backendNodeId、AX nodeId、框架 ref；
- ownership：client/session/worker/group 对 tab 的租约或所有权；
- stale semantics：目标消失、document 更换、node detached 后是失败、重定位还是重新查询。

任何 node ref 至少要说明它在哪个 target/session/document 中有效。裸数值只有在实现证明其作用域安全时才可作为公共身份。

## 4. Page Observation

决定调用者能看到哪些页面事实，以及哪些内容明确不在覆盖范围内。

- DOM：HTML、DOM tree、DOMSnapshot、computed style、layout bounds、paint order；
- accessibility：AX tree、role/name/value/states、DOM 与 AX 映射；
- interaction hints：event listeners、clickability、focusability、visibility、遮挡；
- frames/shadow DOM：open/closed shadow root、same-origin frame、OOPIF；
- screenshot：viewport、full page、element、background target、DPR/坐标映射；
- incremental state：整页 snapshot、diff、stable ref、document generation；
- output shape：人读文本、结构化节点、ref map、分页、artifact。

观察结果必须区分“没有观察到”和“页面不存在”。跨 frame、worker、缓存、浏览器权限造成的覆盖缺口不能被包装成完整事实。

## 5. Page Execution

决定代码运行在哪个 execution context，以及值如何完整返回。

- context：MAIN world、isolated world、utility world、frame-specific world；
- code form：字符串表达式、函数加 JSON 参数、handle/object reference；
- value transport：returnByValue、remote object、stream、chunk、output file；
- preload：new-document script、userscript、binding、exposed function；
- context lifecycle：executionContextCreated/Destroyed、navigation invalidation；
- security semantics：页面 cookie/global/fetch 是否与用户页面一致。

不同 world 不是可静默替换的 fallback。若执行语义改变，应硬失败或把 context 差异作为结果事实。

## 6. Actions And Input

决定“点击、输入、滚动”代表 DOM 语义还是用户输入语义。

- DOM action：`element.click()`、value setter、dispatchEvent；
- protocol input：mouse、keyboard、touch、drag、wheel；
- actionability：attached、visible、enabled、stable、in viewport、hit target；
- targeting：selector、node ref、backendNodeId、coordinates、frame；
- waiting：元素出现、状态满足、导航、网络 idle、用户定义条件；
- evidence：命中的元素、坐标、目标 tab、前后 URL、失败条件；
- background semantics：是否要求 active tab、是否抢焦点、后台节流边界。

DOM click 与物理 click 都有价值，但必须是不同的、可预测的语义，不能用隐藏 fallback 混成一个“似乎总能点”的函数。

## 7. Browser Signals And Side Effects

覆盖页面动作之外的浏览器事实。

- network：CDP Network/Fetch、webRequest、HAR、response body、worker 请求；
- console/runtime exception：历史 buffer、订阅窗口、exception stack；
- dialog：alert/confirm/prompt/beforeunload；
- downloads/uploads：chooser、路径、进度、完成状态；
- cookies/storage/cache/permissions/geolocation；
- tabs/windows/groups/history/bookmarks；
- service worker/web worker/shared worker target；
- performance trace、coverage、CPU/network emulation。

## 8. Orchestration And Resource Scope

描述多步代码如何组合原语，不涉及 Agent 决策。

- library/SDK：可组合对象、函数参数、异常和 `try/finally`；
- CLI：一次调用、脚本入口、可复制命令；
- runner：inline/file/stdin、timeout、环境注入、exit code；
- capability module：核心 SDK 之外的普通模块获得标准 browser/runtime context，不在 extension 内另建协议、registry 或业务生命周期；
- scope helper：temporary tab、capture window、console window、local server；
- cleanup：tab、session、listener、userscript、server、artifact；
- parallelism：多 tab 并行、同 target 排队、资源所有权。

合格的 scope helper 只封装生命周期，不替调用者猜页面语义。

## 9. Output And Artifact

决定大结果、截图、网络记录和失败现场如何保存与复核。

- stdout contract：摘要、截断标记、完整值路径；
- artifact：JSON/JSONL、图片、HAR、日志和失败现场；
- integrity：bytes、hash、validJson、schema/version；
- provenance：method、tab/target/session、URL、时间窗口、触发动作；
- retention：目录结构、清理、容量与敏感数据边界。

## 10. Diagnostics And Operability

决定系统卡住或失败时是否能从日志得到因果证据。

- phase trace：client、relay、extension/provider、CDP、page；
- connection trace：连接替换、service worker 休眠、重连、pending orphan；
- action diagnostics：目标 tab、元素状态、遮挡、document generation；
- health/status：浏览器进程、relay、extension、clients、pending calls；
- deterministic errors：error kind/code、native error、context、elapsed；
- observability overhead：默认日志、debug trace、采样和落盘。

## 11. Evaluation And Reproducibility

评估的是底座行为，不评估 Agent 策略。

- 固定 fixture 与真实页面各自负责什么；
- pass/fail oracle 是否独立于被测工具；
- browser/profile/version 是否可复现；
- 并发、导航、OOPIF、动态 DOM、弹窗、下载等场景矩阵；
- trace/artifact 是否足以解释失败；
- 与另一实现的对照是否真正区分假设。

## 12. Security And Isolation

- 本地监听地址、认证、origin 校验；
- 用户日常 profile 的权限边界；
- URL scheme 与受限页面；
- extension permissions 与 host permissions；
- file path、download/upload、artifact 路径安全；
- 多 client/tab 所有权和跨任务污染；
- page code、userscript 与 remote code 的信任边界。
