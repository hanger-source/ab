# Extension Execution Runtime

本档案关注扩展怎样在 background、content script 和 page realm 之间执行长期逻辑。比较单位是 tab/frame/document identity、注入时机、realm、command bridge、状态与清理，不是可视化工作流或业务脚本数量。

## Automa

定位：扩展内的浏览器工作流执行器，background engine 管理 worker 和数据流，页面动作通过 content script 执行，少量调试能力使用 `chrome.debugger`。

已确认机制：

- WorkflowEngine 有稳定 execution id，并保存 worker map、连接图、事件 listener、运行历史和共享引用数据；分支会复制当前 tab/window/loop/debug 状态并创建新 worker；
- worker 的 active tab 明确保存 tab id、frameId、frames 和 groupId。interaction block 把 tab/frame 路由到 `tabs.sendMessage`，页面动作在 content script handler 中执行；
- 每个 block 可有自己的 timeout，history 记录 blockId、workerId、activeTabUrl、duration 和上下文；block error policy 内建 retry/continue/restart，属于工作流产品语义，不是底层浏览器事实；
- content script 消息失败时，runtime 会尝试 `scripting.executeScript` 注入整个 bundle，最多重复若干次后再次发送；tab loaded 通过每秒读取 `tabs.get(tabId).status` 判断；
- debug mode 在工作流级监听 `chrome.debugger.onEvent`，只把 activeTab id 匹配的事件交给 listener；结束前等待固定一秒再 detach worker 的 debugger。

源码入口：`src/workflowEngine/WorkflowEngine.js`、`WorkflowWorker.js`、`blocksHandler/handlerInteractionBlock.js`、`injectContentScript.js`、`helper.js`、`src/content/blocksHandler.js`。

边界：Automa 证明 background worker 与 content execution 可以用显式 tab/frame state 组织，但它把 content script 不可达自动解释为“重新注入后重试”，debugger attach 失败压成 `false`，loaded 与 detach 依赖轮询/固定等待。这些策略会隐藏 AB 最需要的失败原因，只作为 legacy 迁移反例和生命周期样本；AB 不保留 extension worker/content-script runtime。

## Violentmonkey

定位：成熟 userscript manager，负责匹配脚本、在 document 生命周期早期准备注入、区分 page/content realm，并跨 background/content/page 传递命令和状态。

已确认机制：

- background 的 injection 数据按 URL 与 top-frame scope 缓存；每次 `GetInjected` 先用 tabId 加 frame document identity 清理旧 request/value/notification state，再为当前 document 建立脚本集合；
- frame identity 不只用 frameId：代码组合 `documentId`、top state 与 frameId，并对 prerender/BFCache restore 单独 reify/reset，避免同一 frameId 的旧 document 状态被直接沿用；
- 脚本按 `document_start`、body、document end、idle 分队列执行。page realm 与 content realm 先 triage，注入结果再反馈给 background；
- page/content bridge 具有 realm-aware handler、callback id 和错误返回。回应必须回到发起命令的同一 realm，避免多个脚本或不同执行世界共享一个无归属全局回调；
- page sandbox 建立一次性 handshake，并保护 bridge 所需原生对象；注入结束释放大型列表供 GC。脚本 storage 变化会精确失效相关 cache，tab/frame 清理会同步撤销 request/value/notification state；
- 近期 fast-inject 路径尝试在 MV3 Chrome 中根据目标 URL 动态注册 `chrome.userScripts`，并更新 API 脚本匹配以维持注册顺序；实现还用 registration duration 与 payload size 判断是否值得走该路径；
- 该路径上线后随即因实际回归把默认值改回关闭，并在不具备 MV3/contentScripts 能力的环境禁用设置。源码当前把它保留为可选实验能力，而不是宣称 document_start 注册天然可靠；
- 当 page injection 受 CSP 或环境影响时，Violentmonkey 会把部分脚本调整到 content realm。这是其产品兼容策略，不是可直接照搬到 AB CDP init script 的默认行为。

源码入口：`src/background/utils/preinject.js`、`preinject-core.js`、`src/injected/content/index.js`、`inject.js`、`bridge.js`。

与 AB 的关系：document identity、runAt 阶段、realm-aware callback、BFCache/prerender 状态和 per-frame cleanup 都直接对应 `InitScriptRegistration` 的可信度。AB 必须让调用者看见“脚本在哪个 document、哪个 frame、哪个 realm、哪个注入阶段运行”；不复制 Violentmonkey 的自动 realm 切换，也不保留 userscript/mount 产品模型。
