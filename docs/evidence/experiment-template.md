# Experiment Record

## Identity

- ID:
- Status: `candidate | testing | adopt | reject | inconclusive`
- Capability layer:
- AB baseline commit:
- Reference project and commit:
- Environment:

## Observed friction

记录 Agent 实际执行的任务、输入、目标 tab/page 状态、预期行为和实际行为。不要把抽象偏好写成问题。

## Reproduction

- Reproduction script:
- Command:
- Artifact paths:
- Repeat count:
- Reproduction rate:

## Hypotheses

列出能被实验区分的原因。每个假设要对应可观测信号。

## Comparison

参照项目使用同类输入和同类目标完成相同任务。记录它依赖的浏览器环境、执行上下文和额外前提，避免把托管浏览器、全新 profile 与用户现有浏览器直接混为一谈。

## Measurements

按问题选择度量，不强制统一指标。可使用：

- 成功/失败和重复成功率；
- 首次有效结果时间；
- Agent 需要编写的页面逻辑与底层胶水；
- tab 焦点、用户现场和并发干扰；
- 错误是否直接指出失败层级；
- artifact 是否完整且能重放判断；
- 失败后恢复所需的额外操作。

## Result

- Evidence-backed conclusion:
- What remains unknown:
- Decision:
- Product layer if adopted:
- Regression gate:
