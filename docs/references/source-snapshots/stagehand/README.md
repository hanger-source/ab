# Stagehand source snapshot

上游：`browserbase/stagehand`，commit `4d88741a0e2283942f67ae7005a52d6f7e703698`，MIT。收集时上游 worktree 有一个无关未跟踪 `packages/core/` 目录，本快照没有包含它，也没有修改该 worktree。

收集重点：

- `understudy/locator.ts`、`deepLocator.ts`、`selectorResolver.ts`、`locatorInvocation.ts`：Playwright-style locator facade 如何落到 CDP execution context 与 DOM node；
- `frameLocator.ts`、`frameRegistry.ts`、`executionContextRegistry.ts`、`lifecycleWatcher.ts`：frame、realm 和 navigation 生命周期；
- `actService.ts`、`observeService.ts`、`cacheService.ts`、`extractService.ts`：自然语言 observe/act 如何先产生结构化 action，再执行确定性 locator；
- `prompt.ts`、`inference.ts`、LLM schemas：模型输入输出边界；
- extension page/locator controller 与 Codex integration 说明：Agent/runtime 的装配方式。

最值得借鉴的是“模型只负责选择/生成结构化动作，具体执行继续走确定性 locator”，以及 snapshot diff 后的二次判断与 action cache。自愈 selector 只能留在上层 Agent 模块，不能变成 AB Rust action runtime 的隐藏 fallback。
