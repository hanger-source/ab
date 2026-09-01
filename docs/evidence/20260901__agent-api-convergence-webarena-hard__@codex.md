# Agent API 收敛后的 WebArena Hard 复核

## 复核对象

本轮复核验证 `Browser → Tab → ax / playwright / cua / resources / dev` 的 Agent API 形态是否保持旧版复杂任务能力。候选代码与产物使用同一身份：

| 项目 | 值 |
|---|---|
| Git commit | `8cb395f0fbbc74fb617392c47751db12d9fc50b9` |
| SDK | `@hanger-source/ab@0.3.0-alpha.2` |
| Runtime | `@hanger-source/ab-runtime-darwin-arm64@0.3.0-alpha.2` |
| Runtime build | `ab-runtime@0.3.0-alpha.2+019a185d363fa0d8` |
| WebArena Verified | `1.2.3` |
| evaluator checksum | `35c3385b1db4b3378657589f95f50defd4234bd36e5b93d44733fd561b01db4e` |
| dataset checksum | `d65275660814663375028e9017e1f929e3c38321041b125795e2713b52243d30` |
| 操作边界 | AX/ref、Agent Locator、typed form action；不使用 screenshot、CUA、evaluate、页面 JavaScript、raw CDP 或 HTTP/API 直改 |

候选 Skill 从项目内的版本匹配入口加载。共享安装目录 `~/.agents/skills/ab` 不属于候选验收目录，因为直接覆盖它会改变其他正在运行的 Agent 的操作说明与 runtime resolver。误装入共享目录的候选版已由远端仓库重新安装为 `0.3.0-alpha.1`，候选复核不再改动共享安装。

## 可比较的旧基线

旧六题结果首次完整进入 Git 的提交为 `4ee633004058ceb15db79ad766387e8730ba1fe6`；迁入独立 `ab` 仓库的完整快照为 `0a36ab3f6fba5b05bebc69f3e9268cfc89e4f4dc`。

| 任务 | source-aware | fresh Skill-only | 主要压力 |
|---|---:|---:|---|
| 544 | 1.0 | 0.0 | child frame、复合编辑器、相邻字段语义 |
| 549 | 1.0 | 0.0 | 属性值、颜色与尺寸组合、唯一新变体 |
| 769 | 1.0 | 1.0 | 五个 SKU 的重复检索、编辑与保存 |
| 771 | 1.0 | 1.0 | 星级状态读取、审核动作、pointer no-op |
| 610 | 1.0 | 1.0 | 创建帖子后继续评论的连续流程 |
| 733 | 1.0 | 1.0 | 历史内容检索与正文编辑 |

这张表是回归参照，不表示新候选已经完成六题。旧 HAR 原件曾放在 `/tmp`，现已不存在；旧结果的长期证据边界是任务编号、分数、上述两个 Git 基线和 [旧版架构与复杂 Agent 验收](./20260830__ab-runtime-architecture-and-complex-agent-acceptance__@codex.md)。

## 候选复核台账

| 任务 | 模式 | 官方结果 | HAR | 结果目录 | 结论 |
|---|---|---:|---|---|---|
| 544 | source-aware | 1.0 | 1340 entries；一次 PageBuilder iframe body 抓取失败，因此 `complete: false` | `/tmp/agent-logs/ab/webarena-api-convergence/source-aware/544/` | 复合编辑器的 child frame 输入与保存成立 |
| 549 | source-aware | 1.0 | 1837 entries；`complete: true` | `/tmp/agent-logs/ab/webarena-api-convergence/source-aware-r2/549/` | 新属性与唯一 `XXXL + Green` 变体均由官方网络 evaluator 接受 |
| 769 | source-aware | 1.0 | 4004 entries；`complete: true` | `/tmp/agent-logs/ab/webarena-api-convergence/source-aware/769/` | 五个尺寸 SKU 均由独立导航、填写、保存和页面事实核验更新为 478，官方 mutation evaluator 接受 |
| 771 | source-aware | 1.0 | 1049 entries；`complete: true` | `/tmp/agent-logs/ab/webarena-api-convergence/source-aware/771/` | 两条目标评论通过 Status 与 Save Review 更新，重新打开后均为 Approved；普通 Locator click 在候选版中生效 |
| 610 | source-aware | 待执行 | — | — | — |
| 733 | source-aware | 待执行 | — | — | — |

所有完成项以目录中的 `eval_result.json` 为准，不以页面成功提示或 Agent 自报成功代替。后续结果必须继续写入本台账并绑定候选 commit；如果同一任务在后续 commit 失败，先和这里的 commit、任务模式、evaluator checksum 与完整操作边界比较，再判断是产品回归、Agent 规划差异还是外部环境变化。

## 549 的通过边界

第一次候选操作保留原有 XS/S/M/L/XL 与 Black/Blue/Red，同时新增 XXXL 与 Green，Magento 因笛卡尔积生成九个新商品；官方 product evaluator 拒绝该结果。这是集合规划错误，不是 AB 机械动作失败。

重置官方环境后的复核没有新增 helper 或任务特判：

1. 在 `size` 属性中通过正常表单新增 XXXL，并填写 Admin Swatch 与 Admin Description；
2. 在 Minerva 可配置商品的 Attribute Values 步骤分别执行两个 `Deselect All`；
3. 只勾选 XXXL 与 Green；
4. 下一步页面明确显示 `1 new products will be created`；
5. 生成并保存商品。

最终 HAR 中：

- 属性保存 POST 被官方 attribute evaluator 接受；
- 商品保存 POST 的 `newProduct == 1` 只有 `size: xxxl, color: green`，被官方 product evaluator 接受；
- `associated_product_ids_serialized` 为空，表明这条 UI 路径重新定义了当前关联集合。它符合本任务 evaluator，但对真实业务使用而言具有移除原关联商品的语义，不能被包装成通用“新增一个变体”方法。

coordinator 首次收到的 Agent response 被误写成 `task_type: "action"`，导致两个网络 evaluator 已通过时总分仍为 0。失败原件保留为：

- `agent_response.task-type-action.json`
- `eval_result.task-type-action.json`

随后只把 response 分类修正为官方要求的 `task_type: "mutate"`，使用同一份 1837-entry HAR 重新执行官方 evaluator，得到最终 1.0。没有重写 HAR、修改 evaluator 或重复页面 mutation。

## 复核中暴露的通用问题

### Locator 等待与托管 JavaScript 超时

商品结果已经存在时，`Locator.waitFor({ state: "visible" })` 仍出现 15 秒超时；紧接着的 `inspect()` 在宿主 30 秒期限内没有返回并导致 Node kernel 被重置。进入 Magento 重商品编辑页后，另一次 `ax.write()` 也拖到宿主期限并重置 kernel。

Rust daemon、Chrome、tab 与页面 mutation 均在重连后保留，因此持久生命周期成立；但 Agent API 的 deadline 没有稳定收束为可恢复的普通调用失败。这个问题属于 SDK/Runtime 超时边界，不属于 549，也不能用延长宿主 timeout 或题目专用重试掩盖。

771 再次复现同一边界：第一次 `Tab.goto()` 在页面已经导航到评论 352 后仍耗尽宿主 30 秒并重置 kernel；重新连接后读取到目标 URL，因而没有重放导航。后续相同商品后台中的导航均在约 2 秒返回，说明它不是固定页面慢，而是调用完成与托管会话 deadline 偶发失配。

### Observation origin 滞后

同一 `Tab` 从 Dashboard 导航到 Product Attributes 与属性编辑页后，若不重连，Presenter 仍多次把 observation origin 标成 Dashboard URL；重连后 origin 才变成实际商品页 URL。操作 target 没有漂移，但模型可见的页面身份滞后，违背 observation identity 应来自当前 document 的要求。

### pointer click 的可证伪 no-op

Magento 的 `Edit Configurations` 对普通 pointer click 返回成功但没有打开 dialog。确认 dialog 不存在后，通过已有 `domInvoke("click")` 打开了配置向导。这里没有新增 fallback：pointer action 与 DOM activation 仍是两个显式动作，调用方根据页面事实决定是否使用后者。

769 的商品保存按钮还受到 `.admin__form-loading-mask` 覆盖，pointer action 没有被用来制造“成功”假象；显式 DOM activation 后，每个 SKU 都再次以成功提示和 Quantity 输入值核验。556 的成功提示比动作返回晚约 2 秒，第一次核验为 0，等待页面完成后变成 1，因此没有盲目重放 mutation。

### `write: "none"` 没有抑制动作 observation

769 中对保存按钮执行 `domInvoke("click", { write: "none" })`，调用结果仍反复输出重商品页的整份 AX observation，并触发宿主输出截断。动作已正确执行，但 `write` 选项没有兑现调用方对模型可见输出的控制，增加了 REPL 上下文与超时压力。这是通用 Presenter/动作返回契约问题，不应通过任务专用 helper 绕过。

### 站点行为，不进入 AB

Magento 商品 keyword search 对包含 `LumaTech™` 的名称返回 0 条；Name filter 使用 `Minerva` 后返回父商品和 15 个变体。特殊字符、搜索索引和筛选语义属于站点行为，不构成 AB selector 或搜索 helper 的理由。

## 尚未形成的结论

- source-aware 尚未完成 6/6；目前确认 544、549、769、771 四题通过。
- fresh Skill-only 尚未重跑；不能用旧 4/6 代表候选成绩。
- 上述超时与 origin 问题已经有复杂页面证据，但尚未修复和回归；在完成剩余 source-aware 题目前不为单题改动生产语义。
