# AB 发布与分发

AB 以一个 Git revision 和一个 SemVer 版本同时发布 TypeScript SDK、macOS arm64 native runtime 与 Agent Skill。Git tag 是发布身份，npm 是程序库分发渠道，公开 GitHub 仓库是通用 Skill 分发渠道；三者不建立各自独立的版本线。

## 发布单元

| 单元 | 公共身份 | 用户入口 |
|---|---|---|
| Core SDK 与 Agent facade | `@hanger-source/ab` | `npm install @hanger-source/ab` |
| macOS arm64 runtime | `@hanger-source/ab-runtime-darwin-arm64` | SDK 的 exact-version optional dependency |
| Agent Skill | `skills/ab` | `npx skills add hanger-source/ab --skill ab` |

Skill 安装命令中的 `npx` 运行通用 `skills` CLI；AB Skill 本身从 GitHub 仓库读取，不额外发布一份 npm Skill 包。Skill 内置版本匹配的已编译 SDK、native runtime 与主题文档，因此 Agent 使用 Skill 时不依赖项目目录或全局 npm resolution。

## 版本与渠道

AB 只接受以下版本形式：

| SemVer | Git tag | npm dist-tag | 用途 |
|---|---|---|---|
| `0.3.0-alpha.1` | `v0.3.0-alpha.1` | `alpha` | 早期公开验证 |
| `0.3.0-beta.1` | `v0.3.0-beta.1` | `beta` | 功能基本收敛后的验证 |
| `0.3.0-rc.1` | `v0.3.0-rc.1` | `rc` | 稳定版候选 |
| `0.3.0` | `v0.3.0` | `latest` | 稳定发布 |

预发布序号必须显式递增。发布脚本不接受无渠道的自定义后缀，不把 prerelease 自动提升成稳定版，也不覆盖已经发布到 npm 的相同版本。

用户通过 dist-tag 选择风险等级：

```bash
npm install @hanger-source/ab@alpha
npm install @hanger-source/ab@beta
npm install @hanger-source/ab@rc
npm install @hanger-source/ab
```

## 准备一个版本

从干净 worktree 显式给出目标版本：

```bash
bun run release:prepare -- 0.3.0-alpha.1
```

这个命令同步 workspace、SDK、native、Cargo 与 Skill metadata 的版本，刷新 lockfile 和 protocol 产物，重新构建 native/SDK/Skill，并执行 CI 同级校验。它不创建 commit、tag、GitHub Release，也不发布外部内容。

准备完成后审阅变更并提交。Git tag 必须精确等于 `v` 加仓库版本；GitHub prerelease 标记必须与版本是否包含 `alpha`、`beta` 或 `rc` 一致。

## GitHub Release 与发布说明

发布说明是 GitHub Release 的正文，不是 `npm publish` 参数，也不是 CI 日志。仓库中的 `.github/release.yml` 定义自动生成说明的分类：Highlights、Fixes、Documentation、Maintenance 与 Other changes。GitHub 根据上一个 tag 以来合并的 pull request 和 commit 生成正文，maintainer 在真正发布前仍可审阅和补充兼容性、已知限制或迁移说明。

预发布版本创建为 GitHub prerelease：

```bash
gh release create v0.3.0-alpha.1 \
  --target main \
  --prerelease \
  --generate-notes \
  --title "AB 0.3.0-alpha.1"
```

稳定版不带 `--prerelease`：

```bash
gh release create v0.3.0 \
  --target main \
  --generate-notes \
  --title "AB 0.3.0"
```

`gh release create` 创建 tag 和公开 Release；Release 的 `published` 事件随后触发 npm workflow。CI 不改写 Release 正文，也不根据构建日志伪造 changelog。若构建或发布失败，Release 页面保留失败事实，修复必须进入新 commit 和新版本，不能覆盖已经公开的 npm version。

## GitHub 自动化

`.github/workflows/ci.yml` 在 pull request 和 `main` push 上使用 macOS arm64 runner，验证：

- Rust format、Clippy 与 workspace tests；
- Node REPL host tests、TypeScript typecheck 与 benchmark typecheck；
- protocol 和 Agent 文档没有陈旧生成物；
- release native、SDK 和自包含 Skill 能从同一源码构建；
- npm tarball 内容、公共 package identity、Skill metadata、manifest 与两个 native binary 的 build id 完全一致；
- `skills` CLI 能从仓库发现 `skills/ab`。

登录态网站和持久 profile 的交互试验不在公共 CI 中运行。它们需要真实用户现场，属于发布前的本地复杂场景证据，不由无登录状态的 GitHub runner 冒充。

`.github/workflows/release.yml` 只在 GitHub Release 发布时运行。它检出 Release 对应 tag，重新执行完整 CI 校验，根据 SemVer 计算 npm dist-tag，然后先发布 native runtime、再发布 SDK。发布使用 npm Trusted Publishing 的 GitHub OIDC 短期身份，不在仓库保存长期 npm token。

Skills.sh 不需要单独的 upload workflow。公开仓库和 `skills/ab/SKILL.md` 是分发事实；真实用户通过 `skills` CLI 安装后，skills.sh 根据其公开机制发现和统计该 Skill。

## 首次 npm bootstrap

npm Trusted Publisher 只能绑定已经存在的 package，因此两个 scope package 第一次创建需要 maintainer 使用启用 2FA 的 npm 身份手工发布一次：

```bash
npm login --registry=https://registry.npmjs.org/
npm publish ./sdk/native/darwin-arm64 --tag alpha
npm publish ./sdk/ts --tag alpha
```

第一次发布后，分别在 npm package settings 中把 `hanger-source/ab` 的 `.github/workflows/release.yml` 配置为 GitHub Actions Trusted Publisher，并允许 `npm publish`。从下一个版本开始，GitHub Release 是唯一发布入口；不再配置或保留 automation token。

首次 bootstrap 版本仍应创建对应 Git tag，使 npm 内容与 Skill 源码具有可追溯的同版本 revision。首次手工发布不证明后续 OIDC 链已经工作；只有下一次 GitHub Release 成功并能从 npm 正常安装，才完成自动发布闭环。

## 发布后的事实检查

发布完成不是以 workflow 绿色为唯一依据。需要从公共端读取并安装：

```bash
npm view @hanger-source/ab version dist-tags --json
npm view @hanger-source/ab-runtime-darwin-arm64 version dist-tags --json
npm install @hanger-source/ab@alpha
npx skills add hanger-source/ab --skill ab
```

检查安装后的 SDK 能解析同版本 native runtime，Skill manifest 的 package name/version/build id 与 npm release 相同。源码检查、构建通过和 tarball dry-run 都不能替代公共 registry 与公开 GitHub source 的真实消费。
