/**
 * 数据库结构。
 *
 * 每条迁移就是一组 SQL，写成数据放在这里，方便对照与审查。
 * 约定：
 *   - 时间一律存 ISO 字符串（TEXT），排序即时间序；
 *   - 复杂结构存 JSON 文本（TEXT），字段本身要查的才单独建列；
 *   - 布尔存 INTEGER 0/1（node:sqlite 不接受 JS 布尔值）；
 *   - 外键一律 ON DELETE CASCADE。
 */

export const SCHEMA_V1 = [
  // ---------- 平台 ----------
  `CREATE TABLE IF NOT EXISTS app_meta (
     key TEXT PRIMARY KEY,
     value TEXT
   )`,

  `CREATE TABLE IF NOT EXISTS settings (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS assets (
     id TEXT PRIMARY KEY,
     kind TEXT NOT NULL,
     name TEXT,
     mime TEXT,
     size INTEGER,
     sha256 TEXT,
     path TEXT NOT NULL,
     width INTEGER,
     height INTEGER,
     meta TEXT,
     created_at TEXT NOT NULL
   )`,

  `CREATE INDEX IF NOT EXISTS idx_assets_sha256 ON assets (sha256)`,
  `CREATE INDEX IF NOT EXISTS idx_assets_kind ON assets (kind)`,

  // ---------- 写卡区：角色卡 ----------
  `CREATE TABLE IF NOT EXISTS characters (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     spec_version TEXT NOT NULL DEFAULT 'v2',
     data TEXT NOT NULL,
     avatar_asset_id TEXT,
     source TEXT,
     favorite INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,

  `CREATE INDEX IF NOT EXISTS idx_characters_name ON characters (name)`,
  `CREATE INDEX IF NOT EXISTS idx_characters_updated ON characters (updated_at DESC)`,

  `CREATE TABLE IF NOT EXISTS character_tags (
     character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
     tag TEXT NOT NULL,
     PRIMARY KEY (character_id, tag)
   )`,

  `CREATE INDEX IF NOT EXISTS idx_character_tags_tag ON character_tags (tag)`,

  `CREATE TABLE IF NOT EXISTS character_versions (
     id TEXT PRIMARY KEY,
     character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
     data TEXT NOT NULL,
     note TEXT,
     created_at TEXT NOT NULL
   )`,

  `CREATE INDEX IF NOT EXISTS idx_character_versions_char ON character_versions (character_id, created_at DESC)`,

  // ---------- 写卡区：世界书 ----------
  `CREATE TABLE IF NOT EXISTS worldbooks (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     spec TEXT NOT NULL DEFAULT 'tavern',
     data TEXT,
     character_id TEXT REFERENCES characters(id) ON DELETE CASCADE,
     source TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,

  `CREATE INDEX IF NOT EXISTS idx_worldbooks_character ON worldbooks (character_id)`,

  `CREATE TABLE IF NOT EXISTS worldbook_entries (
     id TEXT PRIMARY KEY,
     worldbook_id TEXT NOT NULL REFERENCES worldbooks(id) ON DELETE CASCADE,
     uid TEXT,
     comment TEXT,
     content TEXT NOT NULL DEFAULT '',
     keys TEXT NOT NULL DEFAULT '[]',
     secondary_keys TEXT NOT NULL DEFAULT '[]',
     logic TEXT,
     constant INTEGER NOT NULL DEFAULT 0,
     position TEXT,
     depth INTEGER,
     order_index INTEGER NOT NULL DEFAULT 100,
     probability INTEGER,
     sticky INTEGER,
     cooldown INTEGER,
     delay INTEGER,
     group_name TEXT,
     group_weight INTEGER,
     ignore_budget INTEGER NOT NULL DEFAULT 0,
     match_sources TEXT,
     enabled INTEGER NOT NULL DEFAULT 1,
     semantic_threshold REAL,
     updated_at TEXT NOT NULL
   )`,

  `CREATE INDEX IF NOT EXISTS idx_worldbook_entries_book ON worldbook_entries (worldbook_id, order_index)`,

  // ---------- 写卡区：提示词 ----------
  `CREATE TABLE IF NOT EXISTS prompt_presets (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     kind TEXT NOT NULL DEFAULT 'chat',
     data TEXT NOT NULL,
     source TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS prompt_snippets (
     id TEXT PRIMARY KEY,
     title TEXT NOT NULL,
     body TEXT NOT NULL,
     tags TEXT NOT NULL DEFAULT '[]',
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS regex_scripts (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     scope TEXT NOT NULL DEFAULT 'global',
     owner_id TEXT,
     data TEXT NOT NULL,
     enabled INTEGER NOT NULL DEFAULT 1,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,

  // 提示词 X 光机：每轮真正发出去的提示词快照
  `CREATE TABLE IF NOT EXISTS prompt_xray (
     id TEXT PRIMARY KEY,
     chat_id TEXT,
     character_id TEXT,
     created_at TEXT NOT NULL,
     sections TEXT NOT NULL DEFAULT '[]',
     text TEXT NOT NULL DEFAULT '',
     tokens TEXT NOT NULL DEFAULT '{}',
     notes TEXT NOT NULL DEFAULT '[]',
     model TEXT
   )`,

  `CREATE INDEX IF NOT EXISTS idx_prompt_xray_chat ON prompt_xray (chat_id, created_at DESC)`,

  // ---------- 写卡区：记忆 ----------
  `CREATE TABLE IF NOT EXISTS memories (
     id TEXT PRIMARY KEY,
     chat_id TEXT,
     character_id TEXT,
     layer TEXT NOT NULL DEFAULT 'small',
     title TEXT,
     content TEXT NOT NULL,
     covers_from TEXT,
     covers_to TEXT,
     pinned INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,

  `CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories (chat_id, layer, created_at DESC)`,

  // ---------- 写卡区：向量 ----------
  `CREATE TABLE IF NOT EXISTS vector_items (
     id TEXT PRIMARY KEY,
     collection TEXT NOT NULL,
     source_id TEXT NOT NULL,
     chunk_index INTEGER NOT NULL DEFAULT 0,
     content TEXT NOT NULL,
     vector TEXT,
     model TEXT,
     dim INTEGER,
     content_hash TEXT,
     updated_at TEXT NOT NULL
   )`,

  `CREATE INDEX IF NOT EXISTS idx_vector_items_collection ON vector_items (collection, source_id)`,
  `CREATE INDEX IF NOT EXISTS idx_vector_items_hash ON vector_items (content_hash)`,
];

/**
 * v2：模型接入与绑定。
 *
 * providers        —— 一个具体的接入点（哪家、哪个模型、哪把钥匙）
 * model_bindings   —— 谁用哪个接入点。scope 决定优先级：
 *                     default < chat < character < chat_member
 *                     这样"男主一个模型、女主一个模型"就是两条 character 绑定。
 *                     target_id 用空串而不是 NULL，UNIQUE 才能生效。
 */
export const SCHEMA_V2 = [
  `CREATE TABLE IF NOT EXISTS providers (
     id TEXT PRIMARY KEY,
     label TEXT NOT NULL,
     kind TEXT NOT NULL DEFAULT 'chat',
     adapter TEXT NOT NULL DEFAULT 'openai',
     base_url TEXT,
     model TEXT,
     api_key TEXT,
     params TEXT,
     preset TEXT,
     enabled INTEGER NOT NULL DEFAULT 1,
     is_default INTEGER NOT NULL DEFAULT 0,
     last_test_at TEXT,
     last_test_ok INTEGER,
     last_test_error TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,

  `CREATE INDEX IF NOT EXISTS idx_providers_kind ON providers (kind, enabled)`,

  `CREATE TABLE IF NOT EXISTS model_bindings (
     id TEXT PRIMARY KEY,
     scope TEXT NOT NULL,
     target_id TEXT NOT NULL DEFAULT '',
     kind TEXT NOT NULL DEFAULT 'chat',
     provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
     model TEXT,
     params TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     UNIQUE (scope, target_id, kind)
   )`,

  `CREATE INDEX IF NOT EXISTS idx_model_bindings_lookup ON model_bindings (kind, scope, target_id)`,
];

/** v3：MCP 服务器（辅助写卡的外部工具来源）。 */
export const SCHEMA_V3 = [
  `CREATE TABLE IF NOT EXISTS mcp_servers (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     command TEXT NOT NULL,
     args TEXT NOT NULL DEFAULT '[]',
     env TEXT NOT NULL DEFAULT '{}',
     cwd TEXT,
     enabled INTEGER NOT NULL DEFAULT 1,
     auto_connect INTEGER NOT NULL DEFAULT 0,
     note TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
];

/**
 * v4：玩卡区。
 *
 * chats            —— 一个对话（单聊或群聊）。记忆、变量、状态都挂在对话上，
 *                     与模型无关，所以换模型 / 多模型共享同一份上下文。
 * chat_members     —— 在场的角色。单聊也有一条成员记录，群聊就是多条。
 *                     卡数据快照存在 member.card 里：写卡区的卡 CRUD 还没做，
 *                     玩卡区先能拿一张"当场贴进来的卡"开演，将来接上真实卡表也
 *                     不用改对话结构（character_id 指向卡表，card 只是快照）。
 * chat_messages    —— 消息。seq 单调递增，用于重排与插入；swipes 存重生成的候选。
 * chat_variables   —— 对话变量 / 角色变量。character_id 用空串而不是 NULL，
 *                     这样 UNIQUE 才对 NULL 之外的一切生效。
 * chat_snapshots   —— 状态快照，用于回滚。
 * chat_actions     —— 每轮的候选行动按钮。
 */
export const SCHEMA_V4 = [
  `CREATE TABLE IF NOT EXISTS chats (
     id TEXT PRIMARY KEY,
     title TEXT NOT NULL DEFAULT '新对话',
     character_id TEXT,
     persona TEXT NOT NULL DEFAULT '{}',
     settings TEXT NOT NULL DEFAULT '{}',
     world_state TEXT NOT NULL DEFAULT '{}',
     is_group INTEGER NOT NULL DEFAULT 0,
     group_strategy TEXT NOT NULL DEFAULT 'natural',
     group_mode TEXT NOT NULL DEFAULT 'swap',
     auto_mode_delay INTEGER NOT NULL DEFAULT 5,
     parent_chat_id TEXT REFERENCES chats(id) ON DELETE SET NULL,
     branch_from_message_id TEXT,
     branch_label TEXT,
     last_message_at TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,

  `CREATE INDEX IF NOT EXISTS idx_chats_updated ON chats (updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_chats_parent ON chats (parent_chat_id)`,

  `CREATE TABLE IF NOT EXISTS chat_members (
     id TEXT PRIMARY KEY,
     chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
     character_id TEXT,
     name TEXT NOT NULL,
     card TEXT NOT NULL DEFAULT '{}',
     talkativeness REAL NOT NULL DEFAULT 0.5,
     muted INTEGER NOT NULL DEFAULT 0,
     order_index INTEGER NOT NULL DEFAULT 0,
     overrides TEXT NOT NULL DEFAULT '{}',
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,

  `CREATE INDEX IF NOT EXISTS idx_chat_members_chat ON chat_members (chat_id, order_index)`,

  `CREATE TABLE IF NOT EXISTS chat_messages (
     id TEXT PRIMARY KEY,
     chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
     seq INTEGER NOT NULL,
     role TEXT NOT NULL,
     character_id TEXT,
     member_id TEXT,
     name TEXT,
     content TEXT NOT NULL DEFAULT '',
     hidden INTEGER NOT NULL DEFAULT 0,
     is_system INTEGER NOT NULL DEFAULT 0,
     swipes TEXT NOT NULL DEFAULT '[]',
     swipe_id INTEGER NOT NULL DEFAULT 0,
     tokens INTEGER,
     cost REAL,
     model TEXT,
     provider_id TEXT,
     extra TEXT NOT NULL DEFAULT '{}',
     created_at TEXT NOT NULL,
     UNIQUE (chat_id, seq)
   )`,

  `CREATE INDEX IF NOT EXISTS idx_chat_messages_chat ON chat_messages (chat_id, seq)`,

  `CREATE TABLE IF NOT EXISTS chat_variables (
     id TEXT PRIMARY KEY,
     chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
     character_id TEXT NOT NULL DEFAULT '',
     scope TEXT NOT NULL DEFAULT 'chat',
     key TEXT NOT NULL,
     value TEXT,
     label TEXT,
     updated_at TEXT NOT NULL,
     UNIQUE (chat_id, scope, character_id, key)
   )`,

  `CREATE INDEX IF NOT EXISTS idx_chat_variables_scope ON chat_variables (chat_id, scope)`,

  `CREATE TABLE IF NOT EXISTS chat_snapshots (
     id TEXT PRIMARY KEY,
     chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
     message_id TEXT,
     label TEXT,
     variables TEXT NOT NULL DEFAULT '{}',
     world_state TEXT NOT NULL DEFAULT '{}',
     created_at TEXT NOT NULL
   )`,

  `CREATE INDEX IF NOT EXISTS idx_chat_snapshots_chat ON chat_snapshots (chat_id, created_at DESC)`,

  `CREATE TABLE IF NOT EXISTS chat_actions (
     id TEXT PRIMARY KEY,
     chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
     message_id TEXT,
     options TEXT NOT NULL DEFAULT '[]',
     created_at TEXT NOT NULL
   )`,

  `CREATE INDEX IF NOT EXISTS idx_chat_actions_chat ON chat_actions (chat_id, created_at DESC)`,
];

/**
 * v5：让"野路子渠道"也能接。
 *   headers    —— 自定义请求头（JSON）。OpenRouter 的 HTTP-Referer/X-Title、
 *                 中转站要求的额外头，都从这里走。
 *   auth_style —— 密钥放哪：bearer / raw / api-key / x-api-key / x-goog-api-key / query / none。
 *   launcher   —— 本地代理进程（JSON）：CLI、反重力这类渠道先把它拉起来再调。
 *                 { command, args, env, cwd, host, port, timeoutMs }
 */
export const SCHEMA_V5 = [
  `ALTER TABLE providers ADD COLUMN headers TEXT`,
  `ALTER TABLE providers ADD COLUMN auth_style TEXT`,
  `ALTER TABLE providers ADD COLUMN launcher TEXT`,
];

/**
 * v6：工具箱 3.1 —— ComfyUI。
 *
 * comfy_workflows —— 用户在 ComfyUI 里搭好、导出 API 格式，再导进来的工作流。
 *                    workflow 存原样的节点表 JSON；bindings 是"哪些节点的哪个输入
 *                    是可填参数"，形状 [{nodeId,input,label,type,value}]，
 *                    type ∈ text | number | seed | boolean。
 *                    seed 是工作流级的固定种子，方便同一角色出一致的图。
 * comfy_runs      —— 每次出图的记录。chat_id / message_id 不设外键：
 *                    消息会被删、分支会被丢弃，但"这张图是哪次出的"应该留着。
 *                    prompt_id 是 ComfyUI 自己的 prompt_id，用它对进度。
 */
export const SCHEMA_V6 = [
  `CREATE TABLE IF NOT EXISTS comfy_workflows (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     kind TEXT NOT NULL DEFAULT 'custom',
     workflow TEXT NOT NULL,
     bindings TEXT NOT NULL DEFAULT '[]',
     seed INTEGER,
     note TEXT,
     enabled INTEGER NOT NULL DEFAULT 1,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,

  `CREATE INDEX IF NOT EXISTS idx_comfy_workflows_kind ON comfy_workflows (kind, enabled)`,

  `CREATE TABLE IF NOT EXISTS comfy_runs (
     id TEXT PRIMARY KEY,
     workflow_id TEXT,
     workflow_name TEXT,
     kind TEXT,
     chat_id TEXT,
     message_id TEXT,
     prompt_id TEXT,
     status TEXT NOT NULL DEFAULT 'queued',
     node_id TEXT,
     progress REAL,
     progress_max REAL,
     step_label TEXT,
     params TEXT NOT NULL DEFAULT '{}',
     images TEXT NOT NULL DEFAULT '[]',
     reason TEXT,
     error TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,

  `CREATE INDEX IF NOT EXISTS idx_comfy_runs_chat ON comfy_runs (chat_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_comfy_runs_status ON comfy_runs (status)`,
  `CREATE INDEX IF NOT EXISTS idx_comfy_runs_prompt ON comfy_runs (prompt_id)`,
];

/**
 * v7：工具箱 3.2 —— 花费与统计。
 *
 * usage_log —— 每一轮的用量。以前只把 token / 花费挂在消息上，问题是：
 *   删掉消息、重生成、分支都会把统计一起弄丢，而且按角色 / 按天汇总没法做。
 *   所以每个回合单独记一条，消息只是"顺带带上"，统计不再依赖消息是否还在。
 *   字段说明：
 *     prompt_tokens / completion_tokens / total_tokens —— 提供方上报的真实用量
 *     est_prompt_tokens / est_completion_tokens       —— 我们的启发式估算，用来做"预估 vs 实际"
 *     cached_tokens  —— 提供方上报的缓存命中 token（没上报就是 0）
 *     cost           —— 按当时单价算出的钱；单价没配就是 NULL（界面显示"未配置单价"）
 *     cache_savings  —— 缓存命中省下的钱
 *     reported       —— 1 表示这一轮的 token 是提供方真报的，0 表示只有我们的估算
 *                       （界面上要能区分"花了多少"和"我们猜花了多少"）
 * pricing —— 各家单价。provider_id + model 命中时覆盖提供方自带的 priceIn / priceOut；
 *   都为空串表示"这家所有模型的默认价"。cache_discount 表示缓存命中价相对正常输入价的折扣率
 *   （0.1 = 缓存只要一折，省下九成）。
 */
export const SCHEMA_V7 = [
  `CREATE TABLE IF NOT EXISTS usage_log (
     id TEXT PRIMARY KEY,
     chat_id TEXT,
     character_id TEXT,
     member_id TEXT,
     provider_id TEXT,
     model TEXT,
     kind TEXT,
     source TEXT,
     prompt_tokens INTEGER NOT NULL DEFAULT 0,
     completion_tokens INTEGER NOT NULL DEFAULT 0,
     total_tokens INTEGER NOT NULL DEFAULT 0,
     cached_tokens INTEGER NOT NULL DEFAULT 0,
     est_prompt_tokens INTEGER NOT NULL DEFAULT 0,
     est_completion_tokens INTEGER NOT NULL DEFAULT 0,
     price_in REAL,
     price_out REAL,
     cost REAL,
     cache_savings REAL,
     reported INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL
   )`,

  `CREATE INDEX IF NOT EXISTS idx_usage_created ON usage_log (created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_usage_chat ON usage_log (chat_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_usage_character ON usage_log (character_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_usage_provider ON usage_log (provider_id, model)`,

  `CREATE TABLE IF NOT EXISTS pricing (
     id TEXT PRIMARY KEY,
     provider_id TEXT NOT NULL DEFAULT '',
     model TEXT NOT NULL DEFAULT '',
     label TEXT,
     currency TEXT NOT NULL DEFAULT 'CNY',
     price_in REAL,
     price_out REAL,
     cache_discount REAL NOT NULL DEFAULT 0.1,
     updated_at TEXT NOT NULL,
     UNIQUE (provider_id, model)
   )`,
];

/**
 * v8（工具箱 3.1 加分项）：角色 → 出图绑定。
 * 给一个角色固定工作流与 LoRA 触发词，再绑一组表情差分图（对话里按情绪自动换）。
 */
export const SCHEMA_V8 = [
  `CREATE TABLE IF NOT EXISTS comfy_character_bindings (
     character_id TEXT PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
     workflow_id TEXT,
     lora_text TEXT,
     expressions TEXT,
     note TEXT,
     updated_at TEXT NOT NULL
   )`,
];

/**
 * v9（卡内前端剩余部分）：自定义主题与卡内前端代码的持久化。
 * 主题是全局的（跟软件走）；代码片段按 scope（角色卡 / 对话 / global）存。
 */
export const SCHEMA_V9 = [
  `CREATE TABLE IF NOT EXISTS frontend_themes (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     tokens TEXT NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS frontend_snippets (
     id TEXT PRIMARY KEY,
     scope TEXT NOT NULL DEFAULT '',
     name TEXT NOT NULL,
     html TEXT NOT NULL DEFAULT '',
     css TEXT NOT NULL DEFAULT '',
     js TEXT NOT NULL DEFAULT '',
     capabilities TEXT NOT NULL DEFAULT '[]',
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_frontend_snippets_scope ON frontend_snippets (scope, updated_at DESC)`,
];

/**
 * v10（卡内前端信任）：只存"我信任过这张卡的**这段代码**"。
 *
 * 为什么不放进卡数据：卡数据会跟着 PNG / JSON 导出走，放进去等于让卡自己声明"请信任我"。
 * 所以单独一张表，而且**绑代码哈希** —— 代码一改（更新卡、重新导入）就对不上，
 * 自动退回"未信任、要你点一下"。
 */
export const SCHEMA_V10 = [
  `CREATE TABLE IF NOT EXISTS card_frontend_trust (
     character_id TEXT PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
     code_hash TEXT NOT NULL,
     granted_at TEXT NOT NULL
   )`,
];

/**
 * v11（参考资料 + 检索增强）：
 *
 * 1) reference_docs —— 「参考资料」的**原文**。
 *    以前 databank 集合里的片段只存在 vector_items 里，等于没有源：重建索引就把它
 *    清没了（维护页里那句"databank 是自由参考素材，没法校验"就是这个缺口）。
 *    现在原文进这张表，向量只是它的衍生物，随时能重建。
 *
 * 2) vector_item_meta —— 每个片段的附加信息（时间戳、来源标题等）。
 *    检索要按"新鲜度"衰减、要按来源去重、界面要显示"这段是哪来的"，都得靠它。
 *    单独一张表而不是给 vector_items 加列：SQLite 的 ALTER TABLE ADD COLUMN
 *    没有 IF NOT EXISTS，重复执行会报 duplicate column。迁移必须是可重放的
 *    （中途失败、或记录丢了再跑一次，都得能过），所以这里只用 CREATE TABLE。
 */
export const SCHEMA_V11 = [
  `CREATE TABLE IF NOT EXISTS reference_docs (
     id TEXT PRIMARY KEY,
     title TEXT NOT NULL,
     source TEXT NOT NULL DEFAULT '',
     content TEXT NOT NULL,
     tags TEXT NOT NULL DEFAULT '[]',
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,

  `CREATE INDEX IF NOT EXISTS idx_reference_docs_updated ON reference_docs (updated_at DESC)`,

  `CREATE TABLE IF NOT EXISTS vector_item_meta (
     item_id TEXT PRIMARY KEY,
     meta TEXT
   )`,
];

/**
 * SCHEMA_V12 —— 玩卡与写卡工坊（studio）用到的五张表。
 *
 * 1) author_notes —— 临场指令（作者注）的三层作用域。
 *    scope = default / character / chat，scope_id 对 default 为空串。
 *    用复合主键，一层一条，覆盖式写入。
 *
 * 2) sampler_profiles —— 采样器顺序与开关（文本补全后端专用）。
 *    参数值本身跟着提供方走，这里只存"顺序 + 开哪几个 + 预设名"。
 *
 * 3) loadouts —— 套装：把玩法需要的一切打包，应用时可只应用其中一部分。
 *
 * 4) proxy_presets —— 反向代理预设（地址 + 密钥），与提供方解耦，可存多套。
 *
 * 5) connection_profiles —— 连接档案：把一批连接相关设置打包，用于快速切换。
 *    存的是"哪些键被排除 + 这些键当时的取值"，所以能用排除法交互。
 *
 * 全部只用 CREATE TABLE IF NOT EXISTS，保证迁移可重放。
 */
export const SCHEMA_V12 = [
  `CREATE TABLE IF NOT EXISTS author_notes (
     scope TEXT NOT NULL,
     scope_id TEXT NOT NULL DEFAULT '',
     payload TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     PRIMARY KEY (scope, scope_id)
   )`,

  `CREATE TABLE IF NOT EXISTS sampler_profiles (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     backend TEXT NOT NULL,
     payload TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,

  `CREATE INDEX IF NOT EXISTS idx_sampler_profiles_backend ON sampler_profiles (backend)`,

  `CREATE TABLE IF NOT EXISTS loadouts (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     payload TEXT NOT NULL,
     favorite INTEGER NOT NULL DEFAULT 0,
     last_used_at TEXT,
     created_at TEXT NOT NULL
   )`,

  `CREATE INDEX IF NOT EXISTS idx_loadouts_used ON loadouts (last_used_at DESC)`,

  `CREATE TABLE IF NOT EXISTS proxy_presets (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     provider_kind TEXT NOT NULL DEFAULT 'chat',
     payload TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS connection_profiles (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     payload TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
];

/**
 * SCHEMA_V13 —— 玩卡体验与素材补强。
 *
 * 1) message_bookmarks —— 消息书签：轻量标记 + 备注，随时跳回。
 * 2) action_sets —— 动作序列（快速回复）：一串可复用的操作。
 * 3) logit_presets —— Logit Bias 预设，可导入导出。
 * 4) asset_thumbnails —— 缩略图。素材库原来直接用原图靠 CSS 缩，几百张就卡；
 *    这里按 asset_id 存一份小图（浏览器端 canvas 生成，零依赖）。
 *
 * 同样只用 CREATE TABLE IF NOT EXISTS，保证迁移可重放。
 */
export const SCHEMA_V13 = [
  `CREATE TABLE IF NOT EXISTS message_bookmarks (
     id TEXT PRIMARY KEY,
     chat_id TEXT NOT NULL,
     message_id TEXT NOT NULL,
     payload TEXT NOT NULL,
     created_at TEXT NOT NULL
   )`,

  `CREATE INDEX IF NOT EXISTS idx_message_bookmarks_chat ON message_bookmarks (chat_id, created_at DESC)`,

  `CREATE UNIQUE INDEX IF NOT EXISTS idx_message_bookmarks_unique ON message_bookmarks (chat_id, message_id)`,

  `CREATE TABLE IF NOT EXISTS action_sets (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     payload TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS logit_presets (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     payload TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS asset_thumbnails (
     asset_id TEXT PRIMARY KEY,
     mime TEXT NOT NULL,
     bytes BLOB NOT NULL,
     width INTEGER,
     height INTEGER,
     created_at TEXT NOT NULL
   )`,

  // 自定义请求体：单独一张表，避免给 providers 加列（ALTER TABLE 没有 IF NOT EXISTS，
  // 迁移必须可重放，所以宁可用新表）。
  `CREATE TABLE IF NOT EXISTS provider_extra (
     provider_id TEXT PRIMARY KEY,
     extra_body TEXT NOT NULL DEFAULT '{}',
     updated_at TEXT NOT NULL
   )`,
];

/**
 * SCHEMA_V14 —— **模块（Mod）**：一句话说明 + 提示词 + 可选 CSS / HTML / JS。
 *
 * 为什么另起一张表而不是给 prompt_snippets 加列：跟 provider_extra 同一个道理——
 * `ALTER TABLE ADD COLUMN` 没有 `IF NOT EXISTS`，迁移就没法重放（老库重跑一次直接
 * "duplicate column name" 炸掉），而迁移规则要求可重放。`prompt_snippets` 那张表
 * 从 V9 起就没人用（既没界面也没接组装），留它在那儿不动最省事。
 *
 * module_trust 单独一张表：信任**绑在代码哈希上**（跟卡内前端一个路子），
 * 而且不能存在模块自己身上——模块会被导出/分享，信任跟着走就等于让别人替你点头。
 */
export const SCHEMA_V14 = [
  `CREATE TABLE IF NOT EXISTS modules (
     id TEXT PRIMARY KEY,
     title TEXT NOT NULL,
     description TEXT NOT NULL DEFAULT '',
     body TEXT NOT NULL DEFAULT '',
     css TEXT NOT NULL DEFAULT '',
     html TEXT NOT NULL DEFAULT '',
     js TEXT NOT NULL DEFAULT '',
     capabilities TEXT NOT NULL DEFAULT '[]',
     position TEXT NOT NULL DEFAULT 'after-history',
     source TEXT NOT NULL DEFAULT 'original',
     tags TEXT NOT NULL DEFAULT '[]',
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS module_trust (
     module_id TEXT PRIMARY KEY,
     code_hash TEXT NOT NULL,
     granted_at TEXT NOT NULL
   )`,
];

/**
 * V15：模块的另外三样 —— 世界书条目 / 正则脚本 / 背景图。
 *
 * 为什么不给 modules 加列：迁移要求可重放（老库上再跑一遍不能炸），而 ALTER TABLE
 * 没有 IF NOT EXISTS，加列必然在某天变成 "duplicate column name"。这里换成一张
 * (module_id, kind) 的表，以后模块再长出新零件也只是多一个 kind，不用再动表结构。
 *
 * payload 一律存 JSON 文本：世界书条目是一个数组、正则脚本是一个数组、背景图是一个
 * 素材 id（字符串）。
 */
export const SCHEMA_V15 = [
  `CREATE TABLE IF NOT EXISTS module_parts (
     module_id TEXT NOT NULL,
     kind TEXT NOT NULL,
     payload TEXT NOT NULL DEFAULT '',
     updated_at TEXT NOT NULL,
     PRIMARY KEY (module_id, kind)
   )`,
];

/**
 * V16：提供方的「参数覆盖表」。
 *
 * 为什么需要：各家模型换代时会**扔参数、加参数**（例：Gemini 3 系列把思考预算换成了
 * thinking_level，TopK/seed 这类也不在 OpenAI 风格的那套里）。适配器表是按"协议"写的，
 * 分辨率到不了单个模型 —— 所以每家提供方自己存一层覆盖：
 *   disabled  这家的模型不认的已知参数（界面不显示，**预设带来的也一起丢掉**）
 *   custom    这家的专属参数（名字 / 类型 / 放哪个路径，例如 generationConfig.thinkingConfig.thinkingLevel）
 * 同样按"加新表"的规矩来，不给 providers 加列（ALTER TABLE 没法重放）。
 */
export const SCHEMA_V16 = [
  `CREATE TABLE IF NOT EXISTS provider_param_overrides (
     provider_id TEXT PRIMARY KEY,
     disabled TEXT NOT NULL DEFAULT '[]',
     custom TEXT NOT NULL DEFAULT '[]',
     updated_at TEXT NOT NULL
   )`,
];

/**
 * V17：ComfyUI 的「LoRA 组合」。
 *
 * 为什么要存组合：ComfyUI 的 LoRA 不是请求参数，是要**插进工作流的节点**
 * （见 core/toolbox/comfy.mjs 的 applyLoras）。一次通常要叠好几个（角色 + 画风 + 动作），
 * 来回手填太烦，所以把"选中的 LoRA + 权重 + 触发词"存成一套，出图时选一套就行。
 * 照旧按"加新表"的规矩来 —— 不给 comfy_* 加列（ALTER TABLE 没法重放）。
 */
export const SCHEMA_V17 = [
  `CREATE TABLE IF NOT EXISTS comfy_lora_sets (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     loras TEXT NOT NULL DEFAULT '[]',
     note TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
];

/**
 * V18：角色的「衣柜」。
 *
 * 一个角色配多套衣服（每套一段提示词 + 可选负向词），出图时按"当前这套"接进提示词；
 * 另外存一条角色专属负面词（"这个角色永远不要出现什么"）。
 * 为什么单独一张表：comfy_character_bindings 已经定下来了，加列没法重放（ALTER 没有 IF NOT EXISTS）。
 */
export const SCHEMA_V18 = [
  `CREATE TABLE IF NOT EXISTS comfy_outfits (
     character_id TEXT PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
     outfits TEXT NOT NULL DEFAULT '[]',
     active_id TEXT,
     negative TEXT,
     updated_at TEXT NOT NULL
   )`,
];
