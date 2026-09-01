# Codex Browser visible reference snapshot

来源：本机 OpenAI bundled Browser plugin `26.825.32147`。插件 manifest 声明许可证为 `Proprietary`。

这个目录的用途是记录 Codex Browser 对 Agent 暴露的可见契约、Skill 编排和本机可读发布工件，不把它当作开源实现。已复制：

- `.codex-plugin/plugin.json`：版本、产品入口和许可证事实；
- `docs/api.json`：Browser/Tab/AX/Playwright/CUA/Content/Capability 的机器可读 API catalog；
- `docs/*.md`：操作行为、AX、Tab claim/cleanup、确认、安全、文件、截图、WebMCP 等文档；
- `docs/capabilities/`：CDP、browserAuth、pageAssets、management、visibility、viewport 等动态能力；
- `skills/control-in-app-browser/`：完整 Skill 与 Agent 展示元数据。
- `scripts/browser-client.mjs`、`scripts/browser-service.mjs`：客户端与服务端发布 bundle，用于核对可见 API 的真实运行边界；许可证仍是 Proprietary。
- `scripts/` 中的浏览器发现、启动、扩展/native-host 检查与 diagnostics 辅助脚本。

没有复制 `browser-accessibility.wasm.br`、`zxing_reader.wasm`、依赖目录或 assets。WASM 是不可审计的二进制，client/service 虽然可读也仍不是可复用的开源基底。当前本机工件哈希如下，用于以后确认参考版本没有漂移：

| 工件 | SHA-256 |
|---|---|
| `docs/api.json` | `4bfeb97e958025db37d52aea11b75bc70bca417b4995b0f711c0f07f3ddccb08` |
| `skills/control-in-app-browser/SKILL.md` | `c4febd12a39df39beaa9b33e629068fc32a57445065eb7f569b21f7f35b3cc93` |
| `scripts/browser-client.mjs` | `c52ba09202f0e82caa6f6d2a6463a8635c1b1316567975d9b91c1a05fb5af501` |
| `scripts/browser-service.mjs` | `c5ddb262a1f100741b0b5c13a8ed10d4d30a8dfcc87a6ce2f61a5b0c9d6fc4fb` |
| `scripts/browser-accessibility.wasm.br` | `97d2773f1f0d3f890e2dc8bbf7da5745cfb9c2686d893579ffc35bb9608185ee` |

可见操作面见 [API-SURFACE.md](API-SURFACE.md)，Skill 安排见 [SKILL-PATTERNS.md](SKILL-PATTERNS.md)，协议边界见 [PROTOCOL-SURFACE.md](PROTOCOL-SURFACE.md)，发布实现边界见 [VISIBLE-RUNTIME.md](VISIBLE-RUNTIME.md)。
