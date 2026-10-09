/**
 * 角色卡的字段表。
 *
 * 这里只放"字段长什么样"，不放解析逻辑。path 是它在卡数据里的位置：
 * V1 直接挂根上，V2/V3 包在 data 里。这张表用于生成界面表单与校验，
 * 不用来过滤卡数据 —— 未知字段一律原样保留，往返不许丢。
 */

export const CARD_GROUPS = [
  { id: 'basic', title: '基本信息', summary: '名字、头像、标签这些一眼能看到的' },
  { id: 'persona', title: '人物设定', summary: '简介、性格、场景' },
  { id: 'greeting', title: '开场与示例', summary: '开场白、替代开场白、对话示例' },
  {
    id: 'prompts',
    title: '提示词',
    summary: '系统提示、前置词、后置词与历史后指令。前置 / 后置词拼在最后一条用户消息的前后；系统提示、前置词、后置词这三样可以被单个对话覆盖（对话页 → ⚙ 对话配置），留空 = 跟随这张卡',
  },
  { id: 'lore', title: '世界书', summary: '卡里自带的世界书' },
  { id: 'meta', title: '元信息', summary: '作者、版本、创建工具' },
];

export const CARD_SPEC_VERSIONS = [
  { id: 'v1', title: 'V1', summary: '最老的扁平结构，字段直接挂在根上' },
  { id: 'v2', title: 'V2', summary: '包一层 data，社区事实标准' },
  { id: 'v3', title: 'V3', summary: '在 V2 基础上加了多资源块，字段向后兼容' },
];

export const CARD_PNG_CHUNKS = [
  { id: 'chara', title: 'chara', spec: 'v2', summary: 'base64 的 V2 JSON，酒馆读的是这个' },
  { id: 'ccv3', title: 'ccv3', spec: 'v3', summary: 'V3 才有的资源块，较新的卡带这个' },
];

/** type 决定界面上用什么控件；list 表示一行一条的字符串数组。 */
export const CARD_FIELDS = [
  { key: 'name', label: '名字', group: 'basic', path: 'data.name', type: 'string', required: true, spec: 'all' },
  { key: 'avatar', label: '头像', group: 'basic', path: '-', type: 'image', spec: 'all', help: 'PNG 卡里头像就是文件本身' },
  { key: 'nickname', label: '昵称', group: 'basic', path: 'data.nickname', type: 'string', spec: 'v2' },
  { key: 'creator', label: '作者', group: 'basic', path: 'data.creator', type: 'string', spec: 'v2' },
  { key: 'tags', label: '标签', group: 'basic', path: 'data.tags', type: 'list', spec: 'v2' },
  { key: 'description', label: '简介', group: 'persona', path: 'data.description', type: 'text', required: true, spec: 'all' },
  { key: 'personality', label: '性格', group: 'persona', path: 'data.personality', type: 'text', spec: 'all' },
  { key: 'scenario', label: '场景', group: 'persona', path: 'data.scenario', type: 'text', spec: 'all' },
  { key: 'first_mes', label: '开场白', group: 'greeting', path: 'data.first_mes', type: 'text', spec: 'all' },
  { key: 'alternate_greetings', label: '替代开场白', group: 'greeting', path: 'data.alternate_greetings', type: 'list', spec: 'v2' },
  { key: 'group_only_greetings', label: '群聊专用开场白', group: 'greeting', path: 'data.group_only_greetings', type: 'list', spec: 'v2' },
  { key: 'mes_example', label: '对话示例', group: 'greeting', path: 'data.mes_example', type: 'text', spec: 'all' },
  { key: 'system_prompt', label: '系统提示', group: 'prompts', path: 'data.system_prompt', type: 'text', spec: 'v2' },
  { key: 'post_history_instructions', label: '历史后指令', group: 'prompts', path: 'data.post_history_instructions', type: 'text', spec: 'v2' },
  // 前置词 / 后置词：拼在**最后一条用户消息**的前后各一段，不是独立消息。
  // 来源是那种"游戏化卡"平台的写法（详见 core/cards/platform-import.mjs）——它俩放的都是
  // "这一轮必须遵守"的即时要求，贴得离用户发言越近越管用。
  { key: 'prefix_text', label: '前置词（拼在用户输入前）', group: 'prompts', path: 'data.prefix_text', type: 'text', spec: 'v2' },
  { key: 'suffix_text', label: '后置词（拼在用户输入后）', group: 'prompts', path: 'data.suffix_text', type: 'text', spec: 'v2' },
  { key: 'character_book', label: '卡内世界书', group: 'lore', path: 'data.character_book', type: 'object', spec: 'v2' },
  { key: 'creator_notes', label: '作者备注', group: 'meta', path: 'data.creator_notes', type: 'text', spec: 'v2' },
  { key: 'character_version', label: '卡版本', group: 'meta', path: 'data.character_version', type: 'string', spec: 'v2' },
  { key: 'extensions', label: '扩展字段', group: 'meta', path: 'data.extensions', type: 'object', spec: 'v2' },
];

export function fieldsByGroup(group) {
  return CARD_FIELDS.filter((field) => field.group === group);
}
