/**
 * 套装（Loadout）：把"这套玩法需要的一切"打包，应用时可以只应用其中一部分。
 *
 * 抄自 RisuAI 的 Loadout。关键不是打包，而是**选择性应用**——
 * "只换 persona，保留我当前的预设"这种操作，整套切换是做不到的。
 */

import { ValidationError } from '../errors.mjs';

export const LOADOUT_PARTS = [
  { id: 'characters', title: '角色', summary: '上场的角色卡' },
  { id: 'persona', title: '我的人设', summary: 'user 侧的 persona' },
  { id: 'preset', title: '提示词预设', summary: '预设 / 上下文模板' },
  { id: 'model', title: '模型绑定', summary: '提供方与角色绑定' },
  { id: 'modules', title: '功能开关', summary: '哪些模块开着' },
  { id: 'variables', title: '全局变量', summary: '全局状态变量' },
  { id: 'worldbook', title: '世界书链接', summary: '挂哪几本世界书' },
];

const PART_IDS = LOADOUT_PARTS.map((part) => part.id);

export function normaliseParts(parts) {
  if (parts === undefined || parts === null) return [...PART_IDS];
  const list = (Array.isArray(parts) ? parts : [parts]).map((item) => String(item).trim()).filter(Boolean);
  const unknown = list.filter((item) => !PART_IDS.includes(item));
  if (unknown.length) throw new ValidationError(`不认识的套装组成：${unknown.join('、')}（可选 ${PART_IDS.join(' / ')}）`);
  return list;
}

/**
 * 从当前状态抽一份套装。
 * @param {object} state  { characters, persona, preset, model, modules, variables, worldbook }
 * @param {{name:string, parts?:string[], id?:string, now?:Date}} meta
 */
export function createLoadout(state = {}, meta = {}) {
  const name = String(meta.name ?? '').trim();
  if (!name) throw new ValidationError('套装需要起个名字');
  const parts = normaliseParts(meta.parts);
  const payload = {};
  for (const part of parts) {
    payload[part] = clone(state[part] ?? null);
  }
  return {
    id: meta.id ?? null,
    name,
    parts,
    payload,
    favorite: Boolean(meta.favorite),
    lastUsedAt: meta.now ? new Date(meta.now).toISOString() : new Date().toISOString(),
  };
}

/**
 * 应用一套装。只覆盖 `apply` 里列出的部分，其余保持调用方的现状。
 * @returns {{next:object, applied:string[], skipped:string[]}}
 */
export function applyLoadout(loadout = {}, current = {}, apply = null) {
  const available = normaliseParts(loadout.parts ?? Object.keys(loadout.payload ?? {}));
  const wanted = apply === null || apply === undefined ? available : normaliseParts(apply);
  const requested = wanted.filter((part) => available.includes(part));
  const skipped = wanted.filter((part) => !available.includes(part));
  const next = { ...current };
  const applied = [];
  for (const part of requested) {
    if (!(part in (loadout.payload ?? {}))) continue;
    next[part] = clone(loadout.payload[part]);
    applied.push(part);
  }
  return { next, applied, skipped };
}

/** 界面上的摘要：这套装里都有什么。 */
export function describeLoadout(loadout = {}) {
  const parts = normaliseParts(loadout.parts ?? Object.keys(loadout.payload ?? {}));
  return parts
    .map((part) => {
      const meta = LOADOUT_PARTS.find((item) => item.id === part);
      const value = loadout.payload?.[part];
      const size = Array.isArray(value) ? `${value.length} 项` : value === null || value === undefined ? '空' : '已设置';
      return `${meta?.title ?? part}（${size}）`;
    })
    .join('、');
}

function clone(value) {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(clone);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
}
