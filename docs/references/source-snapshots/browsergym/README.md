# BrowserGym source snapshot

上游：`ServiceNow/BrowserGym`，commit `9e779f087de9a65668b6974d11f9ce9816026e96`，Apache-2.0。

收集的是 `browsergym/core`：

- `observation.py` 与 `utils/obs.py`：页面 observation 形状与变换；
- `action/`：high-level、Python action、parser 和 action space；
- `spaces.py`：Gym-compatible observation/action contract；
- `env.py`、`task.py`、`registration.py`：任务、环境 reset/step 和 benchmark 注册；
- `demo_agent/agent.py`：最小 Agent 如何消费 observation 并返回 action。

它不作为浏览器控制引擎，而作为 AB Agent 操作面能否被稳定评测的参考：同一个任务应能记录 observation、action、结果、错误和终止条件，避免只用最终成功率掩盖重复查找、错误 ref、无效动作和不必要截图。
