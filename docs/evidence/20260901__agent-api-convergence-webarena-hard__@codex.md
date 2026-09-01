# Agent API 收敛后的 WebArena Hard 复核

## 复核对象

本轮复核验证 `Browser → Tab → ax / playwright / cua / resources / dev` 的 Agent API 形态是否保持旧版复杂任务能力。候选代码与产物使用同一身份：

| 项目 | 值 |
|---|---|
| Git commit | `12c44bf1ed7a1c56cbaa78a8e19d99cbf70aaa2e` |
| SDK | `@hanger-source/ab@0.3.0-alpha.2` |
| Runtime | `@hanger-source/ab-runtime-darwin-arm64@0.3.0-alpha.2` |
| Runtime build | `ab-runtime@0.3.0-alpha.2+12e8a3d2d6c166ca` |
| WebArena Verified | `1.2.3` |
| evaluator checksum | `35c3385b1db4b3378657589f95f50defd4234bd36e5b93d44733fd561b01db4e` |
| dataset checksum | `d65275660814663375028e9017e1f929e3c38321041b125795e2713b52243d30` |
| 操作边界 | AX/ref、Agent Locator、typed form action；不使用 screenshot、CUA、evaluate、页面 JavaScript、raw CDP 或 HTTP/API 直改 |

候选复核从项目内的版本匹配入口开始。全部活跃 Agent client 释放后，最终 Skill 再通过标准 `skills add` 从本地候选复制安装到 `~/.agents/skills/ab`；共享 Skill、daemon 与项目候选现在使用同一个 build。托管 Node REPL 已从共享 Skill 实际 connect/disconnect，后续 Agent 不再加载 alpha.1 client 触发版本交接。

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
| 544 | fresh Skill-only | 0.0 | 1775 entries；Agent 打开的 child tab 为 late attach，因此 `complete: false` | `/tmp/agent-logs/ab/webarena-api-convergence/fresh-skill-only/544/` | 独立 Agent正确统计三条四星评论；Products JSON 已返回数据，但网格只呈现空行且 loading mask 持续覆盖，未进入商品编辑与保存 |
| 549 | source-aware | 1.0 | 1837 entries；`complete: true` | `/tmp/agent-logs/ab/webarena-api-convergence/source-aware-r2/549/` | 新属性与唯一 `XXXL + Green` 变体均由官方网络 evaluator 接受 |
| 549 | fresh Skill-only | 0.0 | 378 entries；`complete: true` | `/tmp/agent-logs/ab/webarena-api-convergence/fresh-skill-only/549/` | 新 Agent 在重建后的正式基线中遇到相同 Products 空行/loading mask，停止重复动作且未产生商品 mutation |
| 769 | source-aware | 1.0 | 4004 entries；`complete: true` | `/tmp/agent-logs/ab/webarena-api-convergence/source-aware/769/` | 五个尺寸 SKU 均由独立导航、填写、保存和页面事实核验更新为 478，官方 mutation evaluator 接受 |
| 769 | fresh Skill-only | 1.0 | 5040 entries；`complete: true` | `/tmp/agent-logs/ab/webarena-api-convergence/fresh-skill-only/769/` | 新 Agent 等待 Products grid 从 2040 条旧视图收敛为 16 条搜索结果，逐个更新并核验五个 Brown SKU 为 478；一次 Save deadline 后只对账、未重放 |
| 771 | source-aware | 1.0 | 1049 entries；`complete: true` | `/tmp/agent-logs/ab/webarena-api-convergence/source-aware/771/` | 两条目标评论通过 Status 与 Save Review 更新，重新打开后均为 Approved；普通 Locator click 在候选版中生效 |
| 771 | fresh Skill-only，修复前 | 0.0 | 1497 entries | `/tmp/agent-logs/ab/webarena-api-convergence/fresh-skill-only/771/` | Agent 只批准 5 星 review 347，漏掉同页 4 星 review 352；官方 NetworkEventEvaluator 明确缺少 352 的 mutation |
| 771 | fresh Skill-only，最终候选 | 1.0 | 2118 entries；`complete: true`，无 body/attachment failure | `/tmp/agent-logs/ab/webarena-api-convergence/final-fresh-rerun/771/771/` | source-blind Agent 先盘点 5 条完整 identity set，再只批准 347 与 352，并在 All/Pending 两面读回状态；两个 mutation 均被官方 evaluator 接受 |
| 610 | source-aware | 1.0 | 89 entries；`complete: true` | `/tmp/agent-logs/ab/webarena-api-convergence/source-aware/610/` | AX/ref 完成发帖后在同一新帖继续评论，两个连续 POST 均被官方 evaluator 接受 |
| 610 | fresh Skill-only，最终候选 | 1.0 | 121 entries；`complete: true`，无 body/attachment failure | `/tmp/agent-logs/ab/webarena-api-convergence/final-fresh/610/610/` | source-blind Agent 在 f/books 创建指定标题帖子，并在新帖上继续提交 `good book!`；官方 evaluator 接受连续 mutation |
| 733 | source-aware | 1.0 | 60 entries；`complete: true` | `/tmp/agent-logs/ab/webarena-api-convergence/source-aware/733/` | 空 Body 上新增目标句并保存，页面成功提示、正文和官方 POST evaluator 三者一致 |
| 733 | fresh Skill-only，最终候选 | 1.0 | 80 entries；`complete: true`，无 body/attachment failure | `/tmp/agent-logs/ab/webarena-api-convergence/final-fresh/733/733/` | source-blind Agent 找到既有 Starfleet Academy 帖子，在正文增加指定句并保存；官方 evaluator 接受 mutation |

所有完成项以目录中的 `eval_result.json` 为准，不以页面成功提示或 Agent 自报成功代替。后续结果必须继续写入本台账并绑定候选 commit；如果同一任务在后续 commit 失败，先和这里的 commit、任务模式、evaluator checksum 与完整操作边界比较，再判断是产品回归、Agent 规划差异还是外部环境变化。

fresh 544 的第一次派工没有计入结果：该 Agent 未按候选 Skill 发现 Codex deferred `mcp__node_repl__js`，擅自用多次 `node --input-type=module` shell 进程代替托管 kernel。该无效 provenance 的 HAR 与失败响应保留在 `/tmp/agent-logs/ab/webarena-api-convergence/invalid-shell-fallback/544/`。后续 Agent 均在实际开始前确认浏览器代码只运行于同一个 managed Node REPL。

最初使用 `webarena-verified env start --url <env-control>` 被误当成站点重置；官方实现表明它只调用 `/start` 启动服务，不恢复数据库。真正的本地 reset 语义是 `env start --site shopping_admin` 删除并重建 Colima 容器。重建前的 fresh 544 与 549 运行因此移入 `/tmp/agent-logs/ab/webarena-api-convergence/invalid-dirty-environment/`，不计成绩；表中两条 fresh 结果都来自重建后的镜像基线。

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

最终候选不再让导航、dispatch、settle 与 post-action observation 分别消费完整等待窗口。一次 request 的 deadline 由 action transaction 持有并贯穿后续观察；大文档 live case 在观察超时时返回普通 `action.observation.deadline`，保留已发生的 ActionResult，托管 kernel 不需要 reset。

### Observation origin 滞后

同一 `Tab` 从 Dashboard 导航到 Product Attributes 与属性编辑页后，若不重连，Presenter 仍多次把 observation origin 标成 Dashboard URL；重连后 origin 才变成实际商品页 URL。操作 target 没有漂移，但模型可见的页面身份滞后，违背 observation identity 应来自当前 document 的要求。

610 把这一问题推进到更强的可证伪状态：创建帖子后，AX 正文已经完整显示新帖、Comment 表单和后续 `good book!` 评论，但 `Tab.url` 与两次 observation origin 仍停留在 `/submit`。因此这不是页面中间态或 Magento 特例，而是 document replacement 后 URL identity 没有同步到 Agent observation。

最终候选在每次 Presenter 输出前从 Core tab 刷新当前 origin，不再复用 wrapper 创建时的 URL；相应 Skill client live case 已覆盖同一 Tab 导航后的 origin。

### pointer click 的可证伪 no-op

Magento 的 `Edit Configurations` 对普通 pointer click 返回成功但没有打开 dialog。确认 dialog 不存在后，通过已有 `domInvoke("click")` 打开了配置向导。这里没有新增 fallback：pointer action 与 DOM activation 仍是两个显式动作，调用方根据页面事实决定是否使用后者。

769 的商品保存按钮还受到 `.admin__form-loading-mask` 覆盖，pointer action 没有被用来制造“成功”假象；显式 DOM activation 后，每个 SKU 都再次以成功提示和 Quantity 输入值核验。556 的成功提示比动作返回晚约 2 秒，第一次核验为 0，等待页面完成后变成 1，因此没有盲目重放 mutation。

### `write: "none"` 没有抑制动作 observation

769 中对保存按钮执行 `domInvoke("click", { write: "none" })`，调用结果仍反复输出重商品页的整份 AX observation，并触发宿主输出截断。动作已正确执行，但 `write` 选项没有兑现调用方对模型可见输出的控制，增加了 REPL 上下文与超时压力。这是通用 Presenter/动作返回契约问题，不应通过任务专用 helper 绕过。

最终候选修正了 `domInvoke` 的重载传参，使 `write: "none"` 同时不请求、不展示 post-action observation；默认和 `diff/state` 路径保持原语义。

### 站点行为，不进入 AB

Magento 商品 keyword search 对包含 `LumaTech™` 的名称返回 0 条；Name filter 使用 `Minerva` 后返回父商品和 15 个变体。特殊字符、搜索索引和筛选语义属于站点行为，不构成 AB selector 或搜索 helper 的理由。

### AX option 与 Locator 匹配不一致

610 的 AX state 明确呈现关闭的原生 Forum select 及 `option "books"`，但同一时刻 `getByRole("option", { name: "books", exact: true }).inspect()` 等待 30 秒后报 locator 未匹配。任务最终使用已有 observation 的 combobox ref 和官方 source-aware forum 值完成，没有新增选择器或特判。该差异属于 AX 渲染与 Locator resolve 的一致性问题。

### Magento Products 数据已返回但 UI 未完成渲染

重建容器后的 fresh 544 与 549 都在 Products 页观察到 2040 records、200 个 `tr.data-row`，但所有行高度为 0、无单元格文本，两个 `admin__data-grid-loading-mask` 持续可见。HAR 中对应 `mui/index/render?namespace=product_listing` 返回 HTTP 200、16639-byte JSON，包含 2040 条总数和当前页真实商品 items；因此不能把它归为后端、Elasticsearch 或 Agent 搜索词错误。

第三个独立 Agent 在 769 中遇到相同的短暂空主区和搜索后旧 2040 行视图，但它等待目标 row 后，网格收敛为 16 条并完成五个 SKU。这个反例排除了“重建后的 grid 永久损坏”，把问题缩到前端数据应用的完成信号与 Agent 等待语义：544/549 在 mask/空行持续阶段没有一个可靠、有限且能等到目标 row 的高层入口，769 自行把目标 row 当作完成事实才继续。

## 当前结论边界

- source-aware 六题已全部完成并取得官方 6/6；这证明候选 API 在知情操作下保留了旧基线的六类复杂任务能力，不外推为全部 Hard 258 的通过率。
- fresh Skill-only 六题已全部完成，最终为 4/6，与旧公开形态基线持平：769、771、610、733 为 1.0，544、549 为 0.0。771 从漏掉同页目标的 0.0 提升为完整盘点后的 1.0；610、733 也都由未读取源码、评测器、数据集或旧运行的独立 Agent 取得 1.0。这个结果只覆盖固定六题，不外推为全部 Hard 258 的通过率。
- deadline、origin、`write: "none"`、observation 集合释放、输入 settled value 与虚拟化 composite actionability 已按通用语义修复并通过完整 CI、聚焦 live case 与官方 771。documentation topic 的 client 生命周期仍保留为尚未收敛的产品边界。
