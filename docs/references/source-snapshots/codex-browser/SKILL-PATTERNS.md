# Codex Browser Skill patterns

## Skill 的安排方式

主 Skill 负责路由和不变量，细节拆到 runtime documentation 与专题文档：

1. 先判断 Browser 是否是正确操作面，语义资源操作优先 connector/API/CLI；
2. 明确用户指定的浏览器优先级，不允许静默切换；
3. runtime 只初始化一次，稳定 Browser/Tab handle 持久复用；
4. 首次选择 backend 后读取它自己的完整动态文档；
5. 明确什么状态使 Tab stale，什么状态只需要重新观察；
6. 操作后选择“足以回答下一问题的最便宜状态检查”，不默认 AX、DOM、截图全取；
7. 无效果时先检查当前可见状态，不盲点第二次，也不立即降级坐标；
8. 完成信号出现后停止探索；
9. Tab cleanup、deliverable、handoff 在轮次结束时有明确语义；
10. 认证、确认、文件上传、CDP、截图等复杂专题按需读取独立文档。

## Agent 操作路径

```text
短任务或陌生页面 -> AX snapshot/index
稳定结构或重复任务 -> Playwright-style locator
需要可见 DOM node id -> DOM CUA
语义表面不足且视觉明确 -> screenshot + coordinate CUA
开发诊断或未覆盖 domain -> allowlisted raw CDP capability
```

这不是自动 fallback 链。Skill 要求 Agent根据当前任务选择表面，并在切换前说明前一表面缺少的事实。

## 对 AB Skill 的直接启发

- 主 Skill 只保存路由、生命周期和失败纪律；API 大表由 `skills/ab/api-reference.md` 与 `@ab/sdk` 类型提供，不增加 CLI API 查询面。
- 增加 Agent surface guide，明确 AX、Locator、screenshot、CDP 各自适用条件。
- 同一 Node REPL/client 保留稳定 handle，并支持“多个动作 + 一次最终观察”的批处理；跨任务重新 connect/observe，但复用同一 Chrome。
- snapshot/ref 必须携带 revision/document identity；下一次页面变化后旧 ref 明确 stale。
- 不把“自由 evaluate”写成推荐默认路径；确定性 API 足够时，Skill 应阻止模型反复手写 JS 找元素。
