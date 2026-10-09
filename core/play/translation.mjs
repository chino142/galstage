/**
 * 聊天翻译：一键翻、只翻一条、自动翻。
 *
 * 和「翻卡」不同 —— 翻卡是写卡期的动作，翻对话是玩卡期的动作。
 * 译文默认只改显示（存在消息 extra 里），不污染发给模型的上下文；
 * 想让它进上下文得显式打开。
 */

export const TRANSLATE_TARGETS = [
  { id: 'zh-CN', title: '简体中文' },
  { id: 'zh-TW', title: '繁體中文' },
  { id: 'en', title: 'English' },
  { id: 'ja', title: '日本語' },
  { id: 'ko', title: '한국어' },
  { id: 'ru', title: 'Русский' },
];

const TARGET_NAMES = Object.fromEntries(TRANSLATE_TARGETS.map((item) => [item.id, item.title]));

export function targetName(id) {
  return TARGET_NAMES[id] ?? String(id ?? '');
}

/** 翻译提示词：要求只输出译文，并把专有名词列为保留项。 */
export function buildTranslatePrompt({ text = '', target = 'zh-CN', keep = [] } = {}) {
  const lines = [
    `把下面这段角色扮演对话翻译成${targetName(target)}。`,
    '要求：',
    '1. 只输出译文本身，不要解释、不要加引号、不要写「译文：」。',
    '2. 保留原文的换行、星号动作描写、引号与括号。',
    '3. 语气与人称照原文，不要改写成书面语。',
  ];
  if (keep.length) lines.push(`4. 以下专有名词原样保留：${keep.join('、')}。`);
  lines.push('', '原文：', String(text ?? ''));
  return lines.join('\n');
}

export function parseTranslateResult(raw) {
  let text = String(raw ?? '').trim();
  text = text.replace(/^```[a-zA-Z]*\s*\n?/, '').replace(/\n?```$/, '');
  text = text.replace(/^(译文|翻译|translation)\s*[:：]\s*/i, '');
  if (text.startsWith('"') && text.endsWith('"') && text.length > 1) text = text.slice(1, -1);
  if (text.startsWith('「') && text.endsWith('」') && text.length > 1) text = text.slice(1, -1);
  return text.trim();
}

export function shouldAutoTranslate(text, { enabled = false, target = 'zh-CN', onlyForeign = true } = {}) {
  if (!enabled) return false;
  const source = String(text ?? '').trim();
  if (!source) return false;
  if (!onlyForeign) return true;
  return looksForeign(source, target);
}

/** 粗略判断语种：中日韩按字符集，其它按拉丁字母占比。 */
export function looksForeign(text, target = 'zh-CN') {
  const source = String(text ?? '');
  const cjk = (source.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const kana = (source.match(/[\u3040-\u30ff]/g) ?? []).length;
  const hangul = (source.match(/[\uac00-\ud7af]/g) ?? []).length;
  const latin = (source.match(/[A-Za-z]/g) ?? []).length;
  const total = source.replace(/\s/g, '').length || 1;
  if (target === 'zh-CN' || target === 'zh-TW') return cjk / total < 0.25;
  if (target === 'ja') return kana / total < 0.1;
  if (target === 'ko') return hangul / total < 0.1;
  return latin / total < 0.4;
}
