# AB

[![CI](https://github.com/hanger-source/ab/actions/workflows/ci.yml/badge.svg)](https://github.com/hanger-source/ab/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40hanger-source%2Fab)](https://www.npmjs.com/package/@hanger-source/ab)
[![skills.sh](https://skills.sh/b/hanger-source/ab)](https://skills.sh/hanger-source/ab)

AB（Agent Browser）是面向 Agent 的本地浏览器运行时。它由隐藏的原生 Rust daemon 管理一份专用、固定、持久的 headed Chrome；TypeScript SDK 把 CDP 的 target、frame、document、AX、DOM、输入与事件组织成稳定对象；Codex-style Skill 规定 Agent 如何观察、定位、动作和验证。

```text
Agent --reads--> skills/ab
  -> managed Node REPL MCP Tool
       - Codex: built-in node_repl
       - other Agent hosts: Qwen node-repl-mcp
  -> @hanger-source/ab/agent
  -> @hanger-source/ab
  -> ab-runtime (Rust daemon)
  -> agent-browser engine (linked Rust source)
  -> CDP
  -> headed Google Chrome
  -> ~/Library/Application Support/ab/chrome-profile
```

Node REPL MCP 只管理 Agent 的 JavaScript cell、变量和标准 MCP 文本/图片输出；它不连接 CDP，也不拥有浏览器状态。Codex 直接使用宿主已经提供的 `node_repl`，不启动第二个 Qwen 进程；其他 Agent host 使用标准 MCP 配置启动仓库中的 Qwen `node-repl-mcp`。两条路径进入同一 `@hanger-source/ab/agent` API。第一次 `connect()` 会尝试连接当前用户的固定 Unix socket；daemon 不存在时，SDK 自动拉起 `ab-runtime`，由它启动专用 Chrome。后续独立 Agent/Node 任务复用同一个 daemon、Chrome、tab 与登录状态，不需要扩展、手工 Chrome 参数或 server 管理命令。

## 安装

Node.js 程序安装 SDK；macOS arm64 runtime 作为同版本 optional dependency 一起安装：

```bash
npm install @hanger-source/ab
```

Agent host 安装自带 SDK、native runtime 与操作文档的通用 Skill：

```bash
npx skills add hanger-source/ab --skill ab
```

预发布版本通过 npm dist-tag 明确选择：

```bash
npm install @hanger-source/ab@alpha
npm install @hanger-source/ab@beta
npm install @hanger-source/ab@rc
```

`X.Y.Z-alpha.N`、`X.Y.Z-beta.N`、`X.Y.Z-rc.N` 与稳定版 `X.Y.Z` 分别发布到 `alpha`、`beta`、`rc` 与 `latest`。Skill 直接来自同一 GitHub 仓库；它的 metadata、内置 SDK、native runtime 和 Git tag 与 npm 版本保持一致。

每个版本通过 GitHub Release 发布，并根据 `.github/release.yml` 自动生成分类发布说明；Release 发布后，GitHub Actions 使用 OIDC 发布对应 npm 包。完整流程见[发布与分发](docs/guides/20260901__ab-release-and-distribution__@hanger.md)。

## 公共入口

```ts
import { connect } from "@hanger-source/ab/agent";

const browser = await connect();

try {
  const tabs = await browser.tabs.list();
  const tab = tabs[0] ?? await browser.tabs.open("https://example.com");

  await tab.ax.write("state", { mode: "interactive" });
  await tab.ax.click("e2", { write: "diff" });
  await tab.playwright.getByRole("button", { name: "Continue", exact: true }).click();
} finally {
  await browser.disconnect();
}
```

`browser.disconnect()` 只释放当前 SDK client 拥有的 observer、CDPSession、ElementHandle、observation 等临时资源，不关闭 daemon、Chrome 或其他 client。页面只有在调用 `tab.close()` 时才关闭。

## Agent 操作面

- 陌生页面先用 `ax.write("state")` 把 AX observation 喂给 Agent，再使用已展示 observation 的 ref；
- 稳定、重复结构使用 `tab.playwright` 中由 Rust 执行的 Playwright-style Locator；
- canvas、地图和远程桌面使用 screenshot + CUA，并绑定 viewport identity；
- 页面专有计算使用 `tab.dev.evaluate()`；
- 浏览器机制诊断与未覆盖 domain 使用 `tab.dev.cdp()` 取得显式 `CDPSession`；
- `tab.resources` 中的 network、console、dialog、download、file chooser 和 init script 都是 client-owned Resource，监听必须在动作前建立。

这些入口不是自动 fallback 链。not found、stale、hit-test、dialog、transport 与 outcome unknown 必须保留各自错误语义，SDK 不自动重放副作用动作。

## 运行架构

第一版目标平台是 macOS arm64 与当前稳定版 Google Chrome。浏览器产品单元是：

- `@hanger-source/ab`：TypeScript 源码编译的 Node.js ESM 与类型声明，包含 Core 根导出与 `@hanger-source/ab/agent`；
- `ab-runtime` / `@hanger-source/ab-runtime-darwin-arm64`：Rust daemon；
- `skills/ab/`：Agent 操作策略和 API reference。

`host/node-repl` 是给不自带托管 JavaScript Tool 的 Agent host 使用的可移植 MCP adapter，完整保留 Qwen Code Apache-2.0 实现。它不是浏览器 owner，也不是 Codex 路径的运行依赖。

`agent-browser` 是 runtime 内唯一底层引擎源码基底；Codex Browser 是 Agent UX 基准；browser-harness 只提供组合体验参考。AB 不运行这三个项目各自的 CLI、daemon、私有 Browser Runtime 或 helper 系统。

不存在浏览器扩展、Python relay、Node Browser Server、WASM build、Playwright runtime、server 管理 CLI、临时 profile、用户日常 Chrome 接管或旧链路 fallback。Node REPL MCP 是 Agent host adapter，不是浏览器 Server。

## 文档

- [AB 运行架构与复杂 Agent 验收审计](docs/evidence/20260830__ab-runtime-architecture-and-complex-agent-acceptance__@codex.md)
- [项目本质](docs/architecture/20260830__ab-product-essence__@hanger.md)
- [目标架构](docs/architecture/20260810__ab-target-architecture__@hanger.md)
- [实施计划](docs/plans/20260810__ab-implementation__@hanger.md)
- [SDK 组合模式](docs/guides/20260810__ab-sdk-composition-patterns__@hanger.md)
- [发布与分发](docs/guides/20260901__ab-release-and-distribution__@hanger.md)
- [源码研究入口](docs/references/README.md)

## 项目信息

- Author: `hanger`
- Repository: `hanger-source/ab`
- License: Apache-2.0

本仓库只包含 AB 正式产品链、独立验证与必要的上游源码。早期扩展、relay、旧 SDK 和旧 Skill 不属于该项目，也不参与构建与发布。
