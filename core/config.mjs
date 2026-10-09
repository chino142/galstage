/**
 * 设置项 schema。
 *
 * 唯一真相在这里：默认值、类型、界面分组、说明都写在这张表上，
 * 前端设置页由它自动生成，服务端保存前用它校验。
 * 带 hidden: true 的项不进设置页（用户平时不用手改，比如界面自己记的状态）。
 * 各功能自己的设置（模型、采样参数之类）等该功能落地时再加。
 */

import { ValidationError } from './errors.mjs';

export const SETTINGS_SCHEMA = [
  {
    key: 'ui.theme',
    type: 'enum',
    options: ['system', 'light', 'dark', 'sepia'],
    default: 'system',
    group: '界面',
    label: '主题',
    help: '跟随系统，或强制亮色 / 暗色 / 护眼（暖色）。',
  },
  {
    key: 'ui.customCss',
    type: 'string',
    default: '',
    group: '界面',
    label: '自定义 CSS',
    help: '一串 CSS，会注入到界面末尾。想改什么外观又不想等主题支持时用；写坏了删掉即可。',
  },
  {
    key: 'ui.backgroundGallery',
    type: 'string',
    default: '[]',
    group: '界面',
    label: '背景图库',
    help: 'JSON：{ "地点名": "素材 id" }。演出层按当前场景的地点自动换背景。',
  },
  {
    key: 'net.proxy',
    type: 'string',
    default: '',
    group: '模型接入',
    label: '网络代理',
    help: '形如 http://127.0.0.1:7890 或 http://用户:密码@主机:端口。留空表示直连。只支持 HTTP 代理。',
  },
  {
    key: 'vision.captionTemplate',
    type: 'string',
    default: '[{{user}} 发给 {{char}} 一张图片，内容是：{{caption}}]',
    group: '玩卡',
    label: '图片描述模板',
    help: '不能看图的模型走这条路：先把图片转成文字，再按这个模板塞进对话。',
  },
  {
    key: 'vision.captionProviderId',
    type: 'string',
    default: '',
    group: '玩卡',
    label: '看图用的提供方',
    help: '填一个支持视觉的提供方 id。留空表示不自动转文字（那就不发图）。',
  },
  {
    key: 'vision.autoCaption',
    type: 'boolean',
    default: true,
    group: '玩卡',
    label: '自动转文字',
    help: '当前模型不能看图时，自动用上面那个提供方把图转成文字。关掉就只支持视觉的模型才发图。',
  },
  {
    key: 'translate.target',
    type: 'enum',
    options: ['zh-CN', 'zh-TW', 'en', 'ja', 'ko', 'ru'],
    default: 'zh-CN',
    group: '玩卡',
    label: '翻译目标语言',
    help: '聊天翻译用哪种语言。',
  },
  {
    key: 'translate.auto',
    type: 'boolean',
    default: false,
    group: '玩卡',
    label: '自动翻译',
    help: '每条新回复生成后自动翻一遍（只改显示，不动实际内容）。',
  },
  {
    key: 'translate.onlyForeign',
    type: 'boolean',
    default: true,
    group: '玩卡',
    label: '只翻外语',
    help: '开着就跳过"看起来已经是目标语言"的回复，免得中文再翻一遍。',
  },
  {
    key: 'translate.intoContext',
    type: 'boolean',
    default: false,
    group: '玩卡',
    label: '译文进上下文',
    help: '默认只改显示。打开后会把译文也发给模型（一般用不着）。',
  },
  {
    key: 'ui.language',
    type: 'enum',
    options: ['zh-CN', 'en'],
    default: 'zh-CN',
    group: '界面',
    label: '语言',
    help: '界面语言。',
  },
  {
    key: 'ui.density',
    type: 'enum',
    options: ['comfortable', 'compact'],
    default: 'comfortable',
    group: '界面',
    label: '信息密度',
    help: '紧凑模式会缩小行高与间距。',
  },
  {
    key: 'ui.fontScale',
    type: 'number',
    minimum: 0.8,
    maximum: 1.6,
    default: 1,
    group: '界面',
    label: '字体缩放',
    help: '0.8 ~ 1.6。',
  },
  {
    key: 'ui.accent',
    type: 'string',
    default: '#a78bfa',
    group: '界面',
    label: '强调色',
    help: '十六进制颜色值。',
  },
  {
    key: 'ui.layout',
    type: 'enum',
    options: ['auto', 'two-column', 'single'],
    default: 'auto',
    group: '界面',
    label: '布局',
    help: 'auto：宽屏双栏、窄屏单栏；two-column：始终显示侧边导航；single：侧边导航收起来（顶栏按钮展开）。',
  },
  {
    key: 'ui.navWidth',
    type: 'number',
    minimum: 160,
    maximum: 420,
    default: 220,
    group: '界面',
    label: '侧栏宽度',
    help: '160 ~ 420。也可以直接拖侧栏右边的把手。',
  },
  {
    key: 'ui.playWidth',
    type: 'number',
    minimum: 50,
    maximum: 100,
    default: 78,
    group: '界面',
    label: '玩卡区宽度（占屏幕百分比）',
    help: '50 ~ 100。写卡区固定 1080px（文字好读），玩卡区按这个百分比铺开 —— '
      + '像酒馆那个"聊天宽度"滑条一样，卡面 / 立绘 / 消息区都能跟着变宽。100 = 铺满整屏。',
  },
  {
    key: 'ui.notifySound',
    type: 'boolean',
    default: false,
    group: '界面',
    label: '生成完成后响一下',
    help: '一轮生成跑完时播一声轻响（不需要任何音频文件）。',
  },
  {
    key: 'ui.notifyBrowser',
    type: 'boolean',
    default: false,
    group: '界面',
    label: '生成完成后弹系统通知',
    help: '需要浏览器授权：打开这个开关时请求一次，被拒绝就不会再反复弹。',
  },
  {
    key: 'ui.lowfx',
    type: 'boolean',
    default: false,
    group: '界面',
    label: '低配模式（关掉毛玻璃和背景动画）',
    help: '切换界面觉得卡、或者浏览器没开显卡加速时打开：面板换成不透明底色、背景光斑停住、不再播切换淡入。',
  },
  {
    key: 'ui.writingFolds',
    type: 'string',
    default: '{}',
    hidden: true,
    group: '界面',
    label: '写卡区收起来的板块',
    help: 'JSON：{ "板块 id": true }。写卡区里哪几块是折起来的，点折叠栏时自动记下来，不用手改。',
  },
  // ---------- 召回（每轮对话时"想起来"什么）----------
  {
    key: 'recall.enabled',
    type: 'boolean',
    default: true,
    group: '召回',
    label: '每轮自动召回相关片段',
    help: '开：每次回复前，按当前说的话去检索世界书 / 参考资料 / 历史对话 / 记忆，把相关的塞进提示词。关：只注入"最近 + 钉住"那几条。',
  },
  {
    key: 'recall.topK',
    type: 'number',
    minimum: 1,
    maximum: 50,
    default: 8,
    group: '召回',
    label: '每轮最多召回几段',
    help: '1 ~ 50。召回的内容会占上下文，太多会挤掉正文。',
  },
  {
    key: 'recall.maxChars',
    type: 'number',
    minimum: 200,
    maximum: 20000,
    default: 1500,
    group: '召回',
    label: '召回内容的总字数上限',
    help: '超过就按得分从高到低截断。',
  },
  {
    key: 'recall.minScore',
    type: 'number',
    minimum: 0,
    maximum: 1,
    default: 0.1,
    group: '召回',
    label: '最低相关度',
    help: '低于这个分的片段不要。调高 = 宁可少给也不给不相关的；调低 = 多给一点。',
  },
  // ---- 对话的"历史窗口 / 上下文 / 自动总结"（对话页 ⚙ 对话配置 里能按对话覆盖）----
  {
    key: 'chat.historyLimit',
    type: 'number',
    minimum: 4,
    maximum: 400,
    default: 60,
    group: '对话',
    label: '历史窗口（条）',
    help: '每轮带多少条**最近的原文**进去（你和 AI 各算 1 条，所以 60 条 = 30 轮）。'
      + '注意：这跟"记忆 / 总结"不是一回事 —— 总结是另一层（小总结 / 大总结 / 结构化档案）+ 相关性召回。',
  },
  {
    key: 'chat.contextBudget',
    type: 'number',
    minimum: 0,
    maximum: 200000,
    default: 0,
    group: '对话',
    label: '上下文预算（token，0 = 不裁）',
    help: '超过这个预算就从最老的开始裁。填 0 表示不按预算裁，只按上面的条数。',
  },
  {
    key: 'chat.autoSummary',
    type: 'boolean',
    default: true,
    group: '对话',
    label: '自动总结（事件驱动）',
    help: '每轮回答完顺手看一眼"积压了多少条没被总结的消息"，够多就**顺手续一条小总结**。'
      + '这样不用按时间调度：不玩就没新消息、不需要总结；玩的时候进程一定开着，不会错过。',
  },
  {
    key: 'chat.autoSummaryEvery',
    type: 'number',
    minimum: 4,
    maximum: 200,
    default: 20,
    group: '对话',
    label: '积压多少条就自动总结一次',
    help: '默认 20 条。调小 = 总结更勤（更花 token）；调大 = 省一点，但原文窗口一小就更容易丢细节。',
  },
  {
    key: 'recall.historyWindow',
    type: 'number',
    minimum: 0,
    maximum: 20,
    default: 4,
    group: '召回',
    label: '拿最近几条消息当检索词',
    help: '当前输入 + 最近这几条消息一起组成查询，这样"它/那个"也能指回上文。',
  },
  {
    key: 'recall.worldbook',
    type: 'boolean',
    default: false,
    group: '召回',
    label: '从世界书召回',
    help: '默认关：世界书本来就有语义触发（写卡区 → 世界书），两边都开会让同一段进两次。想改成走统一召回就打开它。',
  },
  {
    key: 'recall.databank',
    type: 'boolean',
    default: true,
    group: '召回',
    label: '从参考资料召回',
    help: '参考资料在「写卡区 → 记忆 → 向量与检索」里导入。',
  },
  {
    key: 'recall.history',
    type: 'boolean',
    default: true,
    group: '召回',
    label: '从历史对话召回',
    help: '很久以前聊过、但已经滑出上下文窗口的内容。',
  },
  {
    key: 'recall.memory',
    type: 'boolean',
    default: true,
    group: '召回',
    label: '从记忆条目召回',
    help: '按相关性把旧的小总结 / 大总结 / 结构化档案补进来。',
  },
  {
    key: 'recall.memoryTop',
    type: 'number',
    minimum: 0,
    maximum: 10,
    default: 2,
    group: '召回',
    label: '记忆额外召回几条',
    help: '在"最近 3 条小总结 + 最新 1 条大总结"之外，再按相关性补几条。',
  },
  {
    key: 'recall.memorySmall',
    type: 'number',
    minimum: 0,
    maximum: 50,
    default: 3,
    group: '召回',
    label: '固定带上最近几条小总结',
    help: '保证"最近发生了什么"始终在，不受相关性检索影响。',
  },
  {
    key: 'recall.includeProfile',
    type: 'boolean',
    default: true,
    group: '召回',
    label: '结构化档案参与召回',
    help: '人物 / 事件 / 物品 / 地点表。以前这类条目写了"按需检索"却从来没进过提示词。',
  },
  {
    key: 'recall.decay',
    type: 'boolean',
    default: true,
    group: '召回',
    label: '历史与记忆按新鲜度衰减',
    help: '越久远的越不容易被召回（7 天半衰期）。世界书和参考资料不打折。',
  },
  {
    key: 'recall.diversify',
    type: 'boolean',
    default: true,
    group: '召回',
    label: '召回结果去重（多样性）',
    help: '避免十段都是同一段话的复述。',
  },
  {
    key: 'recall.rewrite',
    type: 'boolean',
    default: false,
    group: '召回',
    label: '用模型改写检索词',
    help: '每轮多调一次模型，把当前对话提炼成几条检索词，召回更准但更慢更贵。默认关。',
  },
  {
    key: 'recall.keywordWeight',
    type: 'number',
    minimum: 0,
    maximum: 1,
    default: 0.5,
    group: '召回',
    label: '关键词与语义的配比',
    help: '0 = 只看语义（需要嵌入模型），1 = 只看关键词。0.5 是各占一半。',
  },
  {
    key: 'recall.perCollection',
    type: 'number',
    minimum: 0,
    maximum: 20,
    default: 0,
    group: '召回',
    label: '同一份资料最多取几段',
    help: '0 = 不限制。设成 2 可以防止一整本资料把上下文吃光。',
  },
  {
    key: 'recall.maxScan',
    type: 'number',
    minimum: 500,
    maximum: 50000,
    default: 20000,
    group: '召回',
    label: '每次最多扫多少条片段',
    help: '内置检索是全表扫一遍算相似度。库很大时调低能更快，但可能漏掉排得靠后的；几十万条建议改用外部向量库（见下面「向量库」）。',
  },
  // ---------- 外部向量库（可选）----------
  {
    key: 'vector.backend',
    type: 'enum',
    options: ['builtin', 'qdrant'],
    default: 'builtin',
    group: '向量库',
    label: '向量检索后端',
    help: 'builtin：内置暴力余弦，零依赖，几千条以内够用。qdrant：外部向量库，几十万条也不会慢；连不上会自动回退内置。',
  },
  {
    key: 'vector.url',
    type: 'string',
    default: '',
    group: '向量库',
    label: 'Qdrant 地址',
    help: '例如 http://127.0.0.1:6333（本机 Docker 起一个就填这个）。',
  },
  {
    key: 'vector.collection',
    type: 'string',
    default: 'silver_tavern',
    group: '向量库',
    label: 'Qdrant 集合名',
    help: '留空用 silver_tavern。多个数据目录共用一个 Qdrant 时，建议各自取不同名字。',
  },
  {
    key: 'vector.apiKey',
    type: 'string',
    default: '',
    group: '向量库',
    label: 'Qdrant API Key',
    help: '本地 Qdrant 一般不用填。注意：这一项是明文存在本地数据库里的，别在这里填公网服务的重要密钥。',
  },
  // 快捷键（蓝图 3.2「使用体验」）：值是组合键写法，比如 Enter / Ctrl+Enter / Alt+R。
  // 留空表示不绑定。命令面板固定 Ctrl/Cmd+K，不在这里改。
  { key: 'ui.shortcut.send', type: 'string', default: 'Enter', group: '快捷键', label: '发送', help: '在输入框里按这个键发送；Shift+Enter 始终是换行。' },
  { key: 'ui.shortcut.continue', type: 'string', default: 'Ctrl+Enter', group: '快捷键', label: '继续', help: '让 AI 接着写。' },
  { key: 'ui.shortcut.regenerate', type: 'string', default: 'Alt+R', group: '快捷键', label: '重新生成', help: '重跑最后一轮。' },
  { key: 'ui.shortcut.switchCharacter', type: 'string', default: 'Alt+C', group: '快捷键', label: '切换角色 / 对话', help: '切到列表里的下一个对话。' },
  { key: 'ui.shortcut.search', type: 'string', default: 'Alt+S', group: '快捷键', label: '搜索', help: '聚焦对话搜索框。' },
  {
    key: 'logging.level',
    type: 'enum',
    options: ['silent', 'error', 'info', 'debug'],
    default: 'info',
    group: '数据',
    label: '日志级别',
    help: '调试模型请求时改成 debug。',
  },
  {
    key: 'data.keepPromptXray',
    type: 'boolean',
    default: true,
    group: '数据',
    label: '保存提示词快照',
    help: '关闭后不再为每轮保存完整提示词，省空间。',
  },
  {
    key: 'data.keepPromptXrayLimit',
    type: 'number',
    minimum: 0,
    maximum: 100000,
    default: 2000,
    group: '数据',
    label: '提示词快照保留条数',
    help: '0 表示不限制。',
  },
  {
    key: 'comfy.enabled',
    type: 'boolean',
    default: false,
    group: '工具箱',
    label: '启用 ComfyUI 出图',
    help: '打开后聊天里才能触发出图；关掉时界面会提示"ComfyUI 未启动"并禁用按钮。',
  },
  {
    key: 'comfy.executionMode',
    type: 'enum',
    options: ['server', 'client'],
    default: 'server',
    group: '工具箱',
    label: 'ComfyUI 连接方式',
    help:
      'server：主机进程去连下面这个地址（这个地址由服务器访问；多用户模式下等于"主机要能连到它"，填内网地址会让主机网络被探测）。' +
      'client：你自己这台机器的浏览器直接连 ComfyUI，主机不向这个地址发任何请求（需要 ComfyUI 以 --enable-cors-header 启动）。多用户模式默认 client。',
  },
  {
    key: 'comfy.baseUrl',
    type: 'string',
    default: 'http://127.0.0.1:8188',
    group: '工具箱',
    label: 'ComfyUI 地址',
    help: '本地一般是 http://127.0.0.1:8188；也能填局域网 / 远程地址。server 模式下这个地址由服务器访问，client 模式下由浏览器访问。',
  },
  {
    key: 'comfy.trigger',
    type: 'enum',
    options: ['manual', 'marker', 'auto'],
    default: 'manual',
    group: '工具箱',
    label: '出图触发方式',
    help: 'manual 只能手动点；marker 是回复里出现 [IMG: ...] 就出图；auto 是检测到场景变化就出图。',
  },
  {
    key: 'comfy.marker',
    type: 'string',
    default: '[IMG:',
    group: '工具箱',
    label: '出图标记',
    help: '半自动触发时，AI 回复里出现这个标记就出图（写成 [IMG: 提示词]）。',
  },
  {
    key: 'comfy.timeoutMs',
    type: 'number',
    minimum: 1000,
    maximum: 300000,
    default: 10000,
    group: '工具箱',
    label: 'ComfyUI 请求超时（毫秒）',
    help: '连不上时多久放弃并给出原因。生成本身不受这个限制。',
  },
  {
    key: 'comfy.autoStart',
    type: 'boolean',
    default: false,
    group: '工具箱',
    label: '出图前自动拉起 ComfyUI',
    help: '打开后：点出图时连不上，酒馆就按下面那条命令在后台把 ComfyUI 拉起来（不弹它的界面，也不用你去点启动器）。',
  },
  {
    key: 'comfy.launcher.command',
    type: 'string',
    default: '',
    group: '工具箱',
    label: 'ComfyUI 启动命令',
    help: '留空 = 不托管，要自己先开好 ComfyUI。整合包一般是 <包目录>\\python\\python.exe。',
  },
  {
    key: 'comfy.launcher.args',
    type: 'string',
    default: '',
    group: '工具箱',
    label: 'ComfyUI 启动参数',
    help: '空格分隔，带空格的路径用引号包起来。整合包一般是 main.py --listen 127.0.0.1 --port 8188 --disable-auto-launch（最后那个是不弹浏览器）。',
  },
  {
    key: 'comfy.launcher.cwd',
    type: 'string',
    default: '',
    group: '工具箱',
    label: 'ComfyUI 工作目录',
    help: 'main.py 所在目录，一般是 <包目录>\\ComfyUI。',
  },
  {
    key: 'comfy.idleStopMinutes',
    type: 'number',
    minimum: 0,
    maximum: 1440,
    default: 15,
    group: '工具箱',
    label: '闲置多久自动停掉 ComfyUI（分钟）',
    help: '停掉就把显存还回去；0 = 一直留着。只对"酒馆自己拉起来的"那份生效，你自己开的不会被停。',
  },
  {
    key: 'data.autoBackupOnStart',
    type: 'boolean',
    default: true,
    group: '数据',
    label: '启动时自动备份',
    help: '每次启动服务前留一份完整备份，出事了能回到上一次的状态。',
  },
  {
    key: 'comfy.activeLoraSet',
    type: 'string',
    default: '',
    hidden: true,
    group: '工具箱',
    label: '当前 LoRA 组合',
    help: '出图时套用哪套 LoRA（在 ComfyUI 页的「LoRA」面板里切换）。留空 = 一套都不用。',
  },
  {
    key: 'comfy.promptKit',
    type: 'string',
    default: '{}',
    hidden: true,
    group: '工具箱',
    label: '出图提示词加工台',
    help: 'JSON：词替换 + 风格预设 + 质量词（在 ComfyUI 页的「提示词加工」面板里编辑）。',
  },
  {
    key: 'data.autoBackupKeep',
    type: 'number',
    minimum: 0,
    maximum: 200,
    default: 10,
    group: '数据',
    label: '自动备份保留份数',
    help: '超过这个数量的旧自动备份会被删掉，0 表示不清理。',
  },
  {
    key: 'system.updateUrl',
    type: 'string',
    default: '',
    group: '数据',
    label: '更新源地址',
    help: '指向一份 JSON 更新清单（http(s) 或本地文件路径），留空 = 不检查更新。'
      + '清单格式：{"version":"0.5.1","url":"新 exe 地址","size":字节数,"sha256":"可选校验和","notes":"可选说明"}。',
  },
];

export function schemaByKey() {
  return new Map(SETTINGS_SCHEMA.map((item) => [item.key, item]));
}

export function defaultSettings() {
  const out = {};
  for (const item of SETTINGS_SCHEMA) out[item.key] = item.default;
  return out;
}

/** 校验单个设置值，返回规范化后的值。 */
export function validateSetting(key, value) {
  const item = schemaByKey().get(key);
  if (!item) throw new ValidationError(`未知设置项：${key}`);
  switch (item.type) {
    case 'boolean':
      if (typeof value !== 'boolean') throw new ValidationError(`${key} 应该是布尔值`);
      return value;
    case 'number': {
      const num = Number(value);
      if (!Number.isFinite(num)) throw new ValidationError(`${key} 应该是数字`);
      if (item.minimum !== undefined && num < item.minimum) {
        throw new ValidationError(`${key} 不能小于 ${item.minimum}`);
      }
      if (item.maximum !== undefined && num > item.maximum) {
        throw new ValidationError(`${key} 不能大于 ${item.maximum}`);
      }
      return num;
    }
    case 'enum':
      if (!item.options.includes(value)) {
        throw new ValidationError(`${key} 只能是 ${item.options.join(' / ')}`);
      }
      return value;
    case 'string':
    default:
      if (typeof value !== 'string') throw new ValidationError(`${key} 应该是字符串`);
      return value;
  }
}

/** 校验一批设置修改，返回 { key: value }。 */
export function validateSettings(patch) {
  if (!patch || typeof patch !== 'object') throw new ValidationError('设置修改必须是对象');
  const out = {};
  for (const [key, value] of Object.entries(patch)) out[key] = validateSetting(key, value);
  return out;
}

/** 把存下来的设置与默认值合并，保证每一项都有值。 */
export function mergeSettings(stored = {}) {
  const out = defaultSettings();
  const known = schemaByKey();
  for (const [key, value] of Object.entries(stored ?? {})) {
    if (!known.has(key)) continue; // 旧版本留下的设置项直接忽略
    try {
      out[key] = validateSetting(key, value);
    } catch {
      // 存的值不合法就用默认值，不要让设置页整个打不开
    }
  }
  return out;
}
