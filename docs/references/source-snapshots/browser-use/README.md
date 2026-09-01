# browser-use source snapshot

上游：`browser-use/browser-use`，commit `67e7194c069060453f2701e23d733d3f945b4ded`，MIT。

收集内容分三组：

- 页面观察：`dom/service.py`、`enhanced_snapshot.py`、`views.py` 和 `serializer/`，用于研究 DOM、AX、可见性、paint order、iframe 与 element index 如何组合；
- Browser runtime：`browser/session.py`、`session_manager.py`、`events.py` 和 DOM/screenshot watchdog，研究长期 session 与观察刷新；
- Agent loop：`agent/service.py`、prompt、system prompt、tools 和 registry，研究模型如何消费 browser state、选择结构化 action 并接收 `ActionResult`。

借鉴边界：DOM/AX 合并和结构化结果进入 AB observation 算法参考；LLM provider、完整自治 Agent、cloud/sandbox 产品不进入 AB core。其 element index 和 serialization 作为与 agent-browser/Codex AX 的对照实现，不直接混入 Rust engine。
