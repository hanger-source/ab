# AB Observation / Presentation Identity 收敛计划

这份计划收敛 `@hanger-source/ab/agent` 中模型所见页面、短 ref 基线和 JavaScript 返回值之间的 identity。目标不是增加另一套 observation 抽象，而是让一次已经发生的采集与展示只产生一个可见事实：Presenter 展示的 observation、短 ref 使用的 observation、调用者拿到的 typed object 必须是同一个 server observation。

本计划只调整 Agent facade、对应 Skill 与文档。Rust Runtime、协议、Core `AXState` / `PageObservation`、snapshot/ref/action 算法和官方 evaluator 不改变；不加入页面特例、自动 DOM/CDP fallback 或任务答案。

## 一、完成后的调用语义

未知页面的标准入口同时返回已经展示的 typed state：

```ts
const state = await tab.ax.write("state");

// 模型看到的文本来自 state.id；短 ref 也绑定 state.id。
await tab.ax.click("e12", { write: "diff" });
```

需要程序化读取但不向模型展示时，继续使用 `get()`：

```ts
const state = await tab.ax.get("state");
try {
  const submit = state.refs().find(ref => ref.name === "Submit");
  await submit?.click({ observe: "diff" });
} finally {
  await state.dispose();
}
```

两条路径不能偷偷互相改变：

- `write()` 采集、展示、推进短 ref baseline，并返回同一个 typed object；
- `get()` 只采集并返回 caller-owned typed object，不展示、不推进短 ref baseline；
- 不允许在 `write()` 后再调用一次 `get()` 来“取得刚才那份状态”，因为那必然是另一个 observation；
- 不增加隐式 latest observation、数字 index、全局 ref 或按文本猜测替代节点。

`write()` 的返回类型与内容一致：

```ts
tab.ax.write("state", options?): Promise<AXState>
tab.ax.write("screenshot", options?): Promise<Screenshot>
tab.ax.write("both", options?): Promise<{ state: AXState; screenshot: Screenshot }>
tab.ax.write(state): Promise<AXState>
```

`write("both")` 仍由一次 Core `tab.observe({ ax, screenshot })` transaction 产生；返回的 state 和 screenshot 与 Presenter 输出属于同一 document/viewport identity。

## 二、Identity 与生命周期

这里不创建 `PresentationReceipt`、`PresentedState`、`ObservationSession` 或第二套 ref 类型。`AXState` 已经拥有 observation id、document generation、revision、refs、diff、complete/truncated 和 dispose 生命周期，足以表达这份事实。

Agent facade 只增加一条所有权规则：

- `get()` 返回的 state 由调用者持有，直到显式 `dispose()`、`ax.dispose()` 或 client disconnect；
- `write()` 返回的 state 是当前 presentation baseline；下一次成功展示 state 时，旧 baseline 自动释放；
- action 以 `write: "diff" | "state"` 返回的 `ActionResult.observation` 与其刚展示并采用的 baseline 是同一个对象，保持既有行为；
- 调用者可以读取 `write()` 返回的 state，但若主动 dispose，它也会使当前短 ref baseline 失效；
- presentation 失败不能推进 baseline，也不能留下一个调用者永远拿不到的 observation；
- screenshot artifact 保持现有显式 handle 语义：返回后可用于读取/查看/CUA，调用者用完 dispose，client disconnect 是最终清理边界。

因此 `liveObservations` 仍只表示 Agent tab 当前保留的 AX observations；不把 screenshot artifact 混成另一种 observation 计数，也不新增镜像资源状态。

## 三、动作后的同一事实

Agent mutation 已经在一个 action transaction 中得到 post-action observation。本计划保留并明确这一点：

```ts
const result = await tab.ax.click("e12", { write: "diff" });

// result.observation.id === Presenter 刚展示的 observation id
// 同时也是下一次短 ref action 使用的 baseline id
```

Locator 与 CUA 也遵循同一关系。禁止为了返回 typed state 再做一次 snapshot；禁止将 action 的 diff 展示后又以 full state 替换 baseline；`write: "none"` 仍表示不请求、不展示、不推进 observation。

动作方法继续返回完整 `ActionResult`，不把它改成 `AXState`，因为 dispatch、settle、target、popup、field settled value 与 observation outcome 都是独立且真实的动作结果。调用者需要 post-action state 时读取 `result.observation`，不增加另一层 action wrapper。

## 四、直接改动路径

```text
sdk/ts/src/agent/ax.ts
├── means: Agent presentation 与 short-ref identity 的唯一 owner
├── main path: get/write/action result -> Presenter -> baseline replacement
├── change: write overload 返回被展示和采用的原对象；失败时释放未交付对象
└── verify: returned id、Presenter id、action baseline id 三者一致

sdk/ts/src/agent/playwright.ts + cua.ts
├── means: 复用 AX owner 的 mutation 表面
├── main path: Core ActionResult.observation -> AX presentation/adoption -> caller
├── change: 不另抓 snapshot；保持 ActionResult 中同一 observation object
└── verify: default diff、state、none 的请求与展示次数不变

skills/ab/SKILL.md + references
├── means: 陌生 Agent 实际选择 write/get 的操作纪律
├── change: write-first 示例保存返回 state；get 只用于非展示读取并显式释放
└── verify: Skill 不再诱导 write 后 get、用截断 get 寻找短 ref 或累积 observation

sdk/ts/docs + README + packaged Skill runtime
├── means: npm 类型、公开说明与安装产物
├── change: 同步 overload、identity 与生命周期，不保留 Promise<void> 的旧合同
└── verify: source、dist、Skill runtime .d.ts 和文档表达同一 API
```

## 五、实施批次

### 批次一：完成 SDK identity 链

同一批完成所有 `write` overload、state/both/screenshot 成功返回、presentation 失败清理，以及 AX/ref、Locator、CUA action 对同一 observation object 的保持。这里不改 Rust/protocol，也不新增 compatibility overload。

完成生产代码后先运行 TypeScript typecheck 与 SDK build，修完所有真实调用方再进入文档和运行验证。

### 批次二：共同迁移 Skill、文档与安装产物

主 Skill、observation/api/lifecycle/screenshot/action topic、SDK docs、README 和生成产物一起切换。示例以 `const state = await tab.ax.write("state")` 表达“所见即所得的 identity”，但短 ref 流程仍可直接忽略返回值；不要求 Agent 为每次普通 `write` 人工 dispose 当前 baseline。

### 批次三：真实行为验证

扩展已有 `skill-client` live case，而不是为类型映射另造 fixture。它必须在真实 Rust daemon 与 Chrome 中证明：

- `write("state")` 返回的 id 等于 Presenter observation id；
- 同一 state 的短 ref action 成功，且 action result observation 等于下一次 Presenter/baseline；
- 下一次成功 state presentation 后，旧 baseline 的 handle 已释放；
- `get()` 不改变 presented baseline，caller-owned states 可显式和批量释放；
- `write:"none"` 不产生 observation；
- presentation 失败保留旧 baseline并释放未交付的新 state。

随后运行现有真实 Chrome suite。官方六题不因这一小批机械重跑两套 Agent 会话；只有 source/Skill 行为验证出现能力变化，或下一批本来就要运行正式评测时，才用原任务与官方 evaluator 做对照，避免把时间消耗在没有新判别力的重复运行上。

## 六、完成判定

| 主张 | 能反驳它的证据 |
|---|---|
| 模型所见、短 ref 和返回值是同一 state | `write("state")` 的返回 id、Presenter id 或下一次 action baseline id 任一不同 |
| 动作没有重复采集 | 一次 `write:"diff"` mutation 产生额外 snapshot，或 Presenter state 不是 `ActionResult.observation` |
| get/write 责任清楚 | `get()` 推进短 ref baseline，或 Skill 仍要求 write 后 get 才能获得 identity |
| 生命周期不再制造不可达资源 | presentation 失败后 live observation 增加，或替换 baseline 后旧 state 仍存活 |
| Core/Runtime 没被 facade 绑架 | protocol/Rust 为返回值变化新增消息、状态或 fallback |
| 复杂能力没有被页面特例污染 | SDK/Skill 出现站点、任务 id、字段答案或 evaluator-specific 分支 |

## 七、不在本计划中处理

- 删除 action 的 `write` 并强制每次 action 后显式 `ax.write()`；
- 隐藏 Core `AXState.ref()` 或 ElementHandle；
- 自动选择 Locator/CUA/DOM/CDP fallback；
- 增加 `waitForLoadState`、`expectNavigation` 等页面语义；
- 改写 Rust observation engine、ref 编号、active surface 或 action settle；
- 用更高 observation 上限掩盖未释放对象；
- 创建页面、站点或 benchmark task 专用 helper。

这批结束后，`write/get/action` 的 identity 才成为稳定基底；后续 API 判断必须建立在这条单一事实链上，而不是再次用文档纪律弥补对象关系的不对称。
