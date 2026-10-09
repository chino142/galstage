/**
 * 提供方的「参数覆盖表」怎么落到一次请求上。
 *
 * 为什么要有这层：各家模型换代时会扔参数、加参数（例：Gemini 3 系列把思考预算换成
 * thinking_level；TopK / seed 这类也不在 OpenAI 风格的那套里）。适配器表是按协议写的，
 * 分辨率到不了单个模型 —— 所以每家提供方自己写一层：
 *
 *   disabled: ['top_k', 'seed']            这家的模型不认，**连预设带来的也一起丢掉**
 *   custom:   [{ key: 'thinking_level',    这家的专属参数；path 决定放哪儿：
 *                path: 'top'                 - 'top' = 请求体顶层（OpenAI 风格中转认这个）
 *                type: 'enum',               - 点号路径 = 嵌进去（Gemini 原生：
 *                options: ['low','high'] }      generationConfig.thinkingConfig.thinkingLevel）
 *
 * 纯函数，方便单测；真正的合并发生在 server/providers/registry.mjs。
 */

import { modelParamPolicy } from './providers-model-rules.mjs';

const isEmpty = (value) => value === undefined || value === null || value === '';

/** 按自定参数的 type 收一下值（从界面来的都是字符串或原始值）。 */
export function coerceCustomValue(def, raw) {
  const type = String(def?.type ?? 'number');
  if (type === 'boolean') return raw === true || raw === 'true' || raw === 1 || raw === '1';
  if (type === 'number') {
    const num = Number(raw);
    return Number.isFinite(num) ? num : undefined;
  }
  if (type === 'int') {
    const num = Number(raw);
    return Number.isFinite(num) ? Math.round(num) : undefined;
  }
  if (type === 'json') {
    if (typeof raw === 'object') return raw;
    try {
      return JSON.parse(String(raw));
    } catch {
      return undefined;
    }
  }
  return String(raw);
}

/** 把小对象按点号路径塞进大对象：'a.b.c' + 1 → { a: { b: { c: 1 } } }。 */
export function setByPath(target, path, value) {
  const parts = String(path ?? 'top').split('.').map((part) => part.trim()).filter(Boolean);
  if (!parts.length) return target;
  let node = target;
  for (const part of parts.slice(0, -1)) {
    if (!node[part] || typeof node[part] !== 'object' || Array.isArray(node[part])) node[part] = {};
    node = node[part];
  }
  node[parts[parts.length - 1]] = value;
  return target;
}

/** 深合并（只合普通对象；别的类型后者胜）。 */
export function mergeDeep(base = {}, patch = {}) {
  const out = { ...(base && typeof base === 'object' ? base : {}) };
  for (const [key, value] of Object.entries(patch ?? {})) {
    const before = out[key];
    if (value && typeof value === 'object' && !Array.isArray(value) && before && typeof before === 'object' && !Array.isArray(before)) {
      out[key] = mergeDeep(before, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * 把覆盖表应用到一个参数集合上。
 * @returns {{params: object, extraPatch: object, dropped: string[], placed: string[]}}
 */
export function applyParamOverrides(params = {}, overrides = {}, { model = '' } = {}) {
  const out = { ...(params ?? {}) };
  const extraPatch = {};
  const dropped = [];
  const placed = [];
  const policy = modelParamPolicy(model);

  // 0. 按模型名自动禁用的（例如 Gemini 3.6/3.7 flash 不再接受 temperature/topP/topK）——
  //    这一层不用用户勾，模型换代了也不用改代码。
  for (const key of policy.disable) {
    if (isEmpty(out[key])) continue;
    delete out[key];
    dropped.push(`${key}（按模型规则）`);
  }

  // 1. 这家不认的已知参数：直接丢掉（预设带来的也在这一层，所以也一起没了）
  for (const key of Array.isArray(overrides?.disabled) ? overrides.disabled : []) {
    const name = String(key ?? '').trim();
    if (!name || isEmpty(out[name])) continue;
    delete out[name];
    dropped.push(name);
  }

  // 2. 这家专属的参数：从 params 里取出来，按 path 拼进 extraPatch
  for (const def of Array.isArray(overrides?.custom) ? overrides.custom : []) {
    const key = String(def?.key ?? '').trim();
    if (!key) continue;
    const raw = out[key];
    if (isEmpty(raw)) continue;
    delete out[key];
    const value = coerceCustomValue(def, raw);
    if (value === undefined) continue;
    // path = 'top'（或空）= 就叫这个名字放请求体顶层；点号路径 = 嵌进去
    const path = String(def?.path ?? 'top').trim();
    if (!path || path === 'top') extraPatch[key] = value;
    else setByPath(extraPatch, path, value);
    placed.push(key);
  }

  return { params: out, extraPatch, dropped, placed };
}
