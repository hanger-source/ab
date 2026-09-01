# Agent Tab 动作后身份一致性

## 结论

AB 的 Rust Pointer Action 与 ActionTransaction 在公开 GitHub SPA 上能够稳定把可信输入发送到真实链接，并在 `ActionResult.navigation` 中返回最终 URL。缺口位于 Agent facade：同一个动作是否请求或展示 observation，曾经会决定同一个 `Tab` 的缓存 URL 是否更新。

本轮只收敛这一条不变量：Agent 管理的 action 返回前，同一个 Agent `Tab` 的 `url` 必须与该 action 的 `navigation.afterUrl` 一致，且不能依赖 `write: "diff" | "state" | "none"` 的选择。

## 同流程对照

公开流程使用 GitHub `microsoft/playwright` Issues：

1. 打开筛选后的 Issues 列表；
2. 唯一定位 issue `#42487` 的链接；
3. 从冷页面点击同一链接；
4. 记录页面实际收到的 pointer/mouse/click 事件、最终 URL 和 SDK 可见 URL。

### Codex Browser

六个全新 in-app Browser tab 中：

- 五次进入 `/microsoft/playwright/issues/42487`；
- 一次停留在列表页；
- 失败那次的完整 `pointerdown → mousedown → pointerup → mouseup → click` 均为 `isTrusted=false`；
- 失败事件目标是普通 `DIV`，`closest("a")` 为空，页面没有取消默认行为。

这个结果说明 Codex Browser 的当前 in-app Locator click 也会出现冷页面命中差异，不能把它的单次成功当作 AB 应复制的底层实现。

### AB `0.3.0-alpha.2+ee830113781e06bf`

六个全新 AB Chrome tab 中：

- 六次都进入 `/microsoft/playwright/issues/42487`；
- 六次事件全部为 `isTrusted=true`；
- 六次 target 都是链接内的 `SPAN`，`closest("a")` 都是 `/microsoft/playwright/issues/42487`；
- 六次 `ActionResult.navigation.changed` 都为 `true`，`afterUrl` 都是目标 URL；
- 六次原 Agent `tab.url` 在 action 返回时仍是列表 URL；
- 六次显式 `await tab.refresh()` 后都立即变成目标 URL。

因此 Pointer Action、hit target 和 Rust ActionTransaction 不是本轮应修改的 owner。确定性缺口是 TS Agent Tab metadata 的本地同步。

## 为什么此前没有发现

Git 历史显示这不是 `ff27b2d` Pointer Action 批次引入的回归：

- `0a36ab3` 导入独立仓库时，Core `Tab` 就以 `#url` 保存创建或最后一次 `refresh()` 的快照；
- `d7171a5` 拆分 Agent API 时，新 Agent `Tab` 继续直接读取这个 Core 缓存；
- 后续 ActionTransaction 已经返回最终 `navigation.afterUrl`，但 Agent action wrapper 没有把它交给 Core Tab；
- Agent Presenter 为输出可信 origin 会调用 `#currentOrigin()`，而它内部执行 `tab.refresh()`；
- 现有 `skill-client` 的导航断言使用默认 `write: "diff"`，因此 Presenter 的隐式 refresh 让测试变绿；`write: "none"` 跳过 Presenter，才暴露真实合同差异。

也就是说，presentation 意外承担了 metadata 同步责任。动作事实、页面身份和模型输出三个 owner 被隐藏耦合，导致测试覆盖了结果，却没有覆盖所有公开选项下的不变量。

## 成熟实现参照

Playwright 的 `Page.url()` 读取主 Frame；Frame 在 `navigated` channel event 中更新 `_url`，服务端对 same-document navigation 也先更新 Frame `_url` 再发出导航事件：

- [Playwright client Frame](https://github.com/microsoft/playwright/blob/main/packages/playwright-core/src/client/frame.ts)
- [Playwright server FrameManager](https://github.com/microsoft/playwright/blob/main/packages/playwright-core/src/server/frames.ts)
- [Playwright client Page](https://github.com/microsoft/playwright/blob/main/packages/playwright-core/src/client/page.ts)

本地 Puppeteer `5ecc694` 采用同一事实模型：`Page.url()` 读取 main Frame；CDP Frame 在 `_navigated()` 与 `_navigatedWithinDocument()` 中更新缓存。

AB 当前没有 Playwright/Puppeteer 那种完整 client-side target event channel。为一个已由 ActionResult 完整携带的事实新增第二套推送协议，会扩大 owner 和生命周期；本轮不这样做。

## Owner 与实现选择

Rust Browser Runtime 继续是导航事实 owner。它已经在 ActionTransaction 结束时返回：

```text
navigation.beforeUrl
navigation.afterUrl
navigation.changed
```

TS Core `Tab` 新增仅供包内部使用的 ActionResult 应用入口。Agent `AX` 作为同一个 Tab 上所有 Agent action surface 的组合点，在以下路径的 action promise 返回前应用该结果：

- AX short-ref action；
- Playwright-style Locator action；
- composite suggestion selection；
- CUA action。

同步直接采用本次 server-owned `afterUrl`，不再发一次 `tabs.get`：

- 不重复消费 action deadline；
- 不把已经发生的 mutation 变成 post-action refresh timeout；
- 不引入另一个 URL 竞争源；
- 不依赖 Presenter 或 observation 是否存在。

Core SDK 对浏览器外部发生、没有经过本 client action 的导航仍保留显式 `tab.refresh()`；本轮不伪造一个尚不存在的全局事件订阅。

## 明确拒绝

- 不修改 Rust pointer gate、content quad、hit test 或事件序列；
- 不增加 GitHub URL、issue 文案、坐标或 selector 特例；
- 不把 Codex Browser 的未受信任 DOM 事件实现移入 AB；
- 不让 `write: "none"` 偷偷请求 observation 或调用 Presenter；
- 不为同步 metadata 追加一次 RPC 或固定等待；
- 不新增 fallback、自动 DOM click 或动作重放；
- 不把外部页面自行导航后的缓存刷新描述成已经自动解决。

## 验证

长期行为落在现有真实 `skill-client` 页面中：同一个 semantic Locator 触发 same-document navigation，使用 `write: "none"`，并同时断言：

- `ActionResult.navigation.afterUrl` 是目标；
- 同一个 `taskTab.url` 在 promise 返回时已经是目标；
- observation 没有被请求；
- Presenter 没有新增输出。

默认 `write: "diff"` 的原导航断言继续保留，证明 presentation 与 silent action 共享同一 metadata 合同。

本轮实际结果：

- SDK TypeScript typecheck 通过；
- 正式 `build:sdk` 与 `package:skill` 通过；
- `skill-client` 独立运行通过；
- `observation-actions`、`locator-semantics`、`scenario-async-spa-navigation` 独立运行通过；
- 重新加载生成 Skill 后，公开 GitHub 流程在 `write: "none"` 下约 0.8 秒返回，同一个 `tab.url` 无需 `refresh()` 即与 `navigation.afterUrl` 一致，observation 仍为 `notRequested`；
- 默认真实 Chrome suite 19/19 通过；
- 包内部 `applyActionResult` 经 `stripInternal` 没有进入 Core 或 Agent `.d.ts`。
