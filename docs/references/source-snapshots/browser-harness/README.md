# browser-harness source snapshot

上游：`browser-use/browser-harness`，commit `3586ec29983de12fbee5e647f504629c915ca7cc`，MIT。

收集重点：

- `daemon.py`：长期 CDP 连接、session attach/recovery、domain enable 与事件中转；
- `_ipc.py`：Agent 进程到 daemon 的本地 IPC、身份与私有 runtime path；
- `helpers.py`：自动注入 Agent 执行环境的 CDP/输入/Tab/wait helper；
- `run.py`：把一段 Agent Python 代码放入持久浏览器现场执行，并追踪 helper 调用；
- `agent_helpers.py`：Agent 可持续添加站点或任务 helper 的唯一工作文件；
- `SKILL.md` 与 `interaction-skills/`：核心 skill 保持小，iframe、shadow DOM、下载、profile、network 等按场景加载。

最值得借鉴的不是某个 helper，而是三层关系：稳定 daemon 保存浏览器连接，短执行脚本自由组合 helper，Skill 规定何时沉淀新的 helper/domain skill。AB 已选择自己的 Rust daemon 与 Unix socket；可以吸收 browser-harness 的自动拉起、跨任务持久 Chrome、低成本批处理和 helper 体验，但核心 AX/ref/action 进入 Rust，不靠运行时动态补丁维持。
