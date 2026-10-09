/**
 * 临场指令（作者注）的三层作用域。
 *
 * 抄的是 SillyTavern 的 Author's Note：**默认 / 角色 / 对话** 三层，
 * 上层被下层覆盖；每层都能单独设位置、深度、角色，以及**插入频率**
 * （每 N 条用户输入重新插一次）。
 *
 * 玩卡时最常用的场景：不动卡、不动预设，只加一段"这一章写慢一点、多写环境"
 * 的临时指令。
 */

import { ValidationError } from '../errors.mjs';

export const NOTE_SCOPES = ['default', 'character', 'chat'];

export const NOTE_POSITIONS = [
  { id: 'before', title: '角色定义之前' },
  { id: 'after', title: '角色定义之后' },
  { id: 'atDepth', title: '指定深度' },
];

export const NOTE_ROLES = ['system', 'user', 'assistant'];

const DEFAULT_NOTE = {
  enabled: true,
  prompt: '',
  position: 'before',
  depth: 4,
  role: 'system',
  interval: 1,
  scanWorldInfo: false,
};

/** 把任意来源的一条指令规整成内部形状；空内容返回 null。 */
export function normaliseNote(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string') {
    const prompt = raw.trim();
    return prompt ? { ...DEFAULT_NOTE, prompt } : null;
  }
  if (typeof raw !== 'object') throw new ValidationError('临场指令必须是字符串或对象');
  const prompt = String(raw.prompt ?? raw.text ?? raw.content ?? '').trim();
  const enabled = raw.enabled === undefined ? true : Boolean(raw.enabled);
  if (!prompt && enabled) return null;
  const position = String(raw.position ?? DEFAULT_NOTE.position);
  if (!NOTE_POSITIONS.some((item) => item.id === position)) {
    throw new ValidationError(`临场指令的位置只能是 ${NOTE_POSITIONS.map((item) => item.id).join(' / ')}`);
  }
  const role = String(raw.role ?? DEFAULT_NOTE.role);
  if (!NOTE_ROLES.includes(role)) throw new ValidationError(`临场指令的角色只能是 ${NOTE_ROLES.join(' / ')}`);
  const depth = Number(raw.depth ?? DEFAULT_NOTE.depth);
  const interval = Number(raw.interval ?? DEFAULT_NOTE.interval);
  return {
    enabled,
    prompt,
    position,
    depth: Number.isFinite(depth) && depth >= 0 ? Math.floor(depth) : DEFAULT_NOTE.depth,
    role,
    // interval = 每 N 条用户输入重插一次；0 或 1 表示每轮都插
    interval: Number.isFinite(interval) && interval >= 0 ? Math.floor(interval) : 1,
    scanWorldInfo: Boolean(raw.scanWorldInfo),
  };
}

/**
 * 三层合并：对话层 > 角色层 > 默认层。整条覆盖（不是字段级补丁），
 * 因为"这一段指令"本来就是整体替换的语义。
 * @returns {{note:object|null, from:'chat'|'character'|'default'|null}}
 */
export function resolveNote({ defaultNote = null, characterNote = null, chatNote = null } = {}) {
  const layers = [
    ['chat', normaliseNote(chatNote)],
    ['character', normaliseNote(characterNote)],
    ['default', normaliseNote(defaultNote)],
  ];
  for (const [from, note] of layers) {
    if (note && note.enabled) return { note, from };
  }
  return { note: null, from: null };
}

/**
 * 这一轮该不该插。interval 是"每 N 条用户输入一次"：
 *   interval <= 1 → 每轮都插；否则只在第 interval、2×interval… 条用户输入时插。
 * 注意第一轮永远插（否则开卡就没有临场指令）。
 */
export function shouldInject(note, userTurnCount = 1) {
  if (!note || !note.enabled || !note.prompt) return false;
  const interval = Number(note.interval) || 1;
  const turns = Math.max(1, Math.floor(Number(userTurnCount) || 1));
  if (interval <= 1) return true;
  if (turns === 1) return true;
  return turns % interval === 0;
}

/** 位置 → 提示词管线里的落点（给 assemblePrompt 用）。 */
export function notePlacement(note) {
  if (!note) return { position: 'before', depth: 4, role: 'system' };
  return { position: note.position, depth: note.depth, role: note.role };
}

/** 界面上的一行摘要。 */
export function describeNote(note, from = null) {
  if (!note) return '没有临场指令';
  const where = NOTE_POSITIONS.find((item) => item.id === note.position)?.title ?? note.position;
  const every = note.interval <= 1 ? '每轮' : `每 ${note.interval} 条用户输入`;
  const place = note.position === 'atDepth' ? `${where} ${note.depth}` : where;
  return `${from ? `来自${from}层，` : ''}${place}，以 ${note.role} 身份，${every}插入一次`;
}
