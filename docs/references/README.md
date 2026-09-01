# 浏览器自动化源码研究

## 文档定位

本目录保存 AB 所依据的浏览器自动化源码研究。它解释设计从哪里来，不充当产品使用手册，不记录施工进度，也不把外部项目能力冒充成 AB 已有能力。

AB 的正式设计和施工文件分别位于：

- [项目本质](../architecture/20260830__ab-product-essence__@hanger.md)
- [目标架构](../architecture/20260810__ab-target-architecture__@hanger.md)
- [实施计划](../plans/20260810__ab-implementation__@hanger.md)

产品使用方式以仓库 README、SDK API reference 和 `skills/ab/` 为准。旧 extension provider 方案保留在 [`docs/archive/extension-provider/`](../archive/extension-provider/README.md)，不参与 AB 实现判断。

## 研究入口

- [能力分类](../architecture/20260810__browser-automation-capability-taxonomy__@hanger.md)
- [项目版图](20260810__browser-automation-source-landscape__@hanger.md)
- [源码台账](20260810__browser-automation-source-ledger__@hanger.md)
- [机制对比](20260810__browser-automation-mechanism-comparison__@hanger.md)
- [近期演进](20260810__browser-runtime-recent-evolution__@hanger.md)
- `20260810__*.md`：按 session、observation、selector、network、browser host 等主题整理的源码档案
- [`source-snapshots/`](source-snapshots/)：精确上游版本和 Codex Browser 可见发布工件的参考快照

研究材料只用于回答实现机制和架构取舍。某个项目的方法名、产品工作流或 Agent 策略不会直接进入 AB；进入核心的能力必须能落到明确的 Browser、Tab、Frame、Locator、ElementHandle、CDPSession、Resource 或 transport/runtime 责任上。

## 维护边界

- 目标架构描述要建设的体系，不并排保留旧产品模型；
- 实施计划是一次施工选择的历史文件，不写成每日进度或测试日志；
- 源码档案可以保留外部项目事实，但不得冒充 AB 当前能力；
- 运行排障、一次性复现和历史输出不写入这里的指导文件；
- 产品 API 变化后，同步更新正式 README、API reference、类型声明和 SKILL。
