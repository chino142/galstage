# AGENTS.md

给在这个仓库里干活的 AI 助手看的。**先读这一份**——它的作用就是替掉每次开新对话时
手写的那份交接说明。

往下读之前可以先翻：`README.md`（这是什么、怎么用）、`docs/ARCHITECTURE.md`（结构怎么搭的、
功能往哪填）、`docs/SECURITY.md`（信任边界与已知取舍）、`CHANGELOG.md`（改过什么）、
`NOTICE.md`（第三方出处与有意偏离）。

## 一句话

自托管的 AI 角色扮演平台，兼容 SillyTavern 的角色卡 / 世界书 / 预设 / 对话存档，
往"能演出一部 galgame"的方向做深。

## 三条硬约束（不许破）

1. **零第三方运行时依赖**：后端只用 Node 24 内置模块（`node:http`、`node:sqlite`、
   `node:crypto`、`node:zlib`、`node:child_process`…）。仓库里没有 `npm install`，
   不要引入任何运行时依赖。`postject` 只是构建期工具，不算运行时依赖。
2. **前端无构建**：纯 ESM + 原生 DOM，代码全在 `web/`，改完刷新浏览器就生效。
   不要引入打包器、编译器或任何构建步骤。
3. **产物是单文件 exe**（Node SEA，见 `scripts/build-exe.mjs`）。

许可证是 **AGPL-3.0**：从别处移植或改编的代码必须在 `NOTICE.md` 登记出处；
有意偏离 SillyTavern 实现的地方，写进 `NOTICE.md` 的「有意偏离」表，别让那张表过期。

## 目录与分层

| 目录 | 职责 |
|---|---|
| `core/` | 纯逻辑：**不碰 HTTP、不读环境变量、不连数据库**。给它配置，它返回服务和数据，可以单独测试 |
| `server/` | HTTP 路由、SQLite、文件存储、模型提供方、MCP stdio 入口 |
| `web/` | 无构建前端，只认 HTTP 接口，**不 import `core/` 或 `server/`** |
| `tests/` | 单元测试（`run.mjs`）与端到端 HTTP 测试（`api-test.mjs`） |
| `scripts/` | 打包：bundle / SEA / 发布包 |
| `extras/` | 给用户看的说明与 Termux 脚本 |
| `docs/` | 架构、安全、插件、多用户、ComfyUI 直连 |
| `work/` | 临时草稿区，**已 gitignore、不进仓库**；用完删掉 |

- 依赖方向：`web` → HTTP → `server` → `engine.services.*` → `core`。
  **业务逻辑不写在路由里**，`server/` 里所有业务都走 `engine.services.*`。
- **唯一例外**：`core/toolbox/comfy.mjs` 反向 import `web/core/comfy-events.mjs`
  （纯函数、零 import、不碰 DOM / fetch / WebSocket）。原因是 ComfyUI 的队列与事件解释
  必须由服务端 runner 和浏览器直连共用同一份，而浏览器只拿得到 `web/` 下的文件。
  方向仍然是"web 不依赖 core/server"。
- 这个仓库就是项目**唯一的家**，不要另建副本或平行工作目录。

## 跑起来与验证

```bash
node server/index.mjs          # 默认 http://127.0.0.1:8788
node tests/run.mjs             # 引擎与架构
node tests/api-test.mjs        # 端到端 HTTP（自己起临时服务与临时数据目录）
node work/ui-smoke.mjs         # 界面冒烟（本地脚本，需要 Chrome 或 Edge）
```

- **改完必须全绿再打包。** 条目数会随版本变，以输出为准，别照文档里的数字对。
- **改了界面**：另起一个临时数据目录的服务，在浏览器里真点一遍，控制台零报错。
  只跑 API 测试抓不到前端漏字段的 bug（历史上群组面板就这么漏过一次）。
- 起临时服务的写法：
  `$env:TAVERN_PORT='8799'; $env:TAVERN_DATA_DIR="$env:TEMP\tavern-check"; node server/index.mjs`
- **别拿真实数据目录做实验。**

环境变量：`TAVERN_PORT`（默认 `8788`，填 `0` 随机）、`TAVERN_HOST`（默认 `127.0.0.1`）、
`TAVERN_DATA_DIR`（默认 exe / 项目根旁边的 `data`）、`TAVERN_MULTI_USER=1`、
`TAVERN_COOKIE_SECURE`、`TAVERN_TRUST_PROXY`、`TAVERN_LOG`。
另有命令行参数：`--multi-user`、`--data-dir`、`--add-user`、`--list-users`、
`--set-password`、`--role`、`--mcp`。

## 兼容性：不凭记忆写

这是这个项目最值钱的一条规矩。

- 要确认 **SillyTavern 的行为**，去读它的源码，不要猜。本机 `raw.githubusercontent.com`
  被 DNS 污染，改用 `https://cdn.jsdelivr.net/gh/SillyTavern/SillyTavern@release/<path>`。
- 要确认**第三方 API 的字段**，去抓官方文档，不要猜。
- 核对过的出处记在 `NOTICE.md`；新增移植或改编要补登记。

## 数据库：迁移必须可重放

- 迁移清单在 `server/db/migrations.mjs`，表结构在 `server/db/schema.mjs`。
- **已发布的迁移不许改**，只能往后追加新的；每条迁移整体在事务里跑，失败整体回滚。
- **要加字段就新建表**：`ALTER TABLE ADD COLUMN` 没有 `IF NOT EXISTS`，老库上重跑会炸成
  "duplicate column name"。新表一律 `CREATE TABLE IF NOT EXISTS`。
  历史上 v5 用过 `ALTER TABLE`，之后的迁移全部改成"加新表"的规矩。
- 存储约定：时间存 ISO 字符串；复杂结构存 JSON 文本；布尔存 `0` / `1`
  （`node:sqlite` 不接受 JS 布尔值）；外键一律 `ON DELETE CASCADE`。

## 数据与隐私

- 用户数据全在数据目录里：`tavern.db`、`assets/`、`cards/`、`backups/`、`master.key`、`plugins/`。
- **软件不联系作者的任何服务器**：出网只去用户自己配置的模型端点和 ComfyUI 地址。
  改代码时不要引入遥测、统计上报或任何"打电话回家"的行为。
- `master.key` 加密各家的 API Key（首次运行生成，权限 0600）；`.stbk` 加密导出用用户口令，
  口令不落盘，所以主机管理员也解不开。
- 不要把用户数据、密钥、真实数据目录写进仓库、日志或提交信息。

## 打包与发布

```bash
node scripts/build-exe.mjs        # 单文件 exe（Node SEA）
node scripts/package-release.mjs  # 发布包 zip
```

- 流程：把 `core/` + `server/` bundle 成一个 CommonJS → 把 `web/` 作为 SEA 资源嵌入 →
  生成 blob → 复制 node → `postject` 注入。拿不到 `postject` 时脚本会留下 bundle 与 blob，
  并打印手动注入命令。
- 页面（HTML/CSS/JS）打进 exe 内部；**数据目录仍在 exe 旁边**，搬走 exe 数据跟着走。
- 平台差异：应用内「自动更新」只对 Windows 的 exe 有效，其他平台会提示手动替换。
- 作者本机习惯：重建后覆盖桌面的 `SilverTavern.exe`，覆盖前把旧的备份到桌面
  「SilverTavern-备份」，那边只留最近三份。

## 提交习惯

- **一次改动一次提交**，中文提交信息，说清"改了什么、为什么"。
- 不要提交 `data/`、`work/`、`build/`、`outputs/`（`.gitignore` 已经挡住，别用 `-f` 硬加）。
- 提交前跑测试；改了界面就再点一遍。

## 怎么跟这位作者配合

- **一批做完，中间别反复确认**——每次多余的往返都是一次成本。有取舍就说清取舍和理由。
- 回答**简短**：先给结论，再列改动过的文件清单。
- **不要在没有验证的情况下说"做完了"。**
- 不要主动建议改仓库设置、补文档、做社区运营——这些作者不关心。
