# WebDriver And UI Runtime

本档案比较 WebDriver/BiDi 客户端与浏览器内 UI runtime。关注命令生命周期、目标身份、动作完成条件和失败证据，不把测试 DSL 或框架生态等同于 AB 能力。

## Selenium BiDi

Selenium 的 `BrowsingContext` 是围绕显式 context id 的薄对象。navigate、reload、activate、close、locateNodes、screenshot、history 和 viewport 命令都携带同一个 context id；navigate 还把 readiness 与单次 timeout 一起下传。

这与“先找当前 tab 再执行”的动态路由不同：对象一旦建立，后续调用的作用域不再重新推断。对 AB 的直接参照是让 `Tab` 成为稳定 identity carrier，并让命令证据包含 client、browser generation、tab/session/frame，而不是增加更聪明的目标猜测。

BiDi event subscription 现在直接以远程端返回的 subscription id 为唯一身份。无论订阅按 events、browsing contexts 还是 user contexts 限定，unsubscribe 都使用这个 id；本地 handler 也按同一个 id 注册和清理。新 `SubscriptionScope` 只表达作用域，不复制完整 subscribe 参数。这样可以精确撤销一份长期资源，而不是根据 event name 猜它当初怎样订阅。

源码入口：`java/src/org/openqa/selenium/bidi/browsingcontext/BrowsingContext.java`、`java/src/org/openqa/selenium/bidi/BiDi.java`、`SubscriptionScope.java`。

## WebdriverIO

定位：在 WebDriver Classic/BiDi 协议之上提供 JavaScript command runtime、element API、hooks 和多实例编排。

已确认机制：

- 每个协议 command 在发出前完成参数数量、类型和 URL/body 映射校验；随后发出 `command`、`request.start`、`request.retry`、`request.end`、`result` 等事件；
- command logging 与真实 payload 分离，支持字段 mask；截图、录屏、长脚本结果只压缩日志表示，不改变真实返回值；
- 每个 session 维护 AbortController 集合。`deleteSession` 完成时主动中止该 session 的在途请求，session 删除后再发命令会在客户端硬失败；
- BiDi transport 使用递增 id 和 pending map 关联响应，单命令有明确 timeout；未建立 BiDi session 时调用 BiDi command 会直接解释配置条件；
- `waitUntil` 接收调用者自己的条件，timeout/interval 均为毫秒；session 删除会中止 wait，不继续等待不存在的目标；
- BiDi network interception 将 request、responseStarted、responseCompleted 和可选 body collector 分开；`waitForResponse` 只有在匹配 response 已进入 calls，且启用 body collection 时 body collector 也完成后才返回；
- ShadowRootManager 的 scope 不是 tracked host 时，会在页面内批量验证候选 host 是否真被 scope 包含，避免把同一 document 中无关 shadow root 泄漏进局部查询；批量结果长度不符会被识别为 transport/driver 异常；
- element middleware 会隐式等待未出现元素，并在 stale element 时按原 selector/refetch 链重找后重试。click 被遮挡时会滚动到中心再重试。

源码入口：`packages/webdriver/src/command.ts`、`packages/webdriver/src/bidi/core.ts`、`packages/webdriverio/src/middlewares.ts`、`packages/webdriverio/src/commands/browser/waitUntil.ts`、`packages/webdriverio/src/commands/element/click.ts`。

对 AB 的启发边界：command 事件、真实返回与日志投影分离、session 结束主动 abort 都是强机制。隐式 stale refetch 和 click 自动重试会改变动作归因，违反 AB 当前“失败要可解释、不隐藏目标重选”的方向，只作为风险样本，不作为待移植特性。

## TestCafe

定位：通过页面注入/proxy 与浏览器端 automation runtime 执行动作，并在动作后等待相关页面活动收敛。

已确认机制：

- 动作执行前同时建立 request、script execution 和 page unload 三类 barrier；动作完成后先等已观察请求，再等这些请求触发的脚本，且并行等待可能的导航；
- RequestBarrier 只收集动作窗口内开始的请求；完成请求后保留很短的追加收集窗口，以捕获响应 handler 继续触发的请求；整体有硬 watchdog，不把等待变成无限 network-idle；
- 可见元素动作不是一个 `element.click()`：先计算动作点、滚动、检查该点实际命中的元素、移动指针，再复核目标是否移动或被覆盖；失败区分 invisible 与 not-target；
- browser connection 有明确 status/idle/heartbeat 状态。heartbeat 超时标记 disconnected 和 test aborted，再进入受 timeout 约束的 restart 流程；远程连接队列按 ready event 和 redirect timeout 串行交接。

源码入口：`src/client/driver/utils/run-with-barriers.js`、`src/client/driver/barriers/request.ts`、`src/client/driver/barriers/complex-barrier.ts`、`src/client/automation/visible-element-automation.ts`、`src/browser/connection/index.ts`、`src/browser/connection/remotes-queue.ts`。

对 AB 的启发边界：它最重要的不是 selector API，而是把“动作已发出”和“动作造成的页面活动已收敛”分成两个 Promise，并保留具体 barrier 来源。TestCafe 的页面注入/proxy 架构与 AB 的外部 CDP runtime 不同，不能直接采用其全局动作完成定义；后续实验只能验证哪些可观测信号可作为组合原语，不能先造一个宣称万能的 `actionComplete`。

## Cypress

定位：运行在被测页面附近的命令队列与 UI actionability runtime。它不是通用远程浏览器驱动；其价值在于动作发生前后的状态检查、重试边界和命令证据组织。

已确认机制：

- actionability 把 attached、disabled、scroll、strict visibility、readonly、animation、covered 和 hidden-by-ancestor 分成顺序明确的检查；只有全部通过后才在同一同步窗口触发动作，避免检查结束与事件派发之间再次跨越异步边界；
- scrollIntoView 的 block 与 inline 轴使用同一显式策略，横向不可见不再被纵向滚动的成功掩盖；
- `force: true` 是调用者显式要求跳过大部分 actionability 检查，不是 runtime 在失败后秘密改用另一种点击语义；
- 动画判断保存多次坐标，遮挡判断使用动作坐标处的实际命中元素。检查失败进入同一 actionability retry，不会换一个相似元素继续；
- query 必须返回同步、幂等函数，由 command queue 负责反复执行并验证后续断言；action command 只执行一次。查询重试和动作重放因此是两个不同的语义；
- command queue 记录 queued、pending、passed、failed/skipped 等生命周期，发出 `cy:command:start`、`cy:command:end`、`cy:command:failed` 事件，并在失败时清理 intermediate/nested 状态；
- command log 可以持有动作快照。快照克隆 body、分离样式、移除 script/stylesheet/style，并把 iframe 替换为静态 placeholder，明确避免恢复快照时重新执行页面副作用。
- 即使复用同一个 tab，spec 边界仍会重置 pre-request correlation queue、response buffer、service worker manager、remote state 与 credentials；页面资源生命周期和观测器状态生命周期没有被绑成一个开关。

源码入口：`packages/driver/src/cy/actionability.ts`、`packages/driver/src/cypress/command_queue.ts`、`packages/driver/src/cy/snapshots.ts`。

对 AB 的启发边界：分阶段 actionability 证据、query/action 语义隔离、命令状态事件和无副作用快照都值得进入比较矩阵。Cypress 依赖其 runner 对页面和命令队列的整体控制，不能证明同一判断在 AB 的持久外部 Chrome、后台 tab 与直接 CDP 中成立。尤其不能把它的完整 actionability runtime 直接搬成一个看似权威的高层点击函数。

## 当前差异

| Dimension | Selenium/WebdriverIO | TestCafe | Cypress | AB current direction |
|---|---|---|---|---|
| Target identity | session/context/element object | injected driver/window/element | command subject chain | explicit tabId plus CDP session/frame evidence |
| Command lifecycle | protocol request/result events | action promise plus barriers | queue state plus command events | SDK request/result、daemon stage trace 与 resource event |
| Wait ownership | caller condition or protocol readiness | runtime-defined request/script/unload barriers | idempotent query retry and staged actionability | caller-composed page condition and explicit observation tools |
| Stale target | WebdriverIO may silently refetch | selector is re-evaluated by runtime | actionability re-queries the same subject chain and reports detach | should expose stale/target mismatch, not silently retarget |
| Forced action | framework-specific | low-level automation path | explicit `force` skips named checks | must remain explicit and preserve changed semantics |
| Disconnect | session abort, BiDi timeout | heartbeat, restart state | runner-owned cancellation and cleanup | 只释放当前 client 资源；daemon、Chrome 与 tab 保持常驻 |
| Evidence | command/result events | barrier sources and action errors | command log plus inert DOM snapshot | artifact/output file plus target/session/stage evidence |

这批源码尚未导出产品决策。后续只把矩阵中的具体差异转成可证伪实验问题。

## Appium

定位：WebDriver 协议入口与可安装 driver/plugin 容器。这里研究的是 session 和命令扩展机制，不研究移动端业务能力。

已确认机制：

- umbrella driver 先验证 capabilities，再选择 inner driver。inner driver 创建成功后才写入 `sessionId -> driver`；创建中的 driver 单独放在 pending registry，避免半成品 session 被路由；
- session 命令先从参数取 sessionId，再查具体 inner driver。status、umbrella command 和 session driver command 是三条明确路径，不从当前设备或窗口推断；
- plugin 按命令构成显式 middleware chain。插件必须调用 `next()` 才会进入下一个插件或默认 driver；runtime 记录 default 与每个 plugin 是否实际处理该命令；
- BaseDriver 的每个 session 默认用 AsyncLock 串行命令，日志会报告排队长度。正在执行的命令与 unexpected shutdown event 做 `Promise.race`，session 异常关闭会直接打断 command；
- `newCommandTimeout` 是命令间 idle timeout，不是单命令执行 timeout。插件绕过默认 driver 时，umbrella driver 负责重启该 idle timer，避免扩展链破坏 session 生命周期。

源码入口：`packages/appium/lib/appium.ts`、`packages/base-driver/lib/basedriver/driver.ts`。

与 AB 的关系：稳定 session route、创建成功后注册、per-session queue、middleware handled-by 证据是可比较机制。Appium 的 driver/plugin 容器不能证明 AB 需要恢复 App runtime；它处理的是协议执行层扩展，不是把业务应用打包进浏览器工具。
