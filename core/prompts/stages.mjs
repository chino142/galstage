/**
 * 提示词管线的阶段定义。
 *
 * 组装提示词时按这个顺序走，每个阶段负责往结果里塞一段内容。
 * 顺序本身就是规格：改动顺序等于改模型看到的世界，要谨慎。
 * `status` 决定界面上怎么标：ready 能用 / partial 部分 / planned 还没做。
 */

export const PROMPT_STAGES = [
  { id: 'global-system', title: '全局系统提示', role: 'system', status: 'ready', note: '软件级，所有角色共用' },
  { id: 'character-system', title: '角色系统提示', role: 'system', status: 'ready', note: '角色卡自带' },
  { id: 'persona', title: '人设注入', role: 'system', status: 'ready', note: '角色人设 + 我的人设 + 群聊身份' },
  { id: 'preset-queue', title: '预设队列', role: 'mixed', status: 'ready', note: '可拖拽排序、可逐条开关（酒馆预设导入）' },
  { id: 'worldbook', title: '世界书注入', role: 'system', status: 'ready', note: '按优先级与预算裁剪' },
  { id: 'memory', title: '记忆注入', role: 'system', status: 'partial', note: '小总结 / 大总结 / 结构化档案（记忆引擎待补）' },
  { id: 'databank', title: '参考资料', role: 'system', status: 'partial', note: '向量召回的片段与导演注入' },
  { id: 'authors-note', title: '作者注', role: 'system', status: 'ready', note: '前后 / 指定深度三种位置' },
  { id: 'examples', title: '对话示例', role: 'mixed', status: 'ready', note: '示例对话展开' },
  { id: 'history', title: '对话历史', role: 'mixed', status: 'ready', note: '按裁剪策略取出的一段，正则在这里生效' },
  { id: 'preset-inline', title: '预设对话内注入', role: 'mixed', status: 'ready', note: '预设排在对话历史之后、或标了"绝对位置"的条目，按酒馆的规矩插进对话里' },
  { id: 'prefill', title: '前置词', role: 'assistant', status: 'ready', note: '接在最后，逼模型顺着写' },
  { id: 'suffix', title: '后置词', role: 'system', status: 'ready', note: '最高优先级，放最末尾' },
  { id: 'stop-strings', title: '停止串', role: 'meta', status: 'ready', note: '不注入内容，只影响请求参数' },
  { id: 'post-process', title: '输出后处理', role: 'meta', status: 'partial', note: '正则、去空行、截断' },
];

export function stageById(id) {
  return PROMPT_STAGES.find((stage) => stage.id === id) ?? null;
}
