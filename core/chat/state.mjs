/**
 * 场景状态：把"聊天"变成"玩"的那一层。
 *
 * 结构（存在 chats.world_state 里）：
 *   {
 *     attributes: { hp: 80, 体力: 12 },          // 数值 / 文本，数值会自动加减
 *     affection:  { 阿狸: 12 },                  // 好感度，数值自动加减
 *     quests:     [{ title, status, note }],     // 任务：active | done | failed
 *     items:      [{ name, qty, note }],         // 物品
 *     place:      '酒馆二楼',                    // 地点
 *     time:       '第二天清晨',                  // 时间
 *   }
 *
 * AI 每轮在回复末尾输出了一个 ```state 代码块，里面只写"变化"：
 *   {"affection":{"阿狸":3},"attributes":{"体力":-2},"items":[{"name":"铜钥匙"}],
 *    "quests":[{"title":"找到地窖入口","status":"active"}],"place":"酒馆地窖"}
 *
 * 解析失败不影响对话：块会被摘掉、状态不更新，错误记在消息的 extra 里。
 */

import { extractJson } from '../agent/prompt.mjs';

export const STATE_BLOCK_LANGUAGE = 'state';

export const STATE_PANELS = [
  { id: 'attributes', title: '属性', kind: 'map', summary: '数值类，AI 给增量就自动加减' },
  { id: 'affection', title: '好感度', kind: 'map', summary: '按角色名记录，给增量就加减' },
  { id: 'quests', title: '任务', kind: 'list', summary: '进行中 / 已完成 / 已失败' },
  { id: 'items', title: '物品', kind: 'list', summary: '数量自动合并' },
  { id: 'place', title: '地点', kind: 'value', summary: '当前所在' },
  { id: 'time', title: '时间', kind: 'value', summary: '当前时间' },
];

export const STATE_INSTRUCTION = [
  '在回复的最后另起一行，输出一个 ```state 代码块，里面是这一轮发生的状态变化（JSON）。',
  '只写变化，不要写全量。可用的键：',
  'attributes（属性增减）、affection（好感度增减）、quests（任务，status 用 active/done/failed）、',
  'items（物品，带 name 与 qty）、place（地点）、time（时间）。',
  '没有变化就整块省略，不要输出空对象，也不要把这段说明复述出来。',
].join('');

export function emptyWorldState() {
  return { attributes: {}, affection: {}, quests: [], items: [], place: '', time: '' };
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/**
 * 从一段回复里摘出 ```state 块。
 * @returns {{text:string, delta:object|null, found:boolean, ok:boolean, error:string|null}}
 */
export function parseStateDelta(text) {
  const source = String(text ?? '');
  const patterns = [
    new RegExp('```' + STATE_BLOCK_LANGUAGE + '\\s*([\\s\\S]*?)```', 'i'),
    new RegExp('<state>([\\s\\S]*?)</state>', 'i'),
  ];
  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (!match) continue;
    const cleaned = source.replace(match[0], '').replace(/\n{3,}/g, '\n\n').trimEnd();
    const delta = extractJson(match[1]);
    if (!delta || typeof delta !== 'object') {
      return { text: cleaned, delta: null, found: true, ok: false, error: 'state 块不是合法 JSON' };
    }
    return { text: cleaned, delta, found: true, ok: true, error: null };
  }
  return { text: source, delta: null, found: false, ok: true, error: null };
}

/** 规格化 delta，容错各种奇怪的写法。 */
export function normalizeDelta(delta = {}) {
  const out = { attributes: {}, affection: {}, quests: [], items: [], place: null, time: null, variables: {} };
  if (!delta || typeof delta !== 'object') return out;
  out.attributes = asObject(delta.attributes);
  out.affection = asObject(delta.affection ?? delta.favor ?? delta.favour);
  out.place = typeof delta.place === 'string' && delta.place.trim() ? delta.place.trim() : null;
  out.time = typeof delta.time === 'string' && delta.time.trim() ? delta.time.trim() : null;
  out.variables = asObject(delta.variables);
  if (Array.isArray(delta.quests)) {
    out.quests = delta.quests
      .map((item) => (typeof item === 'string' ? { title: item } : item))
      .filter((item) => item && (item.title || item.name))
      .map((item) => ({ title: String(item.title ?? item.name).trim(), status: item.status ?? 'active', note: item.note ?? '' }));
  }
  if (Array.isArray(delta.items)) {
    out.items = delta.items
      .map((item) => (typeof item === 'string' ? { name: item } : item))
      .filter((item) => item && (item.name || item.title))
      .map((item) => ({
        name: String(item.name ?? item.title).trim(),
        qty: item.qty === undefined ? 1 : Number(item.qty),
        note: item.note ?? '',
        action: item.action ?? (item.remove ? 'remove' : 'add'),
      }));
  }
  return out;
}

/** 数值给增量就加减，给字符串就直接覆盖。 */
function mergeMap(base, delta) {
  const out = { ...asObject(base) };
  for (const [key, value] of Object.entries(asObject(delta))) {
    const current = out[key];
    if (typeof value === 'number' && typeof current === 'number') out[key] = current + value;
    else out[key] = value;
  }
  return out;
}

/**
 * 应用一次状态改动，返回新的 worldState（纯函数，不改入参）。
 */
export function applyStateDelta(worldState = {}, delta = {}) {
  const norm = normalizeDelta(delta);
  const base = { ...emptyWorldState(), ...asObject(worldState) };
  const next = {
    ...base,
    attributes: mergeMap(base.attributes, norm.attributes),
    affection: mergeMap(base.affection, norm.affection),
    place: norm.place ?? base.place ?? '',
    time: norm.time ?? base.time ?? '',
  };

  const quests = [...(Array.isArray(base.quests) ? base.quests : [])];
  for (const quest of norm.quests) {
    const index = quests.findIndex((item) => String(item.title ?? item.name) === quest.title);
    if (index >= 0) quests[index] = { ...quests[index], ...quest };
    else quests.push(quest);
  }
  next.quests = quests;

  const items = [...(Array.isArray(base.items) ? base.items : [])];
  for (const item of norm.items) {
    const index = items.findIndex((entry) => String(entry.name) === item.name);
    if (item.action === 'remove') {
      if (index >= 0) items.splice(index, 1);
      continue;
    }
    if (index >= 0) {
      const currentQty = Number(items[index].qty ?? 1);
      items[index] = { ...items[index], ...item, qty: currentQty + (Number.isFinite(item.qty) ? item.qty : 1) };
    } else {
      items.push({ name: item.name, qty: Number.isFinite(item.qty) ? item.qty : 1, note: item.note ?? '' });
    }
  }
  next.items = items;
  next.variables = { ...asObject(base.variables), ...norm.variables };
  return next;
}

/**
 * 骰子：支持 `d20` / `2d6` / `2d6+3` / `1d20-1`。
 * @returns {{expr:string, rolls:number[], modifier:number, total:number, detail:string}}
 */
export function rollDice(expr = '1d20', rng = Math.random) {
  const text = String(expr ?? '').trim().toLowerCase().replace(/\s+/g, '');
  const match = text.match(/^(\d*)d(\d+)([+-]\d+)?$/);
  if (!match) throw new Error(`看不懂的骰子表达式：${expr}（试试 2d6+3）`);
  const count = Math.min(100, Math.max(1, Number(match[1] || 1)));
  const faces = Math.min(1000, Math.max(2, Number(match[2])));
  const modifier = Number(match[3] ?? 0);
  const rolls = Array.from({ length: count }, () => 1 + Math.floor(rng() * faces));
  const total = rolls.reduce((sum, value) => sum + value, 0) + modifier;
  const modText = modifier ? (modifier > 0 ? `+${modifier}` : `${modifier}`) : '';
  return {
    expr: `${count}d${faces}${modText}`,
    rolls,
    modifier,
    total,
    detail: `🎲 ${count}d${faces}${modText} = [${rolls.join(', ')}]${modText} = ${total}`,
  };
}
