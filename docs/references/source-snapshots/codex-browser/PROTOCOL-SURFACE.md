# Codex Browser visible protocol surface

这里的“协议”是 Browser Runtime 暴露给 Agent 的逻辑契约。底层 service transport、AX binary format 和 backend 内部消息不可见，因此不在这里猜测。

## Browser 选择与绑定

- `agent.browsers.get(family)`：按明确浏览器族选择；
- `getForUrl(url)`：用户未指定浏览器时让 runtime 选择适合目标 URL 的 backend；
- `getDefault()`：无浏览器、无 URL 时选择默认；
- Browser binding 可跨轮次复用，Tab binding 失效时只重新取得 Tab；只有 browser-disconnected 才使 Browser binding 失效。

## 动态文档与能力协商

- 每个 Browser 提供 `documentation()`；Skill 要求首次选择 backend 后读取完整文档。
- Browser/Tab capability collection 通过 `list()`、`get(id)` 和 capability 自身的 `documentation()` 协商可用能力。
- 同名高层 API和不同 backend 的能力并不保证相同支持度，`api.json` 中可见 `unsupportedByDefaultIn` 元数据。

## CDP capability

`docs/capabilities/tab/cdp.md` 暴露：

- `send(method, params, {target, timeoutMs})`；
- `readEvents({afterSequence, limit, methods, target, timeoutMs})`；
- 事件具有单调 `sequence` 和返回 `cursor`；分页携带 `hasMore`，buffer 丢失由 `truncated` 显式表达；
- child target 通过 attach 事件发现，命令可绑定 sessionId 或 targetId；
- raw CDP 按当前 Tab origin 收窄，并要求优先使用高层 API。

这个 cursor/event-window 模型值得用于 AB 的 CDP 事件与其他长期资源；具体 transport 使用 AB 自己的 Unix socket protocol，不复制 Codex 的不可见协议。

## Tab ownership

- Agent 新建 Tab 默认临时；
- claim 用户已有 Tab 后，结束时 release 而不是关闭；
- `markDeliverable()` 表示留给用户的最终产物；
- `markHandoff()` 表示跨轮次继续工作；
- claim 通过 providerTabId/title/url 等已接受状态校验，页面已经变化时 fail closed。

AB 使用自己的专用 Chrome，不采用 claim 用户 tab 的 owned/borrowed 产品模型；可以借鉴的是 tab/resource 归属和 stale 校验，不复制 Codex 的宿主实现。
