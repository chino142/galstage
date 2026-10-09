/**
 * 记忆 → 世界书：把已经攒下来的记忆条目一键转成世界书条目。
 *
 * 为什么值得打通：记忆是「按相关性召回」的，世界书是「按关键词硬触发」的。
 * 有些设定（比如"她怕打雷"）一旦成为长期事实，做成常驻或关键词触发的条目
 * 比每轮靠向量召回更稳、更省 token。
 */

import { ValidationError } from '../errors.mjs';

/** 从记忆正文里猜几个触发词：优先书名号/引号里的专名，其次高频二字词。 */
export function guessKeys(content, { max = 4 } = {}) {
  const text = String(content ?? '');
  const keys = [];
  const push = (word) => {
    const clean = String(word ?? '').trim();
    if (clean.length >= 2 && clean.length <= 12 && !keys.includes(clean)) keys.push(clean);
  };
  for (const match of text.matchAll(/[《「“"]([^》」”"]{2,12})[》」”"]/g)) push(match[1]);
  if (keys.length < max) {
    for (const match of text.matchAll(/[\u4e00-\u9fa5]{2,4}/g)) {
      push(match[0]);
      if (keys.length >= max) break;
    }
  }
  return keys.slice(0, max);
}

/**
 * 一条记忆 → 一条世界书条目。
 * @param {object} memory 记忆记录（content / layer / kind / characterId…）
 */
export function memoryToEntry(memory = {}, { keys = null, constant = false, order = 120 } = {}) {
  const content = String(memory.content ?? '').trim();
  if (!content) throw new ValidationError('这条记忆没有正文，转不了');
  const resolvedKeys = Array.isArray(keys) && keys.length ? keys.map(String) : guessKeys(content);
  const layer = String(memory.layer ?? memory.kind ?? '');
  return {
    comment: String(memory.title ?? '').trim() || `记忆：${content.slice(0, 16)}`,
    content,
    keys: constant ? [] : resolvedKeys,
    secondaryKeys: [],
    constant: Boolean(constant) || resolvedKeys.length === 0,
    selective: false,
    order,
    position: 0,
    depth: 4,
    probability: 100,
    useProbability: false,
    group: layer ? `记忆-${layer}` : '',
    groupWeight: 100,
    vectorized: false,
    injectionTrigger: [],
    extensions: { importedFrom: 'memory', memoryId: memory.id ?? null },
  };
}

export function memoriesToEntries(memories = [], options = {}) {
  const list = Array.isArray(memories) ? memories : [];
  const entries = [];
  const skipped = [];
  list.forEach((memory) => {
    try {
      entries.push(memoryToEntry(memory, options));
    } catch (err) {
      skipped.push({ id: memory?.id ?? null, reason: err?.message ?? String(err) });
    }
  });
  return { entries, skipped };
}
