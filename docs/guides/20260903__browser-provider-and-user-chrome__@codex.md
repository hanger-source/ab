# AB Browser Provider 与用户 Chrome

AB 对 Agent 暴露一套浏览器能力，但浏览器实例有两种明确来源：

- `managed`：AB 启动或重连自己的 Chrome 和固定持久化 profile；
- `external`：AB 连接调用者明确给出的 Chrome DevTools WebSocket endpoint，不启动 Chrome，也不接管 profile。

两种来源只改变浏览器连接、target 发现、attach 和 release 的生命周期。Agent 选定 tab 之后使用的 `Tab`、AX、Locator、CUA、Resource、CDP、action transaction 和 target lease 是同一套能力，不按来源分叉。

## 连接接口

managed 是默认 provider：

```ts
const browser = await connect();
```

连接已经由 Chrome 开启远程调试的用户浏览器时，调用者必须显式给出 browser-level WebSocket endpoint：

```ts
const browser = await connect({
  provider: {
    kind: "external",
    webSocketUrl: "ws://127.0.0.1:9222/devtools/browser/<browser-id>",
  },
});
```

`webSocketUrl` 只接受 `ws://` 或 `wss://`。AB 不从错误 endpoint 猜测另一个 Chrome，不退回 managed provider，也不复制用户 profile。一个 JavaScript 进程在断开前只能使用一个 provider；以另一个 provider 再次调用 `connect()` 会明确失败。

macOS Chrome 通过 `--remote-debugging-port` 启动后，`<user-data-dir>/DevToolsActivePort` 的第一行是端口，第二行是 browser WebSocket path。调用者应组合这两个已知值，不能假设 `/json/version` 一定可用。

## 能力边界

```text
connect(provider)
  -> provider 对应的 runtime socket
  -> Chrome connection
  -> BrowserProvider
       managed: discover + browser-level page auto-attach
       external: discover only
  -> BrowserOwner: target lease / action lane / input surface
  -> BrowserCore
  -> Core SDK / Agent facade
```

`BrowserProvider` 是来源差异的唯一生产边界：

- 枚举可选 page target；
- 领取指定 target 并返回 ready `TargetSession`；
- 创建 target；
- 客户端释放 lease 时执行对应的 release。

`SessionManager` 只保存已经 attach 且完成 Page/Runtime/Network 初始化的 `TargetSession`。外部 Chrome 中尚未领取的 tab 不伪装成 session，也不会进入 frame、realm、dialog、resource 或 action 状态；它只以一次 `tabs.list()` 的 provider 列举结果出现。

## Managed provider

Managed provider 保持 AB 原有语义：

- profile 位于 AB application data 下；
- Chrome 可由 runtime 启动，也可按 profile 的 `DevToolsActivePort` 重连；
- browser-level `Target.setAutoAttach` 继续负责全部普通 page/webview；
- 没有 page 时创建一个 `about:blank`；
- client 断开只释放 target lease，不 detach managed session；
- daemon 更换后仍由 managed profile 和 browser generation 校验同一浏览器身份。

External provider 不修改这些规则，也不共用 managed runtime socket。

## External provider

External provider 在 browser-level CDP connection 建立后只启用 target discovery。`tabs.list()` 和 `tabs.get()` 读取 target 信息，不 attach 页面。只有下面两种 page 会进入 `SessionManager`：

1. Agent 对准确的 `targetId` 调用 `tabs.acquire()`；
2. 已领取页面产生带有该页面 `openerId` 的新 popup。

领取时，provider 对准确 target 执行 `Target.attachToTarget`。session 初始化完成后，返回的仍是标准 `Tab`，后续 AX、Locator、CUA、Resource 和 CDP 不知道也不需要知道它来自 external Chrome。

External provider 不在 browser level 设置全局 auto-attach。已领取 root target 内部仍使用 target-scoped iframe auto-attach，以维持 OOPIF frame/realm/resource 能力。popup 只根据已 attach opener 的明确关系进入同一控制链，不扫描后自动领取无关 tab。

client 断开时，Rust 先释放该 client 的 resources 和 target leases，再 detach 它领取的 external root sessions。AB 不关闭这些用户 tab，也不关闭用户 Chrome。Agent 显式调用 `tab.close()` 仍表示明确关闭该 tab，和 disconnect 不同。

## Runtime 身份与隔离

Managed provider 沿用当前用户的固定 runtime socket。External provider 根据 WebSocket endpoint 的 origin 派生独立 runtime 目录；同一远程调试端口复用同一个 external daemon 槽，不与 managed daemon 争抢 socket、handover 或 Chrome connection。

Browser WebSocket path 仍作为 runtime 启动参数传给 external provider。Chrome 重启导致 path 改变后，旧 CDP connection 断开，下一次连接在相同 origin 的 external runtime 槽中使用新 endpoint。协议握手通过 `chrome.source: "external"` 明确呈现来源；external Chrome 没有 AB-owned pid，因此 `chrome.pid` 为 `null`。

## Agent 使用方式

Agent 必须先决定使用哪个 browser provider，再建立一个持续的 Node REPL 会话。连接用户 Chrome 的典型入口是：

```ts
const { connect } = await import("<ab-skill-root>/scripts/ab-client.mjs");
const browser = await connect({
  provider: { kind: "external", webSocketUrl },
});
let tabs = await browser.tabs.list();
nodeRepl.write(tabs);
```

选择 tab 的规则与 managed provider 相同：

```ts
const candidate = tabs.find(tab => tab.url.startsWith("https://example.com/"));
if (!candidate) throw new Error("required user tab is not open");
const tab = await browser.tabs.acquire(candidate.id);
```

Agent 不应因为 external Chrome 已登录就操作任意页面。它仍需根据用户任务选择准确 tab，尊重 `ownership: "other"`，在可见 mutation 前说明动作，并且只在用户明确要求时关闭既有 tab、退出账号或更改账户状态。

## 失败语义

- endpoint 非 WebSocket URL：连接前返回配置错误；
- endpoint 无法连接：runtime startup 返回原始 CDP connection failure；
- target 在领取前消失或不是可控制 page：`target_not_found`；
- target 被另一 client 领取：`target_in_use`；
- 未领取 target 上执行 mutation：`target_not_acquired`；
- 外部 session detach：该 session 的 frame、realm、dialog、resource 和 action 状态失效，用户 tab 本身保持打开；
- provider 不匹配：当前 JavaScript connection 不被静默复用，也不自动切换或 fallback。

## 实现位置

```text
sdk/ts/src/options.ts
  public BrowserProvider / ConnectOptions

sdk/ts/src/runtime/provider.ts
  provider 校验、进程内连接身份、external runtime key

sdk/ts/src/runtime/{paths,native}.ts
  provider 对应的 socket 和 runtime 启动环境

server/rust/ab-runtime/src/config.rs
  runtime 入口的 BrowserProviderConfig

server/rust/ab-runtime/src/chrome/mod.rs
  managed Chrome ownership 或 external endpoint connection identity

server/rust/ab-runtime/src/browser/provider.rs
  discover / acquire / open / release 的来源语义

server/rust/ab-runtime/src/browser/session_manager.rs
  已 attach TargetSession 的统一初始化与生命周期

server/rust/ab-runtime/src/browser/owner.rs
  与 provider 无关的 client target lease 和 mutation ownership
```

## 验收事实

- managed 回归：默认 `connect()` 继续复用原 socket、原 profile 和原全局 page attach 行为；
- 无侵入发现：external `tabs.list()` 能看到用户 tab，日志中没有因此产生 page attach；
- 精确领取：`tabs.acquire(targetId)` 后只有目标 root 及其 OOPIF 进入 session registry；
- popup 连续性：已领取 opener 创建的 popup 被发布并继承 opener lease，无关新 tab 不被领取；
- 释放而非关闭：external client disconnect 后目标 session 已 detach，用户 tab 和 Chrome 仍存在；
- 链路统一：领取后的 external tab 通过现有 AX/Locator/Resource/CDP 操作，不出现 provider 参数或来源分支；
- 隔离：managed daemon 与 external daemon 同时存在，socket、连接身份和 handover 互不替代。
