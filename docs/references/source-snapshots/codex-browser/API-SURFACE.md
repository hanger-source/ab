# Codex Browser visible API surface

以下内容由 `docs/api.json` 和 capability 文档确认。它描述公开给 Agent 的表面，不证明底层使用 Playwright package，也不推断私有实现。

## 对象层级

```text
Agent
└── Browsers
    └── Browser
        ├── Tabs -> Tab
        ├── user/open tabs
        ├── documentation
        └── browser capabilities

Tab
├── ax
├── playwright
├── dom_cua
├── cua
├── content
├── clipboard
├── dev
└── tab capabilities
```

## `tab.ax`

- observation：`write(state|screenshot|both)`、`get(...)`；
- ref/index actions：`click`、`setValue`、`selectText`、`performSecondaryAction`；
- input：`pressKey`、`typeText`、`scroll`、`drag`；
- 默认增量 diff，完整树需要显式关闭 diff；动作后重新观察得到新 index。

## `tab.playwright`

这是 Playwright-style facade：

- page：`domSnapshot`、`evaluate`、`expectNavigation`、`waitForURL`、`waitForLoadState`、`waitForEvent`；
- query：`locator`、`frameLocator`、`getByRole/Text/Label/Placeholder/TestId`；
- locator composition：`filter`、`first/last/nth`、`and/or`、后代 locator；
- read：`count`、`textContent`、`innerText`、`getAttribute`、`isVisible`、`isEnabled`、`evaluate/evaluateAll`；
- action：`click/dblclick`、`fill/type/press/pressSequentially`、`check/uncheck/setChecked`、`selectOption`、`waitFor`；
- artifacts：element screenshot、download、file chooser。

## 其他操作面

- `dom_cua`：获取带 node id 的 filtered visible DOM，并按 node id 点击、输入、滚动、按键。
- `cua`：坐标 click/double-click/drag/move/scroll/type/keypress。
- `content`：导出当前页面内容。
- `dev`：面向开发调试的页面信息。
- `capabilities`：后端按运行现场动态发布额外能力，调用方先 list/get/documentation，不按浏览器名称猜测。

## 值得形成兼容目标的部分

AB 不需要复制这些类名的内部实现，但可以让自己的 Agent facade 对齐以下使用体验：

1. 一个稳定 `Tab` 同时提供多种观察和动作面；
2. Locator 是确定性长任务路径，不是 AX 失败后的隐藏 fallback；
3. backend capability 动态发现，原始 CDP 不是默认入口；
4. download、file chooser、navigation 等事件先建立监听再触发动作；
5. 每个表面明确支持范围，不能把私有实现或另一个 backend 的能力当作通用事实。
