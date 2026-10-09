# Third-party notices

## SillyTavern — https://github.com/SillyTavern/SillyTavern

Licensed under the GNU Affero General Public License v3.0; a copy is included
as `LICENSE`. SillyTavern is copyright its contributors.

This project is a SillyTavern-compatible platform and is licensed under
AGPL-3.0 as a whole.

## 当前状态

写卡区的角色卡、世界书、提示词、记忆、向量都已落地（记忆与向量的重排/热度等
加分项还是待补）；玩卡区（对话 / 群聊 / 场景状态 / 叙事控制）已落地；
工具箱 3.1 / 3.2（ComfyUI、花费统计、MCP 服务器、备份与维护）已落地。
凡是从 SillyTavern 源码移植/改编的文件，都在下面的表里逐行登记（文件 ← 来源文件）。

行为兼容性一律以 SillyTavern `release` 分支源码为准，不凭记忆编写；对照时用地址
`https://cdn.jsdelivr.net/gh/SillyTavern/SillyTavern@release/<path>`。
有意偏离原实现的地方，都写在对应文件的注释里。

| 文件 | 移植自 |
|---|---|
| `core/cards/cardfile.mjs` | `src/character-card-parser.js`（PNG `chara` / `ccv3` 文本块、base64、ccv3 优先读取、写回时删除旧块） |
| `core/worldbook/shapes.mjs` | `public/scripts/world-info.js` 的 `originalWIDataKeyMap`、`convertCharacterBook`、`newWorldInfoEntryTemplate`（酒馆形状 ⇄ 卡内形状的字段对应） |
| `core/worldbook/engine.mjs` | `public/scripts/world-info.js`（`world_info_position` / `world_info_logic` 常量、`WorldInfoBuffer#matchKeys`、分组 `checkInclusionGroups` / 评分、预算、sticky / cooldown / delay） |
| `core/prompts/macros.mjs` | `public/scripts/macros.js`、`public/scripts/macros/definitions/*`（尖括号宏、条件块、变量家族、时间家族、随机 / 抽签 / 掷骰） |
| `core/prompts/regex.mjs` | `public/scripts/extensions/regex/engine.js`、`public/scripts/extensions/regex/index.js` 的字段表、`public/scripts/utils.js` 的 `regexFromString` |
| `core/prompts/assemble.mjs` | 阶段顺序参考 `public/scripts/openai.js`、`public/index.html` 的提示词构建；作者注三种位置、prefill / suffix 语义沿用酒馆 |
| `core/chat/group.mjs` | `public/scripts/group-chats.js`（`group_activation_strategy`、`group_generation_mode`、`activateNaturalOrder` / `activateListOrder` / `activatePooledOrder`、`getGroupCharacterCards` 的信息结构） |
| `core/chat/chatfile.mjs` | `src/endpoints/chats.js` 里 importer 构造的 JSONL 形状（头 + `name/is_user/is_system/send_date/mes/extra/swipes/swipe_id`） |
| `core/chat/service.mjs` | 群聊生成流程参考 `group-chats.js` 的 `generateGroupWrapper`（一轮可连续多个成员发言）；消息的 `is_system`（只展示不发送）与 `hidden`（隐藏但仍发送）语义沿用酒馆 |

### 有意偏离

| 位置 | 偏离与原因 |
|---|---|
| `core/prompts/regex.mjs` | 酒馆里"markdownOnly / promptOnly 都不勾"的脚本既不作用于显示也不作用于提示词；蓝图 1.4 要的是"发送前改写"，所以本项目的这种脚本按"作用于发出去的提示词"处理 |
| `core/worldbook/engine.mjs` | 语义触发（`vectorized` + `semanticThreshold`）是蓝图里"比酒馆更进一步"的部分：相似度由调用方算好放进 `semanticScores` |

## 协议参考（**没有**移植代码，只对协议/接口形态）

这些是外部系统的公开协议，本项目的实现是自己写的；登记在这里是为了说明
"兼容性是照着哪份源码核对的"，方便以后对照升级。

| 参考对象 | 用在哪 | 核对了什么 |
|---|---|---|
| ComfyUI（`server.py`、`execution.py`、`comfy_execution/progress.py`、`nodes.py` 的节点定义，`master` 分支） | `core/toolbox/comfy.mjs`、`server/toolbox/comfy.mjs`、`server/toolbox/runner.mjs` | `/prompt` `/queue` `/history/{id}` `/view` `/system_stats` 的请求与返回形状；`executing` / `executed` / `execution_start` / `execution_cached` / `execution_success` / `execution_error` / `progress` / `progress_state` / `status` 事件名与字段；`client_id` 决定 WebSocket 事件推给谁；内置示例工作流（`COMFY_WORKFLOW_PRESETS`）按默认文生图 / 局部重绘的节点接线写（CheckpointLoaderSimple → CLIPTextEncode×2 → KSampler → VAEDecode → SaveImage；重绘用 LoadImage + VAEEncodeForInpaint），没有复制代码 |
| Model Context Protocol（`2024-11-05` 规范） | `core/mcp/server.mjs`、`server/mcp/stdio.mjs` | `initialize` / `tools/list` / `tools/call` / `notifications/initialized` 的 JSON-RPC 形状，以及工具返回的 `content[].type='text'` + `isError` |
| flizzywine/dsh-tavern（`tavern-plugin/prompts/card-task-extract.md`、`card-task-worldbook.md`，tag `2.4`） | `core/agent/creative-skills.mjs` 的 `chat.extract_entities` | 只参考了它的提示词思路（信息够就直接做、专有名词必须进触发键、一条只讲一件事）与条目字段形状（title / keys / content / constant）。那两份是提示词不是可移植实现，本项目自己写了一版，**没有代码移植** |

## 自己写的、容易误认成别人的

| 文件 | 说明 |
|---|---|
| `server/toolbox/zip.mjs` | 手写的最小 ZIP 读写（只用 `node:zlib` 的 `deflateRawSync` / `inflateRawSync` / `crc32`），字段顺序按 PKZIP APPNOTE。不是第三方库的改写 |
| `tests/fixtures/mock-comfy-server.mjs` | 假的 ComfyUI；里面的 WebSocket **服务端**是照着 RFC6455 手写的（Node 只有 WebSocket 客户端） |
| `scripts/bundle.mjs` | 手写的小打包器：把 `core/` + `server/` 的 ESM 合成一个 CommonJS 文件（Node SEA 的入口必须是 CJS），只支持本项目实际用到的导入导出语法。不是 esbuild / webpack 的改写 |
| `scripts/build-exe.mjs` | 单文件 exe 的构建流程（bundle → SEA blob → 复制 node → postject 注入）。`postject` 只在**构建期**通过 `npx` 调用，不是运行时依赖 |

## Consequence

Because this project contains (and will contain) code derived from an AGPL-3.0
work, the project as a whole is licensed under AGPL-3.0. If you run it as a
network service — for example hosting it so friends can connect — section 13
obliges you to offer those users the corresponding source code.
