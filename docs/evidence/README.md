# AB 变更证据

本目录保存会影响产品判断的真实实验、架构审计和验收证据。生产代码、公开 SDK、协议或 Skill 的行为变化，必须能从这里或对应复杂场景目录追溯到具体原因；不能只凭“更像某个项目”“某次操作不顺”或“测试需要”进入产品。

## 变更准入

每项行为变化在实现前必须记录：

- 场景：Agent 在什么浏览器、页面状态和任务中遇到问题；
- 错误事实：预期与实际行为，以及能够复核的日志、截图、trace 或 evaluator；
- 不变量：脱离原站点、标签和题目答案后，系统仍必须满足什么；
- owner：问题属于 Runtime、协议、SDK、Agent facade、Skill、测试适配还是外部站点；
- 选择理由：为什么该层应变化，为什么不是调用错误、页面限制或 Agent 判断错误；
- 既有契约：为什么现有字段、对象和 owner 不能直接表达它，避免为同一事实增加新名字；
- 成熟实现：新增公共抽象前，必须给出至少一个成熟框架的固定 commit、源码路径和实际处理语义，不能只引用项目名或相似 API；
- Agent 对照：改变 Agent 操作面前，必须用当前 Codex Browser 对同一类流程做真实调用，记录 runtime 版本、调用顺序和可见结果；
- 边界：明确不加入的站点特例、隐式 fallback、自动重试和兼容路径；
- 验证：什么真实流程或确定性场景能够让错误实现失败。

实验可以得出 `adopt`、`reject` 或 `inconclusive`。`inconclusive` 不得通过临时抽象、helper 或协议字段伪装成已形成的产品判断。
测试通过数量只说明已执行的检查没有发现相应错误，不是行为变化的选择理由，也不能替代上述来源和现场证据。

## 记录与场景的关系

真实站点实验保留原始过程和外部限制；它不直接成为长期在线测试。只有问题能还原为与站点无关的页面形态、状态转换或生命周期不变量时，才进入 `test/ab/scenarios/` 的确定性场景。

一个场景修复不得替换或削弱已有场景。生产实现不得包含原站点 URL、页面文案、坐标、benchmark 答案或只为单次通过而存在的分支。

## 提交关系

行为提交应在提交说明中引用实验记录或场景名。纯机械重命名、格式化和不改变行为的文档修正可以直接说明影响面；一旦改变运行行为，仍按本页记录原因和场景。

## 关键行为证据

- [Client target ownership and popup expectation](20260902__client-target-ownership-and-popup-expectation__@codex.md)：共享 daemon 中的 target mutation lease、popup opener 继承和 race-free expectation。
- [Observation usability and coverage](20260902__observation-usability-and-coverage__@codex.md)：Agent 首用 API 归属、现有 frame coverage 诊断与只读原子捕获的一次有界重试。
