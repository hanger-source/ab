# agent-browser source snapshot

上游：`vercel-labs/agent-browser`，commit `fbd046c23a2c1156891bda294aaaee715c23b3f1`，Apache-2.0。

`server/rust/agent-browser/` 保留上游 Rust 发布所需的原始目录关系：仓库根 README、LICENSE、两份公开 schema，以及位于 `cli/` 的完整 Rust crate、构建输入和测试。AB Cargo workspace 直接引用 `server/rust/agent-browser/cli`，不会把一组摘抄文件冒充完整引擎。

## 已收集内容

- `cli/src/`：完整 Rust CLI/runtime，包括 snapshot、ref、interaction、diff、CDP、browser/session、daemon、provider、MCP、stream、WebDriver、network、auth、recording、tracing、React 与 a11y 等实现。
- `cli/build.rs` 与 `cli/cdp-protocol/`：`cdp_generated.rs` 的生成器和两份 Chromium protocol JSON。没有它们，`cdp/types.rs` 不是可独立重建的 Rust 源码。
- `cli/tests/`、`cli/src/e2e_tests.rs`、`cli/src/parity_tests.rs` 与 fixtures：CLI 和行为证据。
- `cli/Cargo.toml`、`cli/Cargo.lock`：crate 依赖和锁定版本。
- `skills/agent-browser/`：完整 core Skill、references 和 templates 的独立参考副本，不进入 AB Skill package。
- `agent-browser.schema.json` 与 `docs/public/schema.json`：上游两份一致的公开命令协议 schema。
- `server/rust/agent-browser/README.md`、`LICENSE`：上游使用说明与许可证；`UPSTREAM-README.md` 是研究区的只读副本。

`cli/src/native/a11y/axe.min.js`、React hook 等被 Rust `include_str!` 引用的非 Rust 文件也随 `cli/src/` 保存。上游 dashboard 的编译产物没有复制；`build.rs` 在它缺失时会生成占位文件，因此它不是重建 Rust engine 的必需源码。

## 本地采用范围

上游 commit 是来源基线，不代表本地 crate 未修改。AB 保留明确的本地差异：

- 新增 `cli/src/lib.rs`，只公开 AB 直接使用的 native engine 模块；
- 在 CDP client/browser、snapshot、element、interaction、network、recording、screenshot、stream 与 tracing 中补齐嵌入所需的公开边界，以及 AB 已验证的 frame/ref/action 行为；
- crate 的 release profile 由根 Cargo workspace 统一拥有；
- 测试使用系统短临时目录创建 Unix socket，并在 panic 后恢复共享环境锁，保证长工程路径下的 workspace test 仍能独立报告失败。

公开 schema、README 和 LICENSE 保持与该上游 commit 内容一致。行为移植和本地差异必须继续通过本 crate 原测试、AB live suite 与 source-blind Agent 评测验证，不能只依赖源码形似。

## 使用边界

完整保存 Rust crate 不等于把整个 agent-browser CLI 原样变成产品。它给 Rust Browser Server 一条不丢语义的来源链：先确认 snapshot/ref/hit-test/action 的真实依赖，再把需要的逻辑整理进唯一的 Rust 运行时。Chrome 连接、profile、Tab/Frame、AX 状态和动作执行都由这个 Rust Server 负责。

当前边界见 [RUST-SERVER-BOUNDARY.md](RUST-SERVER-BOUNDARY.md)。
