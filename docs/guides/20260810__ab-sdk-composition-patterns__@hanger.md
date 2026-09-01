# AB SDK 组合模式

AB 不提供 runner 或管理 CLI。交互式 Agent 在宿主管理的持久 Node REPL MCP kernel 中组合 `@hanger-source/ab/agent`：Codex 使用内置 `node_repl`，其他 Agent host 使用预先配置的 Qwen `node-repl-mcp`。完整批处理可以写成普通 TypeScript/JavaScript 文件；程序化 Core 调用 import `@hanger-source/ab`。Skill 不在任务过程中安装或启动 MCP。

## 连接与复用 Chrome

```js
const { connect } = await import("@hanger-source/ab/agent");
const browser = await connect();
const tabs = await browser.tabs.list();
```

第一次调用会自动拉起隐藏 daemon 与专用 Chrome；后续 Node 任务连接同一个运行现场。旧任务的 ref、observer 和 handle 不跨 client 复用，新任务应重新取得 Tab 并观察当前 document。

## 陌生页面先观察

```js
const tab = tabs[0] ?? await browser.tabs.open("https://example.com");
await tab.ax.write("state", { mode: "interactive", maxChars: 24_000 });
await tab.ax.click("e4", { write: "diff" });
```

`write()` 成功后才建立当前 Agent session + tab 的展示基线。短 ref 在发往 Rust 前还原成明确 observation id + ref id；document 或节点变化时硬失败，不按文本寻找相似替代元素。

## 稳定流程使用 Locator

```js
await tab.playwright.getByLabel("邮箱").fill("user@example.com");
await tab.playwright.getByRole("button", { name: "登录" }).click({ write: "diff" });
await tab.ax.write("state");
```

Locator 保存不可变 Query AST，由 Rust 每次针对当前 document 重新查询。单值读取和动作默认 strict；多匹配不随机选择。

## 监听先于动作

```js
await browser.documentation("network");
const network = await tab.resources.network();

try {
  const responsePromise = network.waitForResponse(
    event => event.url.includes("/api/orders"),
  );

  await tab.playwright.getByRole("button", { name: "查询订单" }).click();
  const response = await responsePromise;
  console.log(await network.responseBody(response));
} finally {
  await network.dispose();
}
```

dialog、download、file chooser、navigation 和其他可能瞬时发生的事件遵循同一顺序：先建立 resource/watcher，再触发动作。

## 视觉目标

```js
const shot = await tab.ax.get("screenshot");

await tab.cua.click({
  x: 620,
  y: 340,
  viewportId: shot.viewportId,
});
```

坐标绑定截图的 viewport identity。viewport、DPR、scroll 或 document 改变后返回 `stale_viewport`，不会拿旧截图坐标继续点击。

## 底层能力保持显式

```js
await browser.documentation("evaluate");
await browser.documentation("cdp");
const data = await tab.dev.evaluate(() => globalThis.__APP_STATE__);

const session = await tab.dev.cdp();
try {
  const metrics = await session.send("Performance.getMetrics");
  console.log(data, metrics);
} finally {
  await session.dispose();
}
```

`evaluate()` 用于页面专有数据和非 UI 计算；`CDPSession` 用于协议诊断。两者不作为普通找元素路径，也不会在 Locator/ref 失败后自动启用。

## 结束当前 client

```js
await browser.disconnect();
```

disconnect 只释放当前 client resource。daemon、Chrome、profile 与 tab 继续保留，供下一次独立任务连接。
