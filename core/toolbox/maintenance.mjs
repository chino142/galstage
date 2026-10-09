/** 备份与维护的纯逻辑：体积格式化、备份列表摘要、清理项清单。 */

export const CLEANUP_TARGETS = [
  { id: 'orphanFiles', title: '孤立素材文件', summary: '文件在磁盘上、数据库里没有记录', default: true },
  { id: 'missingFiles', title: '素材记录缺文件', summary: '数据库里记着、文件已经不在了，删掉这些空记录', default: true },
  { id: 'staleVectors', title: '失效向量', summary: '指向的世界书 / 记忆 / 对话已经不存在', default: true },
  { id: 'duplicateMessages', title: '重复消息', summary: '同一对话里角色与内容完全相同的消息，保留最早那条', default: true },
  { id: 'emptyChats', title: '空对话', summary: '既没有成员也没有消息的对话（比较激进，默认不勾）', default: false },
];

export const BACKUP_KINDS = [
  { id: 'manual', title: '手动备份' },
  { id: 'auto', title: '启动自动备份' },
  { id: 'pre-restore', title: '恢复前自动备份' },
  { id: 'pre-cleanup', title: '清理前自动备份' },
  { id: 'pre-import', title: '批量导入前自动备份' },
  { id: 'pre-delete', title: '批量删除前自动备份' },
  { id: 'pre-migration', title: '数据库迁移前自动备份' },
  { id: 'scheduled', title: '定时任务备份' },
  { id: 'export', title: '加密导出时的备份' },
  { id: 'imported', title: '导入的外部备份' },
];

export function formatBytes(bytes) {
  const value = Number(bytes ?? 0);
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let index = 0;
  let size = value;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size >= 10 || index === 0 ? Math.round(size) : size.toFixed(1)} ${units[index]}`;
}

/** 备份列表：补上体积和"这是不是最新的一份"。 */
export function describeBackups(items = []) {
  const sorted = [...items].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return sorted.map((item, index) => ({
    ...item,
    sizeText: formatBytes(item.bytes),
    kindTitle: BACKUP_KINDS.find((kind) => kind.id === item.kind)?.title ?? item.kind ?? '备份',
    latest: index === 0,
  }));
}

/** 数据统计里那些数字，挑几个用中文说清楚（给界面用）。 */
export function describeStats(stats = {}) {
  return [
    { key: 'characters', label: '角色卡', value: stats.characters ?? 0 },
    { key: 'chats', label: '对话', value: stats.chats ?? 0 },
    { key: 'messages', label: '消息', value: stats.messages ?? 0 },
    { key: 'words', label: '字数（去掉空白）', value: stats.words ?? 0 },
    { key: 'worldbookEntries', label: '世界书条目', value: stats.worldbookEntries ?? 0 },
    { key: 'memories', label: '记忆条目', value: stats.memories ?? 0 },
    { key: 'vectors', label: '向量片', value: stats.vectors ?? 0 },
    { key: 'assets', label: '素材', value: stats.assets ?? 0 },
    { key: 'assetBytes', label: '素材占用', value: formatBytes(stats.assetBytes) },
    { key: 'comfyRuns', label: '出图记录', value: stats.comfyRuns ?? 0 },
    { key: 'usageTurns', label: '记账轮数', value: stats.usageTurns ?? 0 },
    { key: 'presets', label: '提示词预设', value: stats.presets ?? 0 },
  ];
}

export function defaultCleanupTargets() {
  return CLEANUP_TARGETS.filter((item) => item.default).map((item) => item.id);
}
