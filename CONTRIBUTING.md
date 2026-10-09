# 参与开发

先谢谢愿意看代码的人。这个项目是单人业余维护的，所以规矩很简单。

## 跑起来

```bash
node server/index.mjs          # 需要 Node 24 或更高
```

**零第三方依赖**：不用 `npm install`，没有构建步骤，改完刷新浏览器就生效。

## 改之前先看这两份

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) —— 三层划分（`core` 纯逻辑 / `server` IO /
  `web` 界面），说明"什么代码该放哪"。放错层的改动基本会被要求重排，不是吹毛求疵：
  这样 `core` 才能脱离 HTTP 和文件系统单独跑测试。
- [`docs/SECURITY.md`](docs/SECURITY.md) —— 信任边界与已知取舍。改动涉及认证、多用户、
  插件、卡内前端、出图地址的，请一并看看这份。

## 提 PR 要做到的事

1. **跑测试**：`node tests/run.mjs` 和 `node tests/api-test.mjs` 都要绿。
   改了界面再加一条 `node work/ui-smoke.mjs`（需要本机有 Chrome 或 Edge）。
2. **配测试**：新功能请带一条测试。这个项目的习惯是先用例后实现：
   `tests/run.mjs` 放纯逻辑，`tests/api-test.mjs` 放 HTTP 端到端。
3. **不要引入第三方运行时依赖**。这是最硬的一条约束：只用 Node 内置模块
   （含 `node:sqlite`），前端不用框架、不能有构建步骤。需要什么就先看看
   能不能用几十行自己写。
4. **不要提交 `data/`、`work/`、`build/`**（`.gitignore` 已经挡住，别用 `-f` 硬加）。
5. **提交信息**写清楚"改了什么、为什么"。中文就行。

## 不想改主程序？写插件就够了

只想加功能、不想动核心代码，看 [`docs/PLUGINS.md`](docs/PLUGINS.md)：
在 `<数据目录>/plugins/<名字>/` 放一个 `plugin.json` 和一个 `index.mjs`，就能挂上
四种钩子（HTTP 接口 / 写卡技能 / MCP 工具 / 界面视图），不用 fork 这个仓库。

## 许可证

本项目以 AGPL-3.0 发布。提 PR 等于同意你的贡献也按这个许可证发布。
从别处移植代码，请在 [`NOTICE.md`](NOTICE.md) 里登记来源。
