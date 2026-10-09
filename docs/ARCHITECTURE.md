# 架构说明（v0.5.1）

这份文档回答两件事：**东西是怎么搭的**，以及**我要往哪里填功能**。产品要做什么见 `docs/功能蓝图.txt`；本文件只讲结构与约定。

## 一句话

零依赖的 Node 服务 + 无构建的原生前端。`core/` 是纯逻辑，`server/` 负责 HTTP 与数据库，`web/` 是界面。所有功能先登记进**模块地图**，再挨个填实现。

## 三层与依赖方向

```
core/    纯逻辑：不碰 HTTP、不读环境变量、不连数据库
  server/  HTTP 路由、SQLite、文件存储、模型提供方
  web/     无构建前端（原生 ESM + DOM）
```

- `core/` 可以被单独测试（`tests/run.mjs` 就是这么做的）：给它配置，它返回服务和数据。
- `server/` 里所有业务都通过 `engine.services.*` 调用，不在路由里写逻辑。
- `web/` 只认 HTTP 接口，不 import 任何 `core/` / `server/` 的代码。
- **唯一的例外**：`core/toolbox/comfy.mjs` 反向 import `web/core/comfy-events.mjs`
  （纯函数、零 import、不碰 DOM / fetch / WebSocket）。原因是 ComfyUI 的队列与 WS 事件
  解释必须由**服务端 runner 与浏览器直连共用同一一份**，而浏览器只拿得到 `web/` 下的文件
  （`core/` 不对外提供）。方向仍然是"web 不依赖 core/server"，只是这一个纯文件被两边共用。

## 目录

```
core/
  index.mjs        createEngine()：装配注册表、服务、提供方
  modules.mjs      ★ 模块地图 —— 全项目要做哪些东西"的唯一清单
  registry.mjs     模块注册表：校验、依赖排序、按区域分组
  contracts.mjs    接口契约：SHAPES + assertShape（测试逐条校验）
  config.mjs       设置项 schema：默认值、类型、范围、界面分组。
  providers.mjs    聊天 / 嵌入 / 图片 / 语音 / 转写 的提供方注册表。
  models/router.mjs ★ 模型路由：谁用哪个模型（多模型协同的优先级在这里）。
  agent/           ★ 写卡助手：技能注册表 + JSON 工具协议 + 多步循环
    skills.mjs       技能注册表与执行器
    prompt.mjs       系统提示词 + JSON 容错提取
    loop.mjs         多步 Agent 循环（产出事件流）
    writing-skills.mjs 8 个内置写卡技能
    creative-skills.mjs 3 个创作辅助技能（对话成章 / 角色卡一条龙 / 素材抽取）
  mcp/             ★ MCP 客户端（stdio）与服务器管理
    client.mjs       JSON-RPC over stdio
    registry.mjs     连接管理 + 把外部工具包成技能
    server.mjs       ── 反方向：把酒馆当 MCP 服务器暴露出去的工具。
  toolbox/         ★ 工具箱（3.1 / 3.2）的纯逻辑
    comfy.mjs        工作流解析、可填参数、占位符替换、WebSocket 事件与队列解析
    cost.mjs         用量归一化、算钱、缓存节省、预估 vs 实际
    maintenance.mjs  备份 / 清理项清单、体积格式化
    scheduler.mjs    定时任务：下次运行时间、到点判断、默认任务清单
  plugins.mjs      ★ 插件机制：manifest 校验 + 四种钩子的登记（纯逻辑）。
  accounts.mjs     ★ 多用户纯逻辑：账号名校验、scrypt 口令哈希、会话令牌、cookie 解析
  staging/service.mjs ★ 演出层：把对话 + 出好的图拼成舞台；Ren'Py 工程生成（纯逻辑）。
  staging/show.mjs ★ 演出加分项纯逻辑：转场判定、BGM / 音效设置、CG 回廊、好感度路线与结局
  errors.mjs       统一错误类型（带 code 与 HTTP 状态码。
  events.mjs       进程内事件总线
  ids.mjs          id、时间戳、哈希。
  cards/           角色卡：字段表+ cardfile.mjs（PNG/JSON 双向读写）  服务
                   extras.mjs 卡内加分项：剧本大纲 / BGM 清单 / 关系图/ 一致性锁定（存data.extensions）。
  worldbook/       世界书：shapes.mjs（形状互转）+ engine.mjs（触发）+ 服务
  prompts/         提示词：宏 macros.mjs + 正则 regex.mjs + stages.mjs + assemble.mjs（15 段管线）+ 服务
  memory/          记忆：小总结 / 大总结 / 结构化档案。
  vectors/         向量：切块、增量索引、关键词 + 向量混合检索。
  frontend/        卡内前端（沙箱能力）与全局主题
  chat/            ★ 玩卡区（已落地）
    service.mjs      对话 / 群聊 / 场景状态/ 叙事控制四个服务
    group.mjs        四种说话策略（移植自 SillyTavern group-chats.js）
    chatfile.mjs     酒馆 JSONL 存档的读写（无损往返）
    state.mjs        ```state 块的解析、增量合并、骰子
    narration.mjs    候选行动的解析与兜底、导演插话、分支
    chapters.mjs     章节：把消息切成区间、命名、跳到某一条（纯逻辑）
    events.mjs       随机事件：概率判定 + 按权重抽签（纯逻辑）。
    tokens.mjs       token 估算与花费（零依赖，启发式）
server/
  index.mjs        HTTP 入口：拿运行时 → 装HTTP → 监听 → 信号处理
  runtime.mjs      ★ 唯一的运行时装配点（HTTP 入口与 MCP 入口共用）。
  mcp-stdio.mjs    ★ 把酒馆当 MCP 服务器跑（stdio 传输，Codex / Claude Code 直接挂）
  mcp/stdio.mjs    MCP 的 JSON-RPC over stdio 传输层（stdout 只放 JSON-RPC）
  log.mjs          日志：分级（silent / error / warn / info / debug）  secrets.mjs      API Key 用 AES-256-GCM 加密
  toolbox/         ★ 工具箱的执行层（这里才碰网络与文件系统）
    comfy.mjs        ComfyUI HTTP + WebSocket 客户端（超时与错误都翻成人话）
    runner.mjs      提交任务、盯进度、下载图片入库、把图绑回消息
    zip.mjs         手写的最小 ZIP 读写（只用 node:zlib）。
  scheduler.mjs    ★ 定时任务：setInterval 循环 + 执行动作（只在 HTTP 入口创建）。
  plugins.mjs      ★ 插件加载器：扫目录、import 入口、跑 register(api)、坏插件隔离
  accounts.mjs     ★ 主机账号表与会话（accounts.json + 内存会话 + 登录限速）
  tenants.mjs      ★ 租户管理器：账号 → 一整套 runtime + app（现建现用、常驻）
  host.mjs         ★ 多用户主机：登录 / 会话 / 管理接口 + 按会话转发给租户
  backup-crypto.mjs ★ 口令加密的全量备份（`.stbk`，AES-256-GCM + scrypt）。
  providers/       ★ 模型适配层
    catalog.mjs      适配器目录 + 27 个一键预设
    adapters.mjs     openai / azure / anthropic / gemini / text / vertex 六个适配器
    registry.mjs     模型网关：chat / complete / embed / models / test
  agent/runtime.mjs ★ Agent 运行时：技能 + 模型 + MCP 工具
  http/
    server.mjs     请求装配：日志 → 路由 → 静态文件 → 错误兜底
    router.mjs     路由匹配（支持 :param，先注册先匹配）
    middleware.mjs 请求上下文 ctx：body() / json() / text() / fail()
    static.mjs     静态文件 + 单页兜底 + ETag + 路径逃逸防�?    sse.mjs        Server-Sent Events（流式输出用�?  api/             接口模块，一个区域一个文�?    system.mjs     健康检查、应用元信息、设置（唯一已实现的功能�?    characters.mjs 角色�?    writing.mjs    世界�?/ 提示�?/ X�?/ 记忆 / 向量 / 卡内前端 / 写卡工具�?    playing.mjs    �?对话 / 群聊 / 状�?/ 叙事（已实现�? 演出 / 语音 / 图片（占位）
    platform.mjs   模型接入（已实现�? 素材�?/ 数据导入导出
    models.mjs     模型绑定与分工预�?    agent.mjs      写卡助手（技能清�?/ 单跑技�?/ SSE 多步运行�?    creative.mjs   创作辅助（对话成�?/ 角色卡一条龙 / 素材抽取，技能结果落成世界书�?    plugins.mjs    插件清单与插件自己的浏览器文件（/api/plugins/<名字>/<文件>�?    staging.mjs    演出层：舞台状�?/ 按场景出背景（复�?3.1�? 导出 Ren'Py zip
    mcp.mjs        MCP 服务器配置、连接、调�?    toolbox.mjs    ComfyUI / 花费 / 备份维护（已实现�?    platform.mjs   提供�?/ 素材�?/ 数据导入导出
  db/
    schema.mjs     建表 SQL（写成数据，便于审查�?    migrations.mjs 版本化迁移（已发布的迁移不许改，只能往后退进新的）
    repo.mjs       查询小工具（自动处理布尔 / 对象 / undefined�?    settings.mjs   设置的读写与校验
    chat.mjs       �?玩卡区存储：对话 / 消息 / 成员 / 变量 / 快照 / 候选行�?    xray.mjs       提示词快照的落库与查�?    comfy.mjs      �?ComfyUI 工作流与出图记录
    assets.mjs     �?素材库（�?sha256 去重落盘�?    cost.mjs       �?用量日志与价目表（汇总走 SQL GROUP BY�?    backup.mjs     �?备份与恢复（VACUUM INTO + zip + 不重启的整体搬表�?    maintenance.mjs �?数据体检、清理、统�?    meta.mjs        app_meta 读写（定时任务清单与"上次跑的时间"�?
web/
  index.html
  app.js           启动：拉 /api/app �?建外�?�?起路�?�?挂视�?  core/            dom / api / store / prefs（当前设置）/ router / i18n / shortcuts
                   comfy-events.mjs �?ComfyUI 的共享纯逻辑（地址 / 错误 / 队列 / WS 事件解释�?                   服务�?core/toolbox/comfy.mjs 反向 import 它，浏览器直连也用同一份）
  ui/              shell（导航与顶栏�? components / modal / toast / theme / notify / command-palette
                   comfy-client.mjs �?ComfyUI 浏览器直连：提交 �?WS 进度 �?取图 �?上传 �?绑消�?  views/           视图注册�?+ 各视图（未登记的模块自动走占位视图）
    chat.mjs         对话：多标签、流式、逐条操作、导入导�?    group.mjs        群聊：成员、活跃度、静音、策略、自动模式、模型分�?    state.mjs        场景状态：面板、手动改、骰子、快照回�?    narration.mjs    叙事控制：候选行动、导演模式、分�?    playing-common.mjs  四个视图共用的零件（消息气泡、SSE、弹窗）
    comfyui.mjs      工具相：连接、导入工作流、标参数、队列与进度、手动出�?    cost.mjs         花费：总览、按�?/ 模型 / 对话 / 角色、价目表
    backup.mjs       备份与维护：统计、备�?/ 恢复、体检与清�?    mcp.mjs          两个方向：外�?MCP 工具 + 把酒馆当 MCP 服务器（�?试一�?�?    scheduler.mjs    定时任务：开关、时间、上�?/ 下次运行�?立刻跑一�?
    performance.mjs  演出层：舞台（背�?/ 立绘 / 对话�?/ 选项�? 出背�?+ 导出 Ren'Py
    host.mjs         主机管理（多用户模式给管理员看）：账号、总览、租户占�?    assets.mjs       素材库：网格预览、按类型筛选、上�?/ 删除、引用计�?  ui/auth-screen.mjs 登录 / 首次建号（多用户模式�?  styles/base.css  �?设计系统：粉金毛玻璃、深色星夜底、卡片与动效

tests/
run.mjs          引擎与架构单元测试（107 项）
  api-test.mjs     端到�?HTTP 测试�?1 项，含多用户，起临时服务与临时数据目录）
  fixtures/        假的模型服务 / 假的 MCP 服务�?/ 假的 ComfyUI（含手写 WebSocket 服务端）

scripts/
  bundle.mjs       自制打包器：core/ + server/ �?ESM 合成一�?CommonJS 文件（SEA 入口必须�?CJS�?  build-exe.mjs    单文�?exe：bundle �?SEA blob（web/ 作为资源一起嵌）→ 复制 node �?postject 注入
```

## 已经能用 vs 还没�?
| �?| 状�?|
|---|---|
| 模型接入 | �?六个适配器（OpenAI 兼容 / Azure / Anthropic / Gemini / 文本补全 / Vertex）�?7 个预设、密钥加密、连通性测试、列模型 |
| 渠道兼容 | �?自定义请求头 + 七种鉴权写法 + Vertex（express / 服务账号�? 本地代理托管 |
| 多模型协�?| �?绑定（群聊成�?> 角色 > 对话 > 全局默认�? 分工预览；群聊里每个成员真的各用各的模型生成 |
| 写卡助手 | �?8 个内置技�?+ 多步 Agent + SSE 事件�?|
| MCP 客户�?| �?stdio 客户端、服务器配置、工具自动变成技�?|
| MCP 服务器（3.2�?| �?把酒馆自己暴露成 MCP 服务器（`server/mcp-stdio.mjs`），列卡 / 查对�?/ 发消�?/ 改世界书 / 切预�?/ 看提示词，三种返回模�?+ 破坏性操作二次确�?|
| 写卡区工作台 | �?一个入�?+ 11 个标签页 |
| 对话�?.1�?| �?从卡库选卡开演（自动带简介与开场白，卡内世界书跟着生效）、流式输出、重生成、继续、扮演、编�?/ 删除 / 插入、系�?/ 隐藏、每�?token、多标签、全文搜索、酒�?JSONL 双向导入导出 |
| 群聊�?.2�?| �?自然 / 列表 / 手动 / 混合四种策略、活跃度与静音、角色之间互相对话、多角色提示词隔离、自动模�?|
| 场景状态（2.3�?| �?对话变量与角色变量、六个状态面板、AI 每轮结构化状态改动、手动改、骰子、快照回�?|
| 叙事控制�?.4�?| �?每轮 3~4 个候选行动、分支与存档、导演模式（旁白 / 导演指令 / 场外）�?*章节管理（切�?/ 命名 / 跳到那一条）**�?*结局收集（图鉴）**�?*随机事件（按概率插旁白，概率与清单可调）** |
| 提示�?X 光机 | �?每轮存快照、按段展开�?token、来源、备注，支持"手动踢掉一段再重算" |
| 演出层（2.5�?| �?背景�?/ 立绘�?/ 底部对话框（打字�?+ 点击继续�? 选项分支 / �?CG / 一键导�?Ren'Py 工程（zip 带素材）�?*转场（黑�?/ 闪白 / 震动 / 镜头平移，可设时长，场景变化自动放）**�?*BGM / 音效（音频进素材库、音量可调、按地点自动切、音效库�?*�?*CG 回廊（生成过 / 触发过的图收进相册）**�?*好感度与路线 / 多结局收集**已落地；角色配音要等语音�?.6）解�?|
| 图片生成�?.7�?| �?**复用 3.1，不另造一�?*：舞台上的「按当前场景出一张背景」直接调 `comfy.run`；局部重�?/ 扩图 / 图生�?/ 表情差分批量 / 角色一致性（绑工作流�?LoRA、表情差分包）都�?3.1 里落地了；标签超市、以图搜图式素材管理还没�?|
| 语音�?.6�?| �?没做：TTS / STT 需要给提供方加 speech / transcription 适配器，�?`server/providers/*` 这次明确不允许动；提供方注册表里这两�?kind 已经占好位置，等模型接入层解禁后�?|
| ComfyUI 接入�?.1�?| �?填地址即连（连不上给人话）、导�?API 格式工作流并自动标可填参数、`{{char}}` 等占位符替换、手�?/ 标记 / 场景变化三种触发、出图入库并与消息绑定�?*对话里直接看缩略�?+ 点开大图 + 进度 / 失败原因**�?*内置七种示例工作流一键添�?*�?*绑定可加可删**、WebSocket 进度 + 轮询收尾、固定种子与参数可调�?*两种执行方式（服务器执行 / 浏览器直连：多用户默认直连，主机不碰用户地址，半自动 / 全自动落成待办由前端执行�?*�?*批量表情差分**�?*图生�?/ 局部重�?/ 扩图（参考图从素材库来，执行方自动上传给 ComfyUI�?*�?*不同角色绑不同工作流 / LoRA + 卡内表情差分包（按情绪自动换立绘�?*；标签超市、以图搜图式素材管理还没�?|
| 花费与统计（3.2�?| �?每轮 usage 落库（消息删了统计还在）、按对话 / 角色 / �?/ 模型 / 提供方汇总、价目表覆盖提供方单价、预�?vs 实际、缓存节省（适配层把各家的缓存命中字段透传�?`cachedTokens`�?|
| 备份与维护（3.2�?| �?一键全量备�?/ 恢复（VACUUM INTO 快照 + 素材打成一�?zip）、启�?/ 恢复�?/ 清理�?/ **批量导入�?/ 批量删除�?/ 数据库迁移前**自动备份并保�?N 份、清理孤立素材与失效向量与重复消息、数据统�?|
| 定时任务�?.2�?| �?零依赖调度器（setInterval + `app_meta` 落库"上次跑的时间"，重启不重复跑、停机错过的补一次）、每�?/ 每周自动备份 / 清理 / 写总结、界面开关与上次 / 下次运行时间 |
| 使用体验�?.2�?| �?可自定义快捷键（发�?/ 继续 / 重生�?/ 切换角色 / 搜索）、Ctrl/Cmd+K 命令面板、中�?/ English 界面、生成完成通知（响一�?/ 浏览器通知）、护眼暖色主�?|
| 创作辅助�?.2�?| �?对话 �?小说章节（润�?/ 分段 / 排版，可复制 / 导出 .md）、角色卡 �?世界�?+ 分场剧本一条龙、从对话抽取人物 / 地点 / 物品并存成世界书条目 |
| 插件机制�?.2�?| �?`<数据目录>/plugins/<名字>/` �?`plugin.json` + `index.mjs` 即加载；四种钩子（HTTP 接口 / 写卡技�?/ MCP 工具 / 界面视图）；插件模块追加�?`/api/app`（不动模块地图校验）；坏插件只记警告、不影响启动 |
| 多用�?/ 权限 | �?多用户模式（`--multi-user`）：一个网址 + 登录，一人一个数据目录（各自 SQLite / 素材 / 主密钥），主机管理账号与总览，口令加密的全量备份导出 / 导入�?*租户默认 ComfyUI「浏览器直连�?*（主机不向用户填的地址发请求）；含 7 条端到端用例（`tests/api-test.mjs`）；安全边界�?`docs/SECURITY.md` |
| 素材�?| �?�?sha256 去重存储、上�?/ 列表 / 取字�?/ 删除�?*素材库页面（网格 / 筛�?/ 上传 / 删除�?*；出图结果与消息关联并在对话里显示缩略图 / 大图�?*引用计数（消�?/ 出图记录 / 角色头像各引用几次）**；缩略图（原�?+ CSS 缩放）还没做 |
| 角色卡（1.2�?| �?PNG（chara + ccv3）与�?JSON、V1/V2/V3、未知字段无损往返、CRUD、版本与回滚、批量导入文件夹、导�?PNG/JSON、搜�?/ 收藏 / 自定义标签�?*卡内加分项（1.10：剧本大�?/ BGM 音效清单 / 角色关系�?/ 一致性锁定，存在 data.extensions 里跟着卡走�?* |
| 世界书（1.6�?| �?条目 CRUD、关键词 / 正则触发�?*语义触发（接向量：有嵌入用余弦、没有退化成零依赖词重叠�?*、四种次关键词逻辑、扫描深度、常量、粘�?/ 冷却 / 延迟、分组权重、预算裁剪、试触发面板、酒�?�?卡内形状互转 |
| 提示词（1.4 / 1.5�?| �?14 段阶段管线、完整宏引擎（自定义宏、条件块）、正则脚本、预设队列与酒馆预设导入导出、前�?/ 后置词、作者注三种位置、三种裁剪策略、自定义宏�?*输出后处理完整正则链（全局 �?角色�?�?预设；AI 输出先过一遍再解析状态块 / 存历史，"只改显示"的进 displayContent�?* |
| 提示�?X 光机 | �?每轮快照、按段展开�?token、来源、备注；支持"手动踢掉一段再重算" |
| 向量�?.8�?| �?四类内容、切块、增量索引、关键词 + 向量混合检索、按来源清理、嵌入模型测试、重排（零依赖确定性打分） |
| 记忆�?.7�?| �?小总结 / 大总结 / 结构化档案、注入选择与理由、手写与编辑、热度与时间线视图�?*时间线点一条跳到对应消�?* |
| 卡内前端�?.3�?| �?沙箱能力边界定死（iframe `sandbox=allow-scripts` + 白名�?CSP + postMessage 桥），越界写法静态校验拦下（渲染�?*保存**两处都拦）；**代码存到卡上、跟着导出�?*�?*对话页里跑卡自带的界�?*（自己的卡自动跑；导入的卡默认要你点一下，可「信任这张卡」，信任绑代码指纹）；全局主题、按 scope 的代码持久化、布局（单�?/ 双栏 / 自适应 + 侧栏可拖宽折叠）已落�?|

玩卡区现在可以直接从卡库选一张卡开演（也可以继�?贴一张卡"）：选中的卡会把简介�?开场白一起带进对话，卡内嵌的世界书也跟着生效。卡数据是以**快照**形式存进
`chat_members.card` 的，`character_id` 指向卡库，所以以后改卡不会回改旧对话�?世界书与记忆的注入管线是通的：聊天每轮会调用
`worldbook.activate` �?`memory.selectForPrompt`，命中什么会写进提示�?X 光机�?
### 模型层怎么�?
```powershell
# 加一个提供方（OpenAI 兼容�?POST /api/providers {label, kind:'chat', adapter:'openai', baseUrl, model, apiKey, isDefault}
# 绑到角色上（女主单独用一个模型）
PUT  /api/models/bindings {scope:'character', targetId:'<角色id>', providerId}
# 看分�?GET  /api/models/plan?characters=char-1:男主,char-2:女主
# 真发一次请求验证配�?POST /api/models/ping {providerId, prompt:'ping'}
```

**记忆与上下文挂在对话上，与模型无�?* —�?换模型不会丢记忆，这就是"多模型共享记�?
的实现方式。写卡助手用的模型同样按这套优先级解析�?
### 接非官方渠道（公益站 / 中转�?/ Vertex / CLI 代理�?
三条独立的旋钮，都在「模型接�?�?高级」里�?
| 旋钮 | 解决什�?| 存在�?|
|---|---|---|
| 鉴权方式 | key 放哪个头：`bearer` / `raw`（裸 key�? `api-key` / `x-api-key` / `x-goog-api-key` / `query`（URL 参数�? `none` | `providers.auth_style` |
| 自定义请求头 | OpenRouter �?`HTTP-Referer`、中转站要求的额外头 | `providers.headers`（JSON�?|
| 本地代理 | CLI、反重力那类"先跑一个转换代�?的渠道：调用前自动拉起，用完能停 | `providers.launcher`（JSON�?|

细节�?
- **�?key 不发鉴权�?*，所以免鉴权的本地服务和中转站直接能用�?- **本地代理**只保�?按你配置的命令起一个进程、等到端口通了再发请求"，不做账号轮换�?  起来失败会把代理最近几行输出原样回显，方便看它到底缺什么�?- **Vertex** 是独立适配器（`server/providers/vertex.mjs`）：express 模式�?API key �?  `publishers/google/models/...`；服务账号模式用 `node:crypto` �?JWT �?OAuth2 token
  （有缓存）。模型名�?`claude` 开头时自动�?`:streamRawPredict`，请求体�?Anthropic 那套�?- Vertex 不能列举模型，所以它�?测试"按钮会自动退化成真发一次极短请求�?- 适配层抛的错一律转�?**502**（上游的问题），不会伪装�?500（我们的 bug）�?
### 写卡助手的工具协�?
不依赖任何一家的原生 function calling，而是让模型输出一�?JSON�?
```json
{"thought":"先抽世界�?,"tool":"worldbook.extract","args":{"text":"..."}}
{"thought":"够了","final":"草稿在下面…�?}
```

好处是本地文本补全模型也能用，行为一致、调试直观。解析在 `core/agent/prompt.mjs`
�?`extractJson`，容忍代码块与前后废话�?
## 模块地图：加一个功能要动哪�?
想加一个功能模块，只需要在 `core/modules.mjs` 里加一条：

```js
{
  id: 'my-feature',            // kebab-case，唯一
  area: 'writing',             // writing | playing | toolbox | platform
  title: '我的功能',
  summary: '一句话说明',
  status: 'planned',           // planned | stub | partial | ready
  web: { view: 'my-feature', icon: '�? },
  api: ['/api/my-feature'],
  dependsOn: ['cards'],
  plan: ['子功能一', '子功能二'],
  blueprint: '1.9',            // 对应功能蓝图的章节号
}
```

加完之后**自动生效**：侧边栏多一项、`/api/app` 多一条、界面自动渲染它�?计划清单与接口路径。要让它有真正的界面，再�?`web/views/` 里写一个视图�?�?`views/index.mjs` 里按 `web.view` 登记；没有登记就用通用占位视图�?
依赖关系在启动时校验：写�?id 或缺依赖会直接报错，不会拖到运行时�?
## 接口契约

契约集中�?`core/contracts.mjs`，用 `SHAPES` + `assertShape` 表达�?测试里会逐条跑。约定：

- **空结果也要形状正�?*。没实现的方法返回结构完整的空值（例如
  `{ items: [], total: 0 }`），而不�?`null` 或直接崩，前端因此可以先把界面做完�?- **真没做的方法�?`NotImplementedError`**，HTTP 层自动转�?`501` + 统一错误形状�?- **错误形状统一**：`{ error: { code, message, details } }`�?- **流式协议**（聊天用）：`start �?delta* �?usage �?done`，出错走 `error`�?
各服务的当前状态：

| 服务 | 已能�?| 待实�?|
|---|---|---|
| `cards` | `list` `get` `stats` `fields` `create` `update` `remove` `parse` `write` `document` `importFiles` `exportPng` `listVersions` `restoreVersion` `avatar` | �?|
| `worldbook` | `list` `get` `entries` `activate` `testTrigger` `save` `remove` `saveEntry` `removeEntry` `importFiles` `exportFile` `convertShape`（语义触发已接向量：`activate` / `testTrigger` 内部�?`vectorized` 算分�?| �?|
| `prompts` | `stages` `placements` `render` `preview` `listPresets` `getPreset` `savePreset` `removePreset` `importPreset` `exportPreset` `listMacros` `saveMacro` `removeMacro` `listRegex` `saveRegex` `removeRegex` `listSnippets` `saveSnippet` `removeSnippet`（输出后处理正则链在 `core/chat/service.mjs` �?`generateTurn` 里用 `collectScripts` + `getRegexedString`�?| �?|
| `memory` | `layers` `list` `get` `timeline` `heat` `selectForPrompt` `summarizeSmall` `summarizeLarge` `rebuild` `update` `remove` `listProfiles` `profileKinds`（时间线跳转在前端：`ctx.navigate('chat', 'chatId:messageId')`�?| �?|
| `vectors` | `collections` `stats` `indexSource` `reindex` `removeBySource` `search` `searchHybrid` `rerank` `testEmbedding` | —（重排是零依赖确定性打分，不依赖重排模型） |
| `frontend` | `capabilities` `themeTokens` `listThemes` `saveTheme` `removeTheme` `listSnippets` `saveSnippet` `removeSnippet` `policy` `validateSnippet` `renderSandbox` | �?|
| `chat` | `list` `get` `create` `update` `remove` `messages` `send` `regenerate` `newSwipe` `switchSwipe` `continueTurn` `impersonate` `editMessage` `deleteMessage` `insertMessage` `branch` `exportChat` `importChat` `search` `plan` | �?|
| `group` | `strategies` `modes` `list` `get` `addMember` `updateMember` `removeMember` `setStrategy` `auto` | �?|
| `state` | `panels` `get` `put` `roll` `snapshots` `snapshot` `restore` `removeSnapshot` | �?|
| `narration` | `modes` `options` `latest` `director` `branch` `chapters` `saveChapter` `deleteChapter` `chapterAt` `endings` `recordCollectedEnding` `eventSettings` `saveEventSettings` `rollEvent` `maybeFireRandomEvent` | 局部重写与微调（加分项，还没做�?|
| `providers` | 五类用途的提供方注册表 + 模型网关（聊�?/ 嵌入有真实适配器，图片 / 语音合成 / 语音识别调用会明确报"没接"�?| 各家的图�?/ 语音实现 |
| `comfy` | `kinds` `placeholders` `executionModes` `config` `status` `test` `queue` `listWorkflows` `getWorkflow` `importWorkflow` `saveWorkflow` `removeWorkflow` `inputs` `preview` `run` `runBatchExpressions` `runWithReference` `expressions` `getCharacterBinding` `listCharacterBindings` `saveCharacterBinding` `removeCharacterBinding` `expressionAssetFor` `workflowForCharacter` `enqueueClientRun` `registerClientRun` `updateClientRun` `runs` `getRun` `cancel` `triggerForMessage` | �?|
| `cost` | `record` `pricesFor` `summary` `byChat` `byCharacter` `byDay` `recent` `listPricing` `savePricing` `removePricing` `stats` | �?|
| `maintenance` | `listBackups` `createBackup` `restoreBackup` `removeBackup` `autoBackup` `stats` `scan` `cleanup` | �?|
| `scheduler`（server�?| `list` `save` `remove` `runTask` `tick` `start` `stop` | �?|

### 玩卡区怎么搭的：端口注�?+ 流式协议

`core/` 不碰数据库，所以玩卡区的存储与模型都以**端口**注入（`createEngine({ settings, ports })`�?�?`core/chat/service.mjs` 顶部注释）：

```
ports.chatStore      server/db/chat.mjs         对话 / 消息 / 成员 / 变量 / 快照
ports.models         server/providers/registry  流式聊天网关
ports.resolveBinding resolveModel + 数据库绑�? 群聊成员 > 角色 > 对话 > 全局默认
ports.providerParams 提供方采样参数（含单�?priceIn / priceOut�?ports.worldbook      写卡区的世界书服务（�?characterId 取全局�?+ 角色书）
ports.memory         写卡区的记忆服务（钉�?+ 最近小总结 + 最新大总结�?ports.vectorStore    server/db/vectors.mjs      四类内容的向量片�?ports.embed          嵌入模型（没配就退化成关键词索引）
ports.summarize      记忆摘要（借聊天模型写�?/ 大总结�?ports.saveXray       server/db/xray.mjs         每轮提示词快�?ports.recordUsage    engine.services.cost       每轮用量与花费落库（蓝图 3.2�?ports.getPreset      server/db/prompts.mjs      对话上挂的提示词预设（chat.settings.presetId�?ports.imageTrigger   engine.services.comfy      一轮回复结束后�?要不要出�?（蓝�?3.1�?ports.chatContext    server/db/chat.mjs         ComfyUI 占位符的上下文（当前对话 + 在场角色 + 变量 + 场景�?ports.getSettings    server/db/settings.mjs     每次现读设置，改完立即生�?```

工具箱（3.1 / 3.2）走同一套端口注入，装配�?`server/runtime.mjs`�?
```
ports.comfyStore       server/db/comfy.mjs       工作流定义与出图记录
ports.comfyRunner      server/toolbox/runner.mjs 提交任务、盯 WebSocket 进度、轮询收�?                                                 （client 模式下自动短路：主机不向用户地址发请求）
ports.assetStore       server/db/assets.mjs      图片落盘 + �?sha256 去重
ports.costStore        server/db/cost.mjs        用量与价目表（汇总走 SQL GROUP BY�?ports.backupStore      server/db/backup.mjs      VACUUM INTO 快照 + zip 打包 / 恢复
ports.maintenanceStore server/db/maintenance.mjs 体检、清理、统�?```

`server/runtime.mjs` 是唯一的装配点：`server/index.mjs`（HTTP）与
`server/mcp-stdio.mjs`（MCP 服务器）都用它，避免两边行为漂移�?
这样做的代价�?`core/chat` 比别�?core 模块"�?一点，好处是整套对话逻辑可以�?`tests/run.mjs` 里用假的 store + 假的模型跑端到端（单聊一轮生成、群聊多模型隔离
都是这么测的），不用�?HTTP�?
流式协议在原来的 `start �?delta* �?usage �?done` 基础上允�?*一轮多�?*：群聊用
列表策略时，一次请求会连续出现「start(A) �?delta* �?done(A) �?start(B) �?…」，
事件名不变，前端每收到一�?start 就新开一个气泡�?
## 数据�?
- 引擎：`node:sqlite`（Node 24 内置），WAL 模式，外键开启�?- 表结构写�?`server/db/schema.mjs`，迁移在 `migrations.mjs`�?*已发布的迁移不许�?*�?- 约定：时间存 ISO 字符串；复杂结构�?JSON 文本；布尔存 0/1；外键级联删除�?- v1 建了 12 张表：`characters` `character_tags` `character_versions`
  `worldbooks` `worldbook_entries` `prompt_presets` `prompt_snippets`
  `regex_scripts` `prompt_xray` `memories` `vector_items` `assets` + `settings` `app_meta`�?- v2 `providers` `model_bindings`；v3 `mcp_servers`�?  **v4（玩卡区�?*`chats` `chat_members` `chat_messages` `chat_variables`
  `chat_snapshots` `chat_actions`�?- v5 �?`providers` 加了 `headers` / `auth_style` / `launcher`�?  **v6（工具箱 3.1�?*`comfy_workflows` `comfy_runs`�?  **v7（工具箱 3.2�?*`usage_log`（每轮用量与花费，含估算列与 `reported` 标记）�?  `pricing`（价目表，`provider_id` + `model` 唯一，模型留空表�?这家默认�?）�?- `comfy_runs.status` 现在多一�?`pending-client`：浏览器直连模式�?该由前端出图"的待�?  （服务端把替换好的最�?prompt 存在 `params` 里）。不改表结构，所以没有新迁移�?- **v8（ComfyUI 加分项）**`comfy_character_bindings`：角�?�?工作�?/ LoRA 触发�?/
  表情差分包（`expressions` JSON）。外键指 `characters(id)`，删卡级联清掉绑定�?- **v9（卡内前端剩余部分）**`frontend_themes`（自定义主题：名�?+ CSS 变量 JSON）�?  `frontend_snippets`（卡�?HTML / CSS / JS，按 `scope` 存）�?- 备份不落在表里：每次备份�?`<数据目录>/backups/<名字>.zip` + 同名 `.meta.json`
  （列表读元数据，不用解包）�?- 群聊与单聊共用一�?`chats`：单聊也有一条成员记录，"贴一张卡开�?的卡数据存在
  `chat_members.card` 里，将来接上角色卡表�?`character_id` 直接指过去即可�?- 分支就是新建一�?`chats`，用 `parent_chat_id` + `branch_from_message_id` 记住出处�?
## 前端约定

- 无构建：改完刷新即可，没有编译步骤�?- 导航由服务端模块表驱动，前端不写死菜单�?- 视觉系统�?`web/styles/base.css`，主题变量与 `core/frontend/service.mjs` �?  `THEME_TOKENS` 一一对应；换肤只改变量，不改组件�?- 复用零件�?`web/ui/components.mjs`（panel / tile / chip / btn / tabs / table / empty），
  视图不自己写样式�?- **当前设置**�?`web/core/prefs.mjs`（一个小状态容器）：启动时�?`/api/app` �?settings�?  设置页保存后更新它。通知 / 快捷�?/ 命令面板都现读，改设置不用刷新�?- **多语言**：`web/core/i18n.mjs` 是纯字典（`zh-CN` / `en`），只翻导航（区�?/ 模块名）�?  常用按钮、设置项与命令面板；各视图正文（领域文案）暂不翻。字典没有的 key 直接
  回退服务端标题，漏翻只会显示一�?key，不会崩�?- **快捷�?*：`web/core/shortcuts.mjs` 解析 `Enter` / `Ctrl+Enter` / `Alt+R` 这类写法�?  绑定值来自设�?`ui.shortcut.*`。聊天视图注册后先检查自己还在不在文档里，切走就不响应�?  命令面板固定 `Ctrl/Cmd+K`（`web/ui/command-palette.mjs`），模块清单也来自模块地图�?- **通知**：`web/ui/notify.mjs` —�?响一下用 WebAudio 现合成（不需要音频文件）�?  系统通知只在用户打开开关那一刻请求一次权限，被拒绝就不再弹�?- **主题**：`system / light / dark / sepia` 四种，sepia 是护眼暖色变量（`base.css` �?  一�?`[data-theme="sepia"]`）�?
## 怎么验证

```powershell
node tests/run.mjs         # 引擎与架构（107 项）
node tests/api-test.mjs    # 端到�?HTTP�?1 项，含多用户�?
# 起临时服务，别碰真实数据
$env:TAVERN_PORT='8799'; $env:TAVERN_DATA_DIR="$env:TEMP\tavern-check"; node server/index.mjs
```

界面改动必须用浏览器实点一遍，并确认控制台零报�?—�?API 测试抓不到前端漏字段的问题�?
## 玩卡区下一步可以做�?
1. 打字机音效、消息淡入、平滑滚动等手感开关（蓝图 2.1 的加分项）�?2. 语音�?.6）：要等模型接入层允许加 speech / transcription 适配器�?
叙事控制�?.4）的加分项（章节管理、结局收集、随机事件）、演出层�?.5）的加分�?（BGM / 音效、转场、CG 回廊、好感度与多结局）、工具箱�?.1）的加分项（批量表情差分�?图生�?/ 局部重�?/ 扩图、角色绑工作流与 LoRA、表情差分包）都已经做完，见下�?
### 叙事控制的加分项�?.4�?
纯逻辑�?`core/chat/chapters.mjs` �?`core/chat/events.mjs`；结局收集复用
`core/staging/show.mjs` �?`recordEnding` / `normaliseEndings`。存储都�?`chat.settings` 这一�?JSON 上，**没有加表、没有迁�?*�?
| 需�?| 怎么实现�?|
|---|---|
| 章节管理 | `chapters.mjs` �?`settings.chapters = [{id,title,summary,messageId}]` 按消息顺序算成区间（�?i 章从它的 `messageId` 到下一章前一天；开头没覆盖就补一章）。接�?`GET/POST/PUT/DELETE /api/narration/:chatId/chapters`。界面在「叙事控制」，点「跳到这条」会导航到「对话」并滚动 + 高亮那一条（`ctx.viewKey = 'chatId:messageId'`�?|
| 结局收集 | 记录写进 `settings.show.endings`（和演出层的路线共用一份），`GET/POST /api/narration/:chatId/endings`。界面上按路线列�?已收�?/ 未收�? |
| 随机事件 | `events.mjs`：`normaliseEventSettings` / `shouldFire` / `pickRandomEvent`（按权重�? `formatEventMessage`。`GET/PUT /api/narration/:chatId/events` 改开关与概率，`POST �?events/roll` 试掷（不落消息）。开着的时候，`chat.send` 在用户发言之后调用 `maybeFireRandomEvent()`，抽中就往历史里插一条旁白（跟着这一轮进上下文）。抽签走 `ports.random`，所以测试能喂确定�?roll |

### 演出层的加分项（2.5�?
纯逻辑都在 `core/staging/show.mjs`（不�?HTTP / DOM），设置存在 `chat.settings.show`
这一�?JSON 上，所�?*没有加表、没有迁�?*�?
| 需�?| 怎么实现�?|
|---|---|
| 转场 | `TRANSITIONS`（不转场 / 黑屏 / 闪白 / 震动 / 镜头左移 / 镜头右移�? `planTransition`。判定在**服务�?*做：前端�?上一帧场�?�?`?prev=1&prevPlace=�?prevTime=…` 带上来，响应里给 `transitionPlan`（第一次进不放、场景没变不放、可关自动、可手动放）。前端只负责�?`.stage` �?`stage-fx-*` 类，动效�?`base.css` |
| BGM / 音效 | 音频当普通素材上传（`/api/assets`，`kind=audio`）。设置：`volume` / `muted` / 默认 `bgm` / `bgmByPlace`（地�?�?曲目，支�?`*` 兜底�? `sfx[]`。`pickBgm` 决定当前场景放哪首；前端两个 `Audio` 对象（BGM 循环、音效单发）。浏览器会拦自动播放，所以界面上有「▶ 播放当前场景 BGM」并提示"点一下舞�? |
| CG 回廊 | `buildGallery({runs, messages})`：只�?`status='done'` 的图，按 `assetId` 去重，带 kind / 角色�?/ 情绪 / 出处。`GET /api/staging/:chatId/gallery` 给全量，舞台接口里也顺带一�?|
| 好感度与路线 / 多结局 | 好感度读 `worldState.affection`（场景状态本来就在记）。`evaluateRoutes` 按阈值算解锁，路线可指定只看某个角色；`recordEnding` 把触发的结局收进 `settings.show.endings`（同一路线只留最新一条）。`POST /api/staging/:chatId/endings` 记录 |
| Ren'Py 带上 BGM | 导出时把当前场景解析出的 BGM 一起打�?zip，并生成 `play music "audio/bgm.xxx"` |

设置面板�?`web/views/performance.mjs`（转�?/ BGM / CG 回廊 / 路线四块，都在舞台下面）�?
### 玩卡区与酒馆的已知差�?
- **候选回复（swipes）已经能用了**：界面上「再来一版」新增候选、◀ �?来回翻，
  `chat.newSwipe` / `chat.switchSwipe` 都在。差别在语义：`regenerate` 仍然�?删掉这条之后重来"�?  「再来一版」才是追加候选那一版（酒馆里两者是同一个动作的不同入口）�?- **token 是启发式估算**（零依赖，见 `core/chat/tokens.mjs`），模型返回�?usage 会覆盖它�?- **花费**要提供方�?`params` 里有 `priceIn` / `priceOut` 才有数字，否则显�?未配置单�?�?- 世界�?/ 记忆的注入管线已经接上真实服务；聊天每轮�?全局�?+ 角色�?扫世界书�?  �?钉住 + 最近小总结 + 最新大总结"取记忆，命中内容会记录进提示�?X 光机�?
## 写卡区（已落地）

按最初的顺序一块一块做完了，每块都有测试：

1. `cards`：`parse` / `write`（PNG �?chara/ccv3 块与�?JSON，未知字段无损往返）�?   数据�?CRUD、版本历史与回滚、批量导入文件夹、导�?PNG / JSON、搜�?/ 收藏 / 标签�?2. `worldbook`：条�?CRUD、关键词 / 正则触发、四种次关键词逻辑、预算与优先级�?   试触发面板、酒�?�?卡内两种形状互转�?*语义触发已接�?*（`vectorized` + `semanticThreshold`�?   �?`ports.embed` 就按余弦算，没配嵌入模型就退化成零依赖的词重叠，离线也能用）�?3. `prompts`�?4 段阶段管线、完整宏引擎（自定义宏、条件块）、正则脚本、预设导入导出�?前后置词、作者注三种位置、三种裁剪策略、X 光机（含"手动踢掉一段再重发"）�?4. `vectors`：四类内容的切块与增量索引、关键词 + 向量混合检索、按来源清理�?   重排（rerank）：多召回一批再�?覆盖�?+ 关键�?+ 整句命中"重排（零依赖确定性打分，
   不引重排模型 —�?模型接入层这次不允许动）�?5. `memory`：小总结 / 大总结 / 结构化档案、注入选择与理由、热度与时间线视图�?   热度只用于显示与排序，`selectForPrompt` 的注入规则没变（免得热度悄悄改模型看到的东西）�?6. `frontend`（卡内前端沙箱）：能力边界写�?`SANDBOX_POLICY` �?—�?   iframe `sandbox="allow-scripts"`�?*没有** same-origin�? 白名�?CSP（`connect-src 'none'`�?   + 只放行声明过的能力的 postMessage 桥；`validateSnippet` 静态拦�?`fetch` / `localStorage` /
   `parent.document` / `</script>` 逃�?/ 导航这类越界写法�?*HTML 里一律不许写 `<script>`**
   （不然属性或内联脚本里的代码会整段绕�?js.* 规则）；注入 srcdoc 前还会对 css / js �?   raw text 转义兜底（`escapeRawText`）。写卡区里能预览。
   代码**存在卡数据里**（`data.extensions['silver-tavern'].frontend`），所以导出 PNG / JSON 时
   界面跟着卡走；对话页会把它跑起来（`web/ui/card-sandbox.mjs` 是唯一的宿主侧桥实现，
   写卡区预览与对话页共用一个）。
   跑不跑由**信任模型**决定（`core/frontend/policy.mjs`）：自己的卡（`source = original`）
   跳过静态检查、打开对话自动跑；导入的卡静态检查全开、默认要你点一下，可以"信任这张卡"。
   而信任是**绑在代码哈希上**、且存在卡数据之外的表里（`card_frontend_trust`，v10）—。
   代码一改就失效，卡也没法自己"请信任我"。注意：信任影响的是**渲染***，不影响**静态检查***
   （改别人的代码仍然要过静态检查）。
   回合结束后宿主会给卡推一个事件（转成卡里监听的 `tavern-turn`，需要声明 `turn.events`），
   卡的 UI 才能跟着刷新；同一张卡的界面不会被重复重挂，切对话才会换。
7. 卡内加分项（1.10，存在 `data.extensions['silver-tavern']`，跟着导出走）。
   剧本大纲、卡内 BGM / 音效清单、角色关系图（`relationsGraph` + 纯 DOM 圆环图）。
   一致性锁定（`checkLocks` 比较 值有没有律 ，锁住的字段在保存卡时一。409 —、
界面个    写卡助手、MCP 走的都是同一。
`PUT /api/characters/:id`）→    提示词那边补齐了**输出后处理完整正则链**：`collectScripts(全局 卡 角色→ 。
预设)`，   AI 输出先过 AI_OUTPUT（`isPrompt`）再解析状态块 / 存历史；"只改显示"再跑一遍
   （`isMarkdown`）存进 `extra.displayContent`，前端渲染优先用它。

移植/改编的文件都在 `NOTICE.md` 的表里登记；行为，SillyTavern `release` 分支源码为准。
有意偏离的地方写在对应文件的注释里）

## 工具箱（3.1 / 3.2，已落地把 
### 3.1 ComfyUI

分工很清楚：`core/toolbox/comfy.mjs` 只做"的 ComfyUI 话"JSON 说人换
（解析工作流、挑可填参数、替成 `{{char}}` 这类占位符、解释队列与事件），
`server/toolbox/` 才发请求、连 WebSocket、下载图片）。

| 需求 | 怎么实现 |
|---|---|
| 填地址即连 | `GET /api/comfy/status` 用 `/system_stats` 探活；连不上返回 `ok:false` + 人话原因（端口没人监听/ 超时 / 解析不了主机名/ 连接被重置），界面据此禁用 出一张图" |
| 导入 API 格式工作流 | `parseApiWorkflow` 接受裸节点表和 `{prompt:{...}}`；`suggestBindings` 自动把有内容的文本输入、第一个种子、尺寸步数这类数值标成可填参数 |
| 占位符替换 | `{{char}} {{user}} {{scene}} {{emotion}} {{action}} {{date}}`，发请求前替换；替换不上的占位符从提示词里去掉并在返回里报 `missing`（不会静默变空） |
| 三种触发 | `manual`（只能点）、 `marker`（回复里出现 `[IMG: 提示词]`）、 `auto`（```state 里 place / time 变了）。判断在 `planImageTrigger`，提交在 `server/toolbox/runner.mjs` |
| 结果入库 + 绑消息 | 跑完从 `/history/{id}` 取图片，`GET /view` 下载，按 sha256 存进素材库，写进 `comfy_runs.images`，并把 assetId 追加到那条消息的 `extra.images` |
| 对话里看到图 | `web/views/playing-common.mjs` 按消息的 `extra.images` 画缩略图（固定高，撑不破气泡），点开走 `web/ui/modal.mjs` 看大图；出图没跑完 / 失败时，气泡下面显示进度条或可读的失败原因，失败可点「重试」重新提交同一条工作流 |
| 队列与进度 | 常连一条 WebSocket（固定 clientId）拿 `executing` / `progress` / `progress_state`；同时每 1.2s 轮询 `/queue` 和 `/history` 收尾 —— WS 断了也不影响出图，只是进度没那么细 |
| 内置示例工作流 | `core/toolbox/comfy.mjs` 的 `COMFY_WORKFLOW_PRESETS`：立绘/ 表情差分 / 背景 / CG / 局部重绘/ 图生图/ 扩图，都是最简骨架（CheckpointLoaderSimple + CLIPTextEncode×2 + KSampler + SaveImage，重绘多 LoadImage + VAEEncodeForInpaint）。是纯数据，前端只负责 点一下落库（`POST /api/comfy/presets/:id`）。
|
| 预设与参数 | 工作流按 kind 分类（立绘/ 表情差分 / 背景 / CG / 局部重绘/ 自定义），`seed` 工作流级固定，其余参数逐个可调、可预览（`/preview` 只算不发）；参数面板能从工作流的全部输入里加绑定 / 删绑定（`GET /api/comfy/workflows/:id/inputs` 和 `bound` 标记）。

|

有意偏离：ComfyUI 自带前端把 `progress` 和 `progress_state` 分别渲染成进度条成 我们归并成「当前节点 + value/max"一条（聊天旁边的小进度条不需要每层子图各画一条）。
#### 连接方式：服务器执行 / 浏览器直连（`comfy.executionMode`）。

`comfy.baseUrl` 是用户可控的地址，**server** 模式下主机进程发 `/prompt`、连 WebSocket、拉 `/queue` `/history` `/view`；多用户里这等于"主机要能连到朋友填的地址"，也给了
"填内网地址让主机替自己探测"的口子（SSRF）。**client** 模式把这条连接搬到浏览器。

| | server（单机默认） | client（多用户默认）|
|---|---|---|
| 谁发请求 | `server/toolbox/runner.mjs` | `web/ui/comfy-client.mjs`（原生fetch + WebSocket）。|
| 参数替换 | 服务端用 `buildPrompt` | 服务端用 `/preview`（复用同一份替换逻辑— |
| 进度解释 | `mapComfyEvent` | `mapComfyEvent` —息 同一份，位于 `web/core/comfy-events.mjs` |
| 入库 / 绑消端 / 记账 | 服务:runner + `attachImages` 端口 | 浏览器上传到 `/api/assets` + `/api/chats/动 attachments` + `/api/comfy/client-runs` |
| 半自/ 全自动触发 | 立刻提交 | 写 `comfy_runs.status='pending-client'`（服务端算好 prompt），前端在线时领走执行；没前端就一直挂着 |
| SSRF | 存在（界面上标注"这个地址由服务器访问"）| 主机不发任何请求（`tick` / `connectWs` / `submit` / `resume` / `test` / `queue` 全部短路）。

|

代码落点：设置项在 `core/config.mjs`；模式判断与待办登记在 `core/toolbox/service.mjs`
（`enqueueClientRun` / `registerClientRun` / `updateClientRun`）；SSRF 收口在 `server/toolbox/runner.mjs` 和 `server/api/toolbox.mjs`；多用户默认值写在 `server/runtime.mjs`（`multiUser: true` 且用户没显式设过时写成 `client`）。
新增接口 `POST/PUT /api/comfy/client-runs[/:id]` 和 `POST /api/chats/:chatId/messages/:messageId/attachments`。细节见 `docs/COMFY-DIRECT.md`。

#### 出图加分项（批量表情 / 参考图 / 角色绑定）

| 需求 | 怎么实现 |
|---|---|
| 批量表情差分 | `EXPRESSION_PRESETS`（平静/ 开心/ 难过 / 生气 / 害羞 / 惊讶）  `planExpressionBatch`。服务层把表情关键词接到工作流自己的正向提示词**后面**（角色 LoRA 触发词不会被冲掉），逐个 `run`；client 模式下逐个存成 `pending-client` 待办。接口 `POST /api/comfy/batch-expressions` |
| 图生图/ 局部重绘/ 扩图 | 参考图是**素材库里的图**。绑定值先写成 `asset:<assetId>` 标记（`makeAssetRef`），由执行方上传到 ComfyUI 的 `input` 目录后再替换成文件名：服务端在 `server/toolbox/runner.mjs` 用 `POST /upload/image`，浏览器直连在 `web/ui/comfy-client.mjs` 用同一套 FormData。标记的收集 / 替换（`collectAssetRefs` / `applyAssetRefs`）放在 `web/core/comfy-events.mjs` 里，两边共用。示例工作流：`preset-img2img`、`preset-outpaint`。接口 `POST /api/comfy/img2img` |
| 不同角色绑不同 LoRA / 工作流 | 新表 `comfy_character_bindings`（v8）：`character_id` 和 `workflow_id` + `lora_text`。`triggerForMessage` 里优先用角色绑定的工作流，并把 `lora_text` 接到提示词后面。接口 `GET/PUT/DELETE /api/comfy/character-bindings/:characterId` |
| 卡内表情差分包 | 同一张表里的 `expressions`（表情名 → assetId）。演出层 `buildStage` 接受 `expressionPack`，当前情绪（对话变量 `emotion` / 世界状态）命中就把这张图当主立绘 —— 对话里按情绪自动换。接口同上 |

导入时 `LoadImage.image` 会被标成新的绑定类型 `image`，所以 参考图"面板只列真正带参考图输入的工作流。

### 3.2 花费与统计

- 记账点在 `core/chat/service.mjs` 一轮回复跑完之后：真实 usage（提供方上报）与
  我们的启发式估算**一起**落进 `usage_log`，`reported` 标记区分"真报的"和"猜的"。
  以前 token / 花费只挂在消息上，删消息、重生成、分支都会把统计带走。
- 单价：`pricing` 的 > 提供方自带的 `params.priceIn / priceOut`。合并点在   `ports.providerParams`，所以消息上的花费和统计里的花费用的是同一份价目表。
- 缓存节省：`cached_tokens × 单价 × (1 - 折扣）`。适配层  （`server/providers/adapters.mjs` 的 `normaliseUsage`）已把各家的缓存命中字段
  （OpenAI 的 `prompt_tokens_details.cached_tokens`、Anthropic 的   `cache_read_input_tokens`、Gemini 的 `cachedContentTokenCount`）统一透传成   `cachedTokens`，`core/toolbox/cost.mjs` 据此算数；提供方没上报时才是 0。

### 3.2 MCP 服务器

走 stdio 而不接受 HTTP：Codex CLI 和 Claude Code 都是"给一条命令、用 stdin/stdout
说话"，不用开端口、不用鉴权、也不会把读写接口暴露到网络上。

```powershell
node <项目目录>/server/mcp-stdio.mjs --data-dir <数据目录>
```

13 个工具，覆盖蓝图要求的六件事：`cards.list` / `cards.get`（列卡）、`chats.list` / `chats.messages`（查对话）、`chats.send`（发消息触发回复）、`worldbook.list` / `worldbook.entries` / `worldbook.saveEntry` / `worldbook.removeEntry`（改世界书）、`presets.list` / `presets.use`（切预设）、`prompts.xray`（看提示词快照），外加 `stats.overview`。
两种省 token 的设计：

- **三种返回模式**：`summary`（只给 id + 标题，默认）/ `search`（按关键词过滤 + 片段）。
  `index`（标题 + 一句话概述 + 标签）。
- **破坏性操作二次确认**：没有 `confirm: true` 时只返回"这是要干什么"+ 让用户确认"，同意后再带 `confirm` 调一次。
  不落库（`isError: true`）。客户端把这句话给用户看，同意后再带 `confirm` 调一次。

装配点 HTTP 入口共用 `server/runtime.mjs`（`withComfy:false`：MCP 进程不连 ComfyUI）。

### 3.2 备份与维护
| 需求 | 怎么实现 |
|---|---|
| 一键全量备份 | `VACUUM INTO` 导出一致性快照（**不直接拷 .db** —— WAL 模式下直接复制会漏数据），和 `assets/` `cards/` 一起打成一个 zip，附 `manifest.json` |
| 一键恢复 | 把备份里的库 ATTACH 进来，按表整体搬进正在用的库（外键先关、搬完`foreign_key_check`）；表结构对不上就明确拒绝，不半搬一半。素材按备份镜像。恢复不用重启 |
| 自动备份 | 走同一个 `autoBackup(reason, kind)` 通道（`core/toolbox/service.mjs`）：启动时（`auto`）、恢复前（`pre-restore`）、清理前（`pre-cleanup`）、批量导入前（`pre-import`：角色卡 / 世界书 / 对话存档）、批量删除或清空前（`pre-delete`：删对话 / 清空向量）、数据库迁移前（`pre-migration`）。保留最近 N 份（`data.autoBackupKeep`）；同一秒内的备份名带毫秒 + 随机后缀，避免互相覆盖。只在这些节点做，/ 每轮对话这类高频路径不备份 |
| 定时任务 | `core/toolbox/scheduler.mjs` 管 什么时候该跑"，`server/scheduler.mjs` 的 `setInterval` 每分钟看一眼，任务清单和 上次跑的时间"落在 `app_meta`（`scheduler.tasks`）。重启不会把同一个时间点跑两遍；服务停机期间错过的，重启后补跑一次。动作有三种：备份 / 清理 / 给指定对话写小总结或大总结。只在 HTTP 入口创建（MCP stdio 进程不跑后台备份）。
|
| 数据维护 | 体检（孤立素材文件/ 缺文件的记录 / 失效向量 / 重复消息 / 空对话）：用户勾选 → 清理，清理前自动备份 |
| 数据统计 | 角色 / 对话 / 消息 / 字数 / 世界书条目/ 记忆 / 向量 / 素材占用 / 出图记录 / 记账轮数 |

### 3.2 创作辅助

三个技能放在 `core/agent/creative-skills.mjs`（和写卡技能同一个 JSON 协议、同一个技能注册表），
数据搬运与落库放在 `server/api/creative.mjs`。

| 需求 | 怎么实现 |
|---|---|
| 一段对话变小说章节 | `POST /api/creative/chat-to-chapter`：服务端把对话消息拼成 「角色：原文（跳过 只展示不发送 的系统消息），交给 技能`chapter.polish` ：返回标题 + 分段正文；界面上「变成章节」按钮弹出结果，可复制或下载 `.md` |
| 角色卡 → 世界书 → 剧本一条龙 | `POST /api/creative/card-to-script`：跑 `script.from_card` 得到 `worldbook[] + scenes[] + script`；`saveWorldbook: true` 时按卡建一本世界书并逐条 `saveEntry`（条目是酒馆形状，用 `keys` 触发）
|
| 素材抽取 | `POST /api/creative/extract-entities`：跑 `chat.extract_entities` 得到人物 / 地点 / 物品 / 关系；`entitiesToWorldbookEntries` 把 名字 + 别名 + 关键词合成触发键，默认存进该角色已有的生成世界书，没有就新建|

三个技能也会自动出现在「写卡助手」的技能列表里（新增了 `novel` 分类），
所以既能一键跑，也能在 Agent 多步模式里被模型自己调用。

有意偏离：dsh-tavern 的素材抽取是"从剧本抽设定建卡"的提示词，没有可移植的实现；
本项目按"对话 → 结构化条目 → 世界书条目»自己定了一版（见 `creative-skills.mjs` 顶注）。

### 3.2 插件机制

细节见 `docs/PLUGINS.md`，这里只说架构上怎么落的。

- `core/plugins.mjs` 是纯逻辑：manifest 校验、四种钩子的登记表（接口 / 技能/ MCP 工具 / 视图）。
 -   **不碰 `core/modules.mjs`** —— 插件的模块清单由 `/api/app` 追加，模块地图自身的校验不变。
- `server/plugins.mjs` 负责扫 `<数据目录>/plugins/`、`import` 入口、跑 `register(api)`。
  每个插件单独 try/catch：坏插件进 `errors` 列表并记一条警告，主服务照常启动。
- 装配点：HTTP 入口（`server/index.mjs`）把插件的接口注册进路由器、把结果挂到
  `ctx.app.plugins`；MCP stdio 入口把插件的工具塞进 MCP 工具表；技能直接进 agent 运行时。
- 插件视图是纯浏览器 ESM，由 `/api/plugins/<名字>/<文件>` 提供（只允许单层文件名）。
  前端启动时动态 `import` 并登记进视图注册表，主前端保持无构建。

### 3.2 多用户模式（给朋友用）
细节见 `docs/MULTI-USER.md`，这里说架构。

- **一个账号 = 一个完整数据目录* `<主机目录>/tenants/<账号>/`（各自的 SQLite / 素材 /
  备份 / `master.key`）。不像"同一张表+ owner_id 过滤"——那种做法漏一处就是串号。
- `server/host.mjs` 是主机层：一个进程一个网址，`/api/auth/*`（登录 / 会话）与
  `/api/host/*`（管理员）它自己处理；**其它 `/api/*` 要登录**，然后按会话挑出租户 →
  直接把 `req/res` 交给那个租户自己的 `createApp().handleRequest`。
- 为什么这么绕：各 api 模块是在 `registerApi` 注册时闭包捕获 `engine` / 存储的，
  所以 按请求换租户"不能换全局 engine，而是**每个租户各建一套**（`server/tenants.mjs`），
  现有功能模块一行不改，隔离也天然成立。
- 主机级的东西：插件（代码，`<主机目录>/plugins`，所有租户共享，接口在各自会话里执行）。
  账号表（`accounts.json`，只有 scrypt 口令哈希）、静态文件（同一份前端）。
- 管理员模块（`主机管理`）不写进 `core/modules.mjs`：它是 `/api/app` 在  "多用户"+ 管理员"时追加，跟插件模块一个路子；视图见 `web/views/host.mjs`。
- 加密导出：`server/backup-crypto.mjs`（`STBK1` + scrypt 盐 + AES-256-GCM），
  导出：先做普通全量备份 → 读出来加密 → 下载 `.stbk`"，导入走
  "解密 → `backupStore.adoptZip` 收进备份目录 → 走正常`restoreBackup`（照样先自动备份）。
- 单机模式**完全没变**：不带 `--multi-user` / `TAVERN_MULTI_USER` 时走原来的   `startTavern`，没有登录页、没有 `/api/auth`、也没有主机管理。

验证与安全：`tests/api-test.mjs` 里有 7 条多用户端到端用例（首次建号、两账号隔离、`/api/host/*` 权限、停用后会话失效、加密导出再导入、删账号确认 + purge）。**登录限速与
伪造 `x-forwarded-for`**），`work/verify-multiuser.mjs` 是照着 `docs/MULTI-USER.md`
那 7 条清单写的手动脚本（37 条断言）。安全细节单独写在 `docs/SECURITY.md`：口令哈希参数、会话令牌与 Cookie 属性、限速、跨账号隔离、路径与文件、破坏性操作、插件与卡内
前端的注入面，以及这一轮查出来并修掉的问题（备份恢复的越界写入、卡内前端宿主侧能力漏检查、MCP `--user` 未校验、畸形转成 500）。

## 还没做的工程部分

- ~~单文件 exe 打包~~（已落地：`npm run build:exe` = 自制打包器 → SEA blob（web/ 一起嵌进去）→
  postject 注入；验证过产物能起服务、页面从 exe 内部的资源里读。见 `scripts/build-exe.mjs`）。
- ~~多用户 / 权限~~（已落地 A 方案：一个网址 + 登录 + 每人一个数据目录 + 主机管理 +
  口令加密导出；见 `docs/MULTI-USER.md`。端到端用例 7 条、手动清单 37 条全绿，
  安全审计见 `docs/SECURITY.md`）。
- ~~卡内前端的沙箱实现~~（已落地：边界写在 `core/frontend/service.mjs` 的 `SANDBOX_POLICY`）。
- ~~卡内前端的主题保存与代码持久化~~（已落地：v9 的 `frontend_themes` / `frontend_snippets`）。
  界面在「卡内前端」；保存前先过 `validateCardFrontend`）。

