/**
 * 最小的多语言层（蓝图 3.2「使用体验」）。
 *
 * 只做界面 chrome：导航（区域 / 模块名）、常用按钮、设置项的标签与说明、命令面板。
 * 各视图正文（角色卡字段、提示词分段说明这类）暂不翻译 —— 那些是数据/领域文案，
 * 硬塞进字典反而更难维护。语言存在设置里的 `ui.language`，由 app.js 启动时灌进来。
 *
 * 查不到就原样返回 key，所以漏翻只会显示一个 key，不会崩。
 */

const DICT = {
  'zh-CN': {
    'app.tagline': '写卡 + 玩卡',
    'app.footer': '{modules} 个模块 · {areas} 个区域',
    'status.planned': '计划中',
    'status.stub': '有接口',
    'status.partial': '部分可用',
    'status.ready': '已完成',

    'area.writing': '写卡区',
    'area.playing': '玩卡区',
    'area.toolbox': '工具箱',
    'area.platform': '平台',

    'module.writing': '写卡区',
    'module.agent': '写卡助手',
    'module.cards': '角色卡',
    'module.card-frontend': '卡内前端与全局外观',
    'module.prompts': '提示词',
    'module.prompt-xray': '提示词 X 光机',
    'module.worldbook': '世界书',
    'module.memory': '记忆',
    'module.vectors': '数据库与向量化',
    'module.card-tools': '写卡工具链',
    'module.chat': '对话',
    'module.group-chat': '群聊',
    'module.scene-state': '场景状态',
    'module.narration': '叙事控制',
    'module.performance': '演出层',
    'module.speech': '语音',
    'module.imagegen': '图片生成',
    'module.comfyui': 'ComfyUI 接入',
    'module.cost': '花费与统计',
    'module.review': '月度与年度报告',
    'module.mcp': 'MCP 服务器',
    'module.backup': '备份与维护',
    'module.scheduler': '定时任务',
    'module.providers': '模型接入',
    'module.assets': '素材库',
    'module.settings': '设置',
    'module.data': '数据与迁移',

    'btn.save': '保存',
    'btn.cancel': '取消',
    'btn.delete': '删除',
    'btn.send': '发送',
    'btn.continue': '继续',
    'btn.regenerate': '重生成',
    'btn.search': '搜索',
    'btn.import': '导入',
    'btn.export': '导出',
    'btn.copy': '复制',
    'btn.edit': '编辑',
    'btn.insert': '插入',
    'btn.hide': '隐藏',
    'btn.unhide': '取消隐藏',
    'btn.system': '设为系统',
    'btn.unsystem': '取消系统',
    'btn.retry': '重试',
    'btn.close': '关闭',
    'btn.newChat': '＋ 新建对话',
    'btn.impersonate': '扮演',
    'btn.options': '行动选项',
    'btn.enable': '启用',
    'btn.disable': '停用',

    'chat.placeholder': '说点什么…（Enter 发送，Shift+Enter 换行）',
    'chat.searchChats': '搜索对话标题…',
    'chat.searchAll': '全文搜索所有对话…',

    'palette.title': '命令面板',
    'palette.placeholder': '搜功能、模块名，回车跳过去…',
    'palette.empty': '没有匹配的功能',
    'palette.hint': '↑↓ 选择 · Enter 执行 · Esc 关闭',
    'palette.modules': '跳转到',
    'palette.actions': '操作',
    'palette.toggleTheme': '切换主题（亮 / 暗 / 护眼）',
    'palette.toggleLanguage': '切换语言（中文 / English）',
    'palette.openSettings': '打开设置',

    'settings.saved': '设置已保存',
    'settings.hint': '改完点保存；主题与字体缩放会立即预览。',
    'settings.reload': '重新加载',
    'settings.notifyGranted': '浏览器通知已开启',
    'settings.notifyDenied': '浏览器通知被拒绝了：去浏览器地址栏旁边的权限里改。以后不会再反复弹。',
    'settings.notifyUnsupported': '这个浏览器不支持系统通知，用"响一下"吧。',

    'group.界面': '界面',
    'group.快捷键': '快捷键',
    'group.数据': '数据',
    'group.工具箱': '工具箱',

    'setting.ui.theme.label': '主题',
    'setting.ui.language.label': '语言',
    'setting.ui.density.label': '信息密度',
    'setting.ui.fontScale.label': '字体缩放',
    'setting.ui.accent.label': '强调色',
    'setting.ui.notifySound.label': '生成完成后响一下',
    'setting.ui.notifyBrowser.label': '生成完成后弹系统通知',
    'setting.ui.lowfx.label': '低配模式（关掉毛玻璃和背景动画）',
    'option.system': '跟随系统',
    'option.light': '亮色',
    'option.dark': '暗色',
    'option.sepia': '护眼（暖色）',
  },
  en: {
    'app.tagline': 'cards + play',
    'app.footer': '{modules} modules · {areas} areas',
    'status.planned': 'planned',
    'status.stub': 'api only',
    'status.partial': 'partial',
    'status.ready': 'ready',

    'area.writing': 'Writing',
    'area.playing': 'Playing',
    'area.toolbox': 'Toolbox',
    'area.platform': 'Platform',

    'module.writing': 'Writing desk',
    'module.agent': 'Card agent',
    'module.cards': 'Character cards',
    'module.card-frontend': 'Card front-end & themes',
    'module.prompts': 'Prompts',
    'module.prompt-xray': 'Prompt X-ray',
    'module.worldbook': 'World info',
    'module.memory': 'Memory',
    'module.vectors': 'Databank & vectors',
    'module.card-tools': 'Card toolchain',
    'module.chat': 'Chat',
    'module.group-chat': 'Group chat',
    'module.scene-state': 'Scene state',
    'module.narration': 'Narration',
    'module.performance': 'Staging',
    'module.speech': 'Speech',
    'module.imagegen': 'Image generation',
    'module.comfyui': 'ComfyUI',
    'module.cost': 'Cost & stats',
    'module.review': 'Monthly & yearly report',
    'module.mcp': 'MCP server',
    'module.backup': 'Backup & maintenance',
    'module.scheduler': 'Scheduled tasks',
    'module.providers': 'Model providers',
    'module.assets': 'Asset library',
    'module.settings': 'Settings',
    'module.data': 'Data & migration',

    'btn.save': 'Save',
    'btn.cancel': 'Cancel',
    'btn.delete': 'Delete',
    'btn.send': 'Send',
    'btn.continue': 'Continue',
    'btn.regenerate': 'Regenerate',
    'btn.search': 'Search',
    'btn.import': 'Import',
    'btn.export': 'Export',
    'btn.copy': 'Copy',
    'btn.edit': 'Edit',
    'btn.insert': 'Insert',
    'btn.hide': 'Hide',
    'btn.unhide': 'Unhide',
    'btn.system': 'Mark as system',
    'btn.unsystem': 'Unmark system',
    'btn.retry': 'Retry',
    'btn.close': 'Close',
    'btn.newChat': '＋ New chat',
    'btn.impersonate': 'Impersonate',
    'btn.options': 'Action options',
    'btn.enable': 'Enable',
    'btn.disable': 'Disable',

    'chat.placeholder': 'Say something… (Enter to send, Shift+Enter for a new line)',
    'chat.searchChats': 'Search chat titles…',
    'chat.searchAll': 'Full-text search across all chats…',

    'palette.title': 'Command palette',
    'palette.placeholder': 'Search features and modules, Enter to jump…',
    'palette.empty': 'Nothing matched',
    'palette.hint': '↑↓ select · Enter run · Esc close',
    'palette.modules': 'Go to',
    'palette.actions': 'Actions',
    'palette.toggleTheme': 'Cycle theme (light / dark / sepia)',
    'palette.toggleLanguage': 'Switch language (中文 / English)',
    'palette.openSettings': 'Open settings',

    'settings.saved': 'Settings saved',
    'settings.hint': 'Press save when done; theme and font scale preview instantly.',
    'settings.reload': 'Reload',
    'settings.notifyGranted': 'Browser notifications are on',
    'settings.notifyDenied': 'Browser notifications were denied — change it in the site permissions. We will not ask again.',
    'settings.notifyUnsupported': 'This browser has no Notification API; use the sound option instead.',

    'group.界面': 'Appearance',
    'group.快捷键': 'Shortcuts',
    'group.数据': 'Data',
    'group.工具箱': 'Toolbox',

    'setting.ui.theme.label': 'Theme',
    'setting.ui.language.label': 'Language',
    'setting.ui.density.label': 'Density',
    'setting.ui.fontScale.label': 'Font scale',
    'setting.ui.accent.label': 'Accent color',
    'setting.ui.notifySound.label': 'Play a sound when a turn finishes',
    'setting.ui.notifyBrowser.label': 'Browser notification when a turn finishes',
    'setting.ui.lowfx.label': 'Low-effects mode (no blur / background animation)',
    'option.system': 'Follow system',
    'option.light': 'Light',
    'option.dark': 'Dark',
    'option.sepia': 'Sepia (warm)',
  },
};

export const LOCALES = [
  { id: 'zh-CN', title: '中文' },
  { id: 'en', title: 'English' },
];

let current = 'zh-CN';

export function getLocale() {
  return current;
}

export function setLocale(locale) {
  current = DICT[locale] ? locale : 'zh-CN';
  return current;
}

/** 取文案。`{name}` 会被 params 替换。查不到返回 fallback，再没有就返回 key。 */
export function t(key, params = null, fallback = null) {
  const table = DICT[current] ?? DICT['zh-CN'];
  let text = table[key] ?? DICT['zh-CN'][key] ?? fallback ?? key;
  if (params) {
    for (const [name, value] of Object.entries(params)) text = text.split(`{${name}}`).join(String(value));
  }
  return text;
}

/** 模块名 / 区域名：字典里有就用字典，没有就用服务端给的中文标题。 */
export function moduleTitle(module) {
  if (!module) return '';
  return t(`module.${module.id}`, null, module.title ?? module.id);
}

export function areaTitle(area) {
  if (!area) return '';
  return t(`area.${area.id}`, null, area.title ?? area.id);
}

export function statusLabel(status) {
  return t(`status.${status}`, null, status);
}

/** 设置项：优先查 `setting.<key>.label`，没有就用服务端 schema 的 label。 */
export function settingLabel(item) {
  return t(`setting.${item.key}.label`, null, item.label ?? item.key);
}

export function groupLabel(group) {
  return t(`group.${group}`, null, group);
}

export function optionLabel(value) {
  return t(`option.${value}`, null, value);
}
