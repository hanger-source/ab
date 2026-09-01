# Codex Browser visible runtime

本目录中的 `scripts/` 来自用户本机安装的 OpenAI bundled Browser plugin `26.825.32147`。它们是可读的发布工件，不是开源源码，许可证仍为 `Proprietary`；这里只用于研究行为和核对公开 API 如何落到运行时，不作为可复制进项目的实现。

## 两个主要发布工件

| 文件 | 可确认的内容 | 对 AB 的价值 |
|---|---|---|
| `browser-client.mjs` | Browser、Tab、AX、Playwright、DOM/CUA、capability 等客户端对象与 command schema；请求、结果和对象句柄的客户端封装 | 核对 `docs/api.json` 不是只有文档名字，并观察 Agent API 的对象组织方式 |
| `browser-service.mjs` | 服务端 command dispatch、Browser/Tab 选择、AX/DOM/CUA 与 Playwright-style 操作的运行实现；发布包中还包含 Playwright 注入脚本与 hit-target 相关逻辑 | 核对操作路由、生命周期和失败语义，但不能作为开源 engine 搬用 |

这说明 Codex Browser 的“好用”不是一份 Skill 单独造成的。Skill 约束 Agent 如何选 API；client 给出稳定对象语义；service 才负责执行、Tab 归属、状态与具体操作。我们可以借鉴这三层的接口安排，但 AX engine 应使用有明确开源许可证的 agent-browser Rust 来源。

## 诊断和启动辅助

- `chromium-browser-diagnostics.mjs` / `.d.mts`：浏览器安装、进程和连接诊断接口。
- `installed-browsers.js`、`chrome-is-running.js`、`open-chrome-window.js`：本机浏览器发现和启动辅助。
- `check-extension-installed.js`、`check-native-host-manifest.js`、`extension-ids.json`：扩展与 native host 集成检查。

这些文件说明当前产品同时处理 in-app Browser 与 Chrome 集成，但它们不改变 engine 的核心算法边界。

## 没有收集的工件

- `browser-accessibility.wasm.br`：压缩的 AX WASM 二进制；可校验哈希，但不可审计成同源 Rust。
- `zxing_reader.wasm`：二维码识别二进制，与 Agent AX 主链无关。
- `node_modules/`、assets 和其他发布依赖：体积大且不是本次 API/engine 研究所需的源边界。
