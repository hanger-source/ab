# Network Observation Implementations

网络观测不是单一能力。页面 `fetch`/XHR hook、CDP Network、WebDriver BiDi、浏览器外部代理看到的是不同层次的事实。本档案只比较观测作用域、flow identity、生命周期和完整性，不把任何一个来源称为完整页面接口清单。

## mitmproxy

定位：浏览器外部的 TLS-capable HTTP proxy。它不依赖页面 JavaScript、扩展或 CDP，通过 client/server connection 与 protocol layer 观察 HTTP、WebSocket、TCP、UDP 和 DNS flow。

已确认机制：

- `Flow` 有稳定 UUID，并分别保存 client connection、server connection、live/intercepted/error、创建时间和 metadata。HTTP 500 是正常 `Response`，连接中断、timeout 和 protocol failure 才是 `Flow.Error`；
- `HTTPFlow` 把 request、response、error 与可选 WebSocket data 放在同一 flow 上。事件区分 request headers、完整 request body、response headers、完整 response body 和 error；每个 HTTP flow 最终是 response 或 error，不把“没有响应对象”直接解释成业务空结果；
- streaming 会改变事件顺序：上传过程中 server 可能先回 413，因此 response event 可以早于完整 request event。观测消费者不能把固定 `request -> response` 顺序当成协议事实；
- protocol `Layer` 用 generator 表达阻塞 command。command completion 通过同一 command object identity 恢复；暂停期间到达的其他 event 会排队并按序重放。阻塞只属于当前 layer/stream，例如拦截一个 HTTP/2 request 不会冻结整条 multiplexed connection；
- addon hooks 按 chain 顺序执行，同步和异步 handler 都在同一 lifecycle event 上完成后再进入下一 addon。flow 被修改后另发 update hook，原始 protocol event 与 UI/data 更新不是一个隐式 side effect；
- WebSocket 先按 RFC frame 组装 semantic message，再记录方向、时间、text/binary、dropped/injected。close 另行记录发起端、code、reason 与结束时间；fragment 不是 message identity；
- native flow artifact 序列化完整 flow state。stream save 在 response/error/WebSocket end 才保存完整 flow，shutdown 时把仍 active 的 flow 也落盘；writer 每写一个 flow 就 flush，使下游可以增量消费。HAR 是派生格式，不替代 native flow state；
- filter 直接作用于 typed flow facts，可按 protocol、request-without-response、response、error、method、URL、header、body、source/destination 等组合，而不是先把大 JSON 全部输出再做字符串 grep；
- 近期 12.2.x 修复包括 HAR binary/content cutoff、HTTP scheme、failed CONNECT 可见性和 Chromium 证书有效期约束，说明外部 proxy 也持续受浏览器 TLS policy 与 artifact encoding 边界影响。

源码入口：

- `mitmproxy/flow.py`
- `mitmproxy/http.py`
- `mitmproxy/websocket.py`
- `mitmproxy/eventsequence.py`
- `mitmproxy/proxy/layer.py`
- `mitmproxy/proxy/layers/http/`
- `mitmproxy/proxy/layers/websocket.py`
- `mitmproxy/addonmanager.py`
- `mitmproxy/addons/save.py`
- `mitmproxy/io/io.py`

对 AB 的边界：mitmproxy 能独立于 page world 看见真实网络协议和 WebSocket message，但它通常不知道某条连接属于哪个 tab、frame、document 或页面动作；service worker、共享连接和 HTTP/2 multiplexing 会进一步削弱页面归因。它适合作为网络 flow 生命周期与 artifact 完整性的参照，不是 CDP tab-scoped capture 或 page hook 的透明替代。

## CDP / WebDriver BiDi / Page Hook 的作用域

- CDP Network 事件携带 target/session 与 request id，适合绑定某个 tab/child target，但 child session 是否全部 attach、response body 是否仍可取得、capture 是否跨 navigation 存活都由 provider 管理；
- WebDriver BiDi 把 network event 与 browsing context、navigation/realm 契约连接起来，跨浏览器语义更明确，但可见字段和 body 获取仍由 remote end 实现；
- page hook 最接近应用自己的 `fetch`/XHR 调用点，可以附加调用栈、页面状态和自定义 action marker；但安装时机、cached function reference、worker/iframe/realm、非 fetch/XHR transport 都可能让它为空；
- external proxy 不受 page hook 安装时机影响，也不需要 debugger session，但缺少 tab/document/action identity，并可能受证书信任、proxy bypass、QUIC 或宿主网络栈影响。

## 当前可确认的设计原则

1. network artifact 必须写明 source 类型，不用统一的 `requests` 数组抹掉 page hook、CDP、BiDi 与 proxy flow 差异。
2. request observed、response headers observed、body complete、connection error、capture stopped 是不同状态。
3. `0 requests` 只描述该 observation scope 内没有事件；没有 source、target/session、start/stop 与 completeness 事实时，它不能支持“页面没有请求”的结论。
4. action attribution 需要显式 action marker、target/document identity 或受控隔离；仅靠时间窗口会把共享连接和并行动作混在一起。
5. 大 body 与长连接应由增量 artifact 通道承载，交互结果只返回索引、计数、完整性与路径，不能裁剪后伪装成完整 flow。
