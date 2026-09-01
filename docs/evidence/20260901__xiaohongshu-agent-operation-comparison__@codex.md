# 小红书 Agent 操作面对比实验

## Identity

- ID: `20260901-xiaohongshu-agent-operation-comparison`
- Status: `adopt`，采纳 active surface identity 与托管 JavaScript Tool；其余发现保持观察或拒绝进入产品
- Capability layer: Agent observation、semantic action、screenshot/CUA、Skill 使用体验
- Repository baseline: `b0e0d4d fix: make agent observations reliable on complex pages`
- Installed AB runtime: `ab 0.2.1`、protocol `3`、build `ab-runtime@0.2.1+c88d9dd4e95d4e03`
- Codex Browser distribution: `openai-bundled/browser/26.825.51511`
- Environment: macOS，两个运行时各自的 headed persistent browser/profile，新建任务 tab

本实验比较 Agent 实际使用体验，不宣称两个 profile、推荐流、风控状态或笔记内容相同。站点内容随时间变化，两边选择各自当时可见的真实非视频多图笔记。

## 场景

两个运行时执行同一用户路径：

1. 打开 `https://www.xiaohongshu.com/explore`；
2. 选择“美食”；
3. 打开一篇真实非视频多图笔记；
4. 从第一张切换到第二张；
5. 关闭笔记详情；
6. 在站内搜索框填写 `AI Agent` 并提交；
7. 到正常登录墙为止，不登录、不绕过风控，不点赞、关注、评论或发布。

操作优先使用可见语义；只有登录弹窗关闭、详情关闭和图片轮播箭头没有稳定语义身份时，才基于当次截图使用坐标。两边都没有使用页面 JavaScript、raw CDP 或站点 API。

## AB 过程

AB 通过正式安装的 Skill client 连接固定 profile Chrome，创建独立任务 tab。

### 实际路径

- 页面刚到 `domcontentloaded` 时，第一次 AX capture 因 capture 前后新增两个 frame，返回 `observation_consistency_error`。等待页面继续稳定后，新 capture 在约 100 ms 完成。该错误证明 transaction 校验有效，但单次现场不足以决定是否内置重试。
- 初始登录弹窗的 AX 只暴露 unnamed clickable generic。第一次按短 ref 点击没有关闭弹窗；截图显示明确关闭图标后，CUA 点击成功。
- “美食”由 AX ref 一次点击成功，动作约 352 ms。
- 第一次选择到视频笔记。AX 在打开后能够显示 `Video`，但 feed observation 本身没有提供足以预先区分图片/视频的身份；关闭后依据截图选择了真实多图笔记“深圳的！！！深圳的！！！😭😭😭”。
- 多图详情完整 state 为 8,845 字符，显示 `1/8`。hover 后截图出现右箭头，CUA 点击约 460 ms，state 变为 8,898 字符并显示 `2/8`。
- 关闭详情后，语义 textbox count 为 1；`fill("AI Agent")` 约 272 ms；按当前 AX ref 点击搜索约 203 ms，进入“登录后查看搜索结果”的正常登录墙。
- 整条任务完成，任务 tab、artifact 和 client 均按所有权清理，daemon 与 Chrome 保持运行。

### Observation 数据

`ActionResult.observation.text` 是动作后的完整 state；真正的增量文本位于 `ActionResult.observation.diff.text`。本实验按后者计量：

| 转换 | diff 字符数 | 判断 |
|---|---:|---|
| 选择美食 | 2,341 | 页面局部换流，仍可读 |
| 打开误选视频 | 12,655 | active surface 从 document 切到详情，patch 膨胀 |
| 关闭视频 | 22,681 | active surface 回到 document，patch 膨胀 |
| 打开多图详情 | 12,360 | active surface 再次切换，patch 膨胀 |
| 关闭详情中的登录弹窗 | 9,363 | active surface 从登录弹窗切回详情，patch 膨胀 |
| 多图 `1/8 -> 2/8` | 626 | 同一 surface 内的有效增量 |
| 关闭多图详情 | 17,004 | active surface 回到 document，patch 膨胀 |
| 填写搜索框 | 19,452 | baseline 仍跨 surface，简单输入产生近乎整页 patch |

这里不是“AB state 本来就大”。同一详情内切图只有 626 字符；只有有效操作面发生替换时，diff 才同时删除旧树、添加新树。当前 `documentGeneration` 没变，因此 Runtime 把不同 active surface 错当成同一 diff scope。

### AB 证据

- 原始临时证据批次：`xiaohongshu-comparison-20260901/ab/`（运行日志不随仓库分发）
- 搜索登录墙：`03-search-login-wall.png`
- SHA-256：`656e1f150c67f59c51da39907bac932342ba2ffad8c3276df957acfa46136577`

第一张与第二张图片已通过宿主图像查看器现场核对，但对应 AB artifact 在按 Skill 所有权 `dispose()` 后被移除，没有把失效私有路径冒充成持久证据。marker、state 长度和 diff 数据来自同一 Node REPL 中的 typed objects。

### 托管 JavaScript Tool 接入后的重跑

使用更新后的已安装 Skill，经 Codex 的持久 Node REPL MCP Tool 重新执行同一条完整路径。任务使用新建 tab `01F207D78BD69A28FA0B72511DCC6C2A`，浏览器事实仍由 daemon `e7cfbd66-35ad-4929-a6fd-c740f8805666`、Chrome PID `10163` 和 browser generation `94841fb3-367f-4bba-b064-3c2549f8e420` 持有。JavaScript kernel 跨每一步保留 `agent`、tab、observation 和 action result；没有终端输入、`.exit`、PTY polling 或临时 `.mjs` 文件。

安装目录通过仓库 Skill symlink 取得了当前未提交代码，但 `runtime/manifest.json` 仍标识 SDK `0.2.1`、build `ab-runtime@0.2.1+c88d9dd4e95d4e03`。这能证明本轮 Rust binary 未变化，却不能标识 Node REPL host、Presenter 和 Skill 内容的变化；正式提交前需要形成新的完整发布 identity，不能把“路径内容最新”冒充成“版本已经更新”。

实际完成：关闭首页登录层 → 进入美食频道 → 打开真实多图笔记“🇮🇹托斯卡纳🍷” → 关闭详情登录层 → `1/8` 切换为 `2/8` → 关闭详情 → 填写 `AI Agent` → 到达“登录后查看搜索结果”。

| 动作 | 耗时 | observation diff | 现场判断 |
|---|---:|---:|---|
| 关闭首页登录层 | 317 ms | 未单独计量 | screenshot 与 CUA 通过同一 MCP image content 工作 |
| 进入美食频道 | 418 ms | 2,341 字符 | 等待 `加载中` 消失并 refresh 后 URL 确认为 `homefeed.food_v3` |
| 打开多图详情 | 1,083 ms | 12,792 字符 | active surface replacement 仍被表达成巨型 patch |
| 关闭详情登录层 | 232 ms | 7,757 字符 | `inspect()` 识别 `class="icon-btn-wrapper close-button"`，无需坐标猜测 |
| `1/8 → 2/8` | 287 ms | 293 字符 | `inspect()` 识别 `class="arrow-controller right"`，精确 AX ref 点击成功 |
| 关闭详情 | 303 ms | 12,764 字符 | action 后立即捕获仍是旧详情；约下一次显式 observation 才显示 feed |
| 填写搜索词 | 320 ms | 974 字符 | `inputValue="AI Agent"`、`popupBacked=false` |
| 提交搜索 | 289 ms | 15,789 字符 | 一次到达正常搜索登录墙 |

本轮说明托管 Tool 已解决交互信封问题：AX/documentation 直接成为 MCP text content，截图的 AB identity 与 PNG 同一次返回，变量和 typed result 跨调用保留。浏览器算法层仍有两个独立问题，不能归功或归咎于 MCP：

1. 首次页面 AX capture 再次因动态 frame/viewport 变化返回 `observation_consistency_error`，等待明确页面事实后第二次 capture 成功；
2. `close-circle` 动作的 immediate post-action observation 早于站点完成关闭动画，导致同一 action transaction 仍携带旧详情，后续显式观察才看到 feed。它不是 semantic click 最终 no-op，也不能靠隐藏重放修复；应在 action result 中区分 dispatch 后即时事实与调用方要求的 settled 条件。

active surface replacement 的 12.7K/15.8K patch 仍存在，说明本次 MCP 接入没有偷偷修改 observation 语义。`1/8 → 2/8` 的 293 字符增量继续证明同一 surface 内的 diff 路径有效。

重跑终态截图 SHA-256 为 `d091a1e718c328219981651de7c3f4ad7bb5e20c810f14f89bb1daa061d17f0e`；artifact 是 client-owned 临时文件，cleanup 后不把其私有路径作为持久证据。

## Codex Browser 过程

Codex Browser 通过私有 Browser Runtime 新建独立 in-app tab。

### 第一次路径与恢复错误

- 初始 snapshot 为 18,155 字符。
- `getByText("美食", { exact: true })` 给出 strict violation：两个可见匹配，并同时返回候选诊断。
- 根据诊断改用 `[id="homefeed.food_v3"]` 后，调用返回成功，但截图仍停在“推荐”；Runtime 没有自动给出 post-action state，必须由 Agent 主动重新观察才发现 no-op。
- 按当前截图点击“美食”后，站点进入官方 `300011 账号异常，请稍后重试` 页面。
- 本次执行在这里过早关闭了任务 tab，失去了页面自带“返回首页”的原地恢复机会。这个处理错误不能被解释成 Codex Browser 或站点永久失败。

用户指出应先返回首页后，实验使用同一 Browser Runtime 新建任务 tab 回到首页，只做一次受控重试，没有循环撞风控。

### 受控重试

- 首页先出现普通登录弹窗；截图关闭后回到推荐流。
- 基于当前截图点击“美食”约 4,096 ms 后成功，URL 变为 `?channel_id=homefeed.food_v3`，snapshot 为 15,904 字符。
- 语义 Locator 打开真实多图笔记“3寸小甜品再次更新！”，约 4,016 ms。登录弹窗与底层详情同时存在，snapshot 为 22,681 字符且已经包含 `1/3`。
- 关闭登录弹窗后 snapshot 为 22,136 字符；hover 显示右箭头，CUA 切图约 773 ms，marker 从 `1/3` 变为 `2/3`，snapshot 仍为 22,136 字符。
- 关闭详情，textbox count 为 1；fill 约 220 ms，snapshot 从 16,272 增加到 16,291 字符。
- `getByRole("img", { name: "搜索" })` count 为 1，语义点击约 767 ms，一次进入“登录后查看搜索结果”的正常登录墙。
- 重试完整完成，任务 tab 已关闭。

### Codex Browser 证据

原始临时证据批次：`xiaohongshu-comparison-20260901/codex-browser/`（运行日志不随仓库分发）

| 文件 | 内容 | SHA-256 |
|---|---|---|
| `01-semantic-click-noop.png` | 精确 locator 返回后仍停在推荐 | `3032d5234f0fb187410a4a96548607d6acbadc971802d2d3dddbeecb8c164d6d` |
| `02-category-security-restriction.png` | 第一次 CUA 后的 300011 | `051dac3988502221d7775f0b884404ab19a859b442a0d3a7318c583e4b3cc631` |
| `03-retry-food-channel.png` | 重试后成功进入美食 | `49ece9e73ad045437283da6535346afb1f9388b653a0993b0bc55e71731af2b8` |
| `04-multi-image-1-of-3.png` | 第一张图片 | `8aee226fd0b32463ad0a673f1abf7f03176798b053f38222091b052515e28740` |
| `05-multi-image-2-of-3.png` | 第二张图片 | `57e1010c507413650bb918db50fb261971c7d079eb1fff54c54a789e237e6562` |
| `06-search-login-wall.png` | 搜索后的正常登录墙 | `731bfe05bf14fb1e34d8d9d06d43266af2d6ceb29f674cc4988c689ee784c818` |

## 对比结论

| 方面 | AB | Codex Browser | 结论 |
|---|---|---|---|
| 完整任务 | 一次 session 完成，中间误选视频 | 第一次风控后受控重试完成 | 两边都具备完整能力 |
| 语义定位诊断 | “美食”直接得到一个可动作 AX ref | strict error 给出两个候选和精确诊断 | Codex 的 locator diagnostics 更成熟 |
| 动作后事实 | 每次 mutation 返回 transaction、state 和 diff | 调用成功不代表页面变化，需要 Agent 主动 snapshot | AB 的显式 action result 更强，但 diff scope 有缺陷 |
| 图片轮播 | screenshot path 需宿主图像能力打开，marker `1/8 -> 2/8` | screenshot 直接进入模型输出，marker `1/3 -> 2/3` | Codex 的宿主集成更顺；这不是可从 Skill 复制的浏览器算法 |
| 页面输出规模 | active state 约 8.8K；同 surface diff 626 | detail snapshot 约 22.1K，每次返回完整状态 | AB 的方向有效，surface replacement 尚未建模 |
| 失败边界 | capture consistency error 有明确 before/after identity | strict locator 诊断清楚；站点 300011 只能由页面状态识别 | 两边都需要 Agent 正确恢复，不应隐式 fallback |

“Codex Browser 更顺”主要来自三点：截图是宿主原生内容、locator strict error 带候选诊断、Skill 已把 snapshot/playwright/CUA 的切换写成稳定习惯。它并不意味着每个 semantic click 都可靠；本轮“美食”精确 locator 同样 silent no-op，最后仍依赖截图和 CUA。

AB 的优势不是 API 数量，而是动作、observation、document、viewport 和 error identity 属于一个公开 transaction。当前体验差距集中在该 transaction 没有识别 active surface replacement，导致正确的模型被错误的大 patch 淹没。

## 采纳的产品变化

本实验采纳两个彼此独立的变化：active surface identity 属于 Runtime；Agent 与 SDK 的交互信封属于宿主集成。

### Active surface identity

Runtime 不变量是：**增量 observation 只能发生在同一 effective surface identity 内。**

实现应满足：

- active surface capture 保存稳定 root identity，至少包含 session、frame、document generation 和 root backend node；document surface 也有明确 identity；
- diff 同时比较 document identity 与 effective surface identity；
- document 未变但 surface 变化时，结果表达 `surface replaced`，展示有界的当前完整 state，不生成“删除旧 surface + 添加新 surface”的巨型 patch；
- 同一 surface 内继续使用正常增量，`1/8 -> 2/8` 这类 626 字符结果不得退化为整页 state；
- Agent Presenter 明确区分 incremental diff、document replacement 和 surface replacement；
- 在既有 `active-surface-overlays` 场景中加入 document → content modal → login modal → content modal → document 的确定性转换，不创建小红书专用 fixture 或 helper。

当前源码证据与该判断一致：`observation/diff.rs` 只比较 `document_generation`；`ObservationSources` 只记录 `surface: Active | Document`；`capture.rs` 得到了 active subtree backend ids，却没有把 active root identity 保留到 observation。

### 托管 JavaScript Tool

Codex Browser 的操作面不是“很多浏览器 Tool 代替 SDK”，而是一个 MCP Tool 承载持续存在的 JavaScript kernel：Agent 仍用代码组合 client API，但不再通过终端 PTY 手工驱动普通 Node REPL。AB 当前的 terminal REPL 因而暴露了与浏览器能力无关的摩擦：输入与 `.exit` 可以互相污染，pending output 依赖 PTY polling，截图只能打印 artifact path，普通 stdout 也不能直接成为 MCP content block。

开源调查确认不需要自研解释器：Qwen Code 的 Apache-2.0 包 `@qwen-code/node-repl-mcp` 已提供独立 MCP stdio server、持久 top-level binding、top-level await、子进程 kernel、超时/取消、显式 `nodeRepl.write()` 和 `nodeRepl.emitImage()`。AB 吸收的源码来自 `QwenLM/qwen-code` 的 `packages/node-repl`，固定于 commit `2b8f73c1e9cf8b355ec46c4623398c27b458b076`，放在 `host/node-repl` 并保留原 LICENSE、源码、smoke 与测试。同类项目中，`repl-mcp` 仍依赖 PTY 与 prompt detection；`node-repl-cli` 额外引入 coordinator、TCP 和多 daemon；`mcp-v8` 是带策略与 heap snapshot 的独立 V8 sandbox，不能直接装载拥有普通 Node authority 的 AB SDK。它们解决的边界更宽或不同。

初始现场验证使用 Codex 当前的同形 `mcp__node_repl__js` Tool，得到需要修复的兼容边界：

- 直接导入已安装 `ab-client.mjs` 失败为 `process is not defined`。这发生在连接 Rust 之前，因为托管 kernel 不向 cell 暴露全局 `process`，而 AB bootstrap 与 SDK 按普通 Node 环境读取它；
- 在受信任 cell 中通过 `createRequire(import.meta.url)("node:process")` 显式提供 Node process 后，同一 AB client 立即连接成功并列出固定 profile 的 `about:blank` tab；
- `agent.documentation()` 与 `tab.ax.write("screenshot")` 随后执行成功但 MCP Tool 返回空内容，因为 AB 默认 Presenter 写 `process.stdout`，没有使用 kernel 的 `nodeRepl.write()` / `emitImage()` content channel。

这使 owner 与改动边界明确：

- Qwen Node REPL MCP 拥有 JavaScript cell、binding、取消、kernel 和 MCP content framing；AB 不复制或改写它的 parser、transform、module loader 与进程管理；
- AB Skill bootstrap 负责在这个受信任的 Node kernel 中建立版本匹配的 SDK 运行环境；
- AB Agent Presenter 负责把 AX/文档输出映射为 `nodeRepl.write()`，把已验证 screenshot bytes 映射为 `nodeRepl.emitImage()`；
- Rust 仍是 Chrome、CDP、target、observation、artifact 和 resource 的唯一 owner。MCP server 不连接 CDP、不启动第二个浏览器、不保存浏览器状态；
- 公开 npm/Skill 仍支持普通 Node 文件和 terminal REPL。MCP 是更好的 Agent host adapter，不产生第二套浏览器 API。

验收必须证明：同一个 Tool session 内变量和 AB client 跨调用保留；AX/文档以文本 content 返回；截图以 MCP image content 返回且仍携带 AB viewport/artifact identity；Tool reset/disconnect 只释放 JavaScript client，不关闭 Rust 管理的 Chrome；普通 Node Presenter 行为不退化。

#### 实现与验收结果

本轮只在宿主适配边界改动：`ab-client.mjs` 在托管 kernel 中显式取得真实 Node `process`；Agent Presenter 检测 `nodeRepl.write()` / `emitImage()` 后使用 MCP content channel。Rust Runtime、CDP、observation、action 和 protocol 均未改变。

- `host/node-repl` 与固定的 Qwen `packages/node-repl` 源码一致；唯一额外目录是本地安装生成、未纳入版本的 `node_modules`；
- 上游完整测试通过：14 个文件、152 个测试；仅 N-API fixture 因本机没有 `node-gyp` 按上游条件跳过，AB 不依赖 native addon；
- 上游 `smoke`、`smoke:mcp`、`smoke:lifecycle` 全部通过，覆盖持久 binding、动态 import、图片 content、reset、运行时错误、五个 MCP Tool、stdio wire、stdin EOF 和 kernel 子进程回收；
- SDK 构建、文档同步、Skill 自包含打包与 Skill 格式校验通过；
- 当前 Codex 托管会话直接导入已安装 `<ab-skill-root>/scripts/ab-client.mjs`，无需手工注入 `process` 即连接成功；同一 kernel 的 `abSession` 与 tab 列表跨多次 Tool 调用保留；
- `documentation("screenshot")` 作为带 `AB_DOCUMENTATION` 边界的 MCP 文本 content 返回；`tab.ax.write("screenshot")` 同一次 Tool 结果返回 `AB_SCREENSHOT` identity 与实际 PNG image content；
- client disconnect 后再次连接得到同一 `browserGeneration` `94841fb3-367f-4bba-b064-3c2549f8e420` 和 Chrome PID `10163`，证明 JavaScript session 生命周期没有接管或反复拉起 Chrome。
- 独立普通 Node ESM 进程仍能连接、通过 stdout 输出完整 `AB_DOCUMENTATION` 并正常 disconnect，terminal/file fallback 未被 MCP Presenter 替换。

当前 Codex 宿主已经启用与该开源组件同形的全局 `node_repl` MCP，因此本机没有再注册一个重名或重复 Tool。仓库保留完整 `host/node-repl` 源码，使 AB 的独立分发不依赖 Codex Browser 私有实现；将其注册为哪个宿主插件属于分发配置，不应进入浏览器协议或 SDK。

由本轮真实运行确定宿主选择规则：Codex 路径直接使用其内置 `node_repl`；其他 Agent host 在任务开始前配置 Qwen `node-repl-mcp`。Skill 不在浏览器任务中安装、启动或动态注册 MCP。两种 provider 只要满足持久 binding、`nodeRepl.write()` 和 `nodeRepl.emitImage()` 合同，就进入完全相同的 AB Skill → Agent SDK → Rust → Chrome 操作模式；它们不是两套浏览器 API，也不能在一次 Agent session 中混用两个 kernel。

## 暂不采纳

- 不增加小红书 URL、频道、笔记标题、登录弹窗或轮播专用 helper；
- 不增加自动选择图片笔记、自动关闭登录墙或自动绕过 `300011`；
- 不把 semantic no-op 自动 fallback 为 CUA 或 DOM click；
- 不复制 Codex Browser 的私有图片 response writer；MCP 路径只使用公开标准 content block 与开源 Node REPL 的 `emitImage()`，普通 Node 路径继续返回可验证 artifact path；
- 不因一次 capture consistency error 直接增加隐藏重试。先用动态 frame attach 的确定性场景判断 retryable metadata、调用方等待或 Runtime bounded recapture 哪个 owner 正确；
- 不因两套 API 分别使用 `tab.url` 与 `tab.url()` 增加兼容别名。本轮 AB 中出现一次该调用错误，属于执行者把 Codex API 形状带入 AB，不是浏览器事实缺失。

## Regression gate

实现 active surface identity 后，验收必须同时证明：

1. 既有 `active-surface-overlays` 的每个 surface replacement 被独立标识；
2. replacement 输出不包含旧 surface 的整树删除 patch；
3. 同一 modal 内的局部 mutation 仍返回增量；
4. observation/ref/document/viewport 的现有 stale 校验不被弱化；
5. 重新运行本实验时，关闭详情和填写搜索框不再产生 17K/19K 的跨 surface diff；
6. 不要求小红书在线状态成为默认测试前提，真实站点只作为外部复核证据。
