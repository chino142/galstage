/**
 * 采样参数：顺序、开关与「中性化」。
 *
 * 这是从 SillyTavern 抄来的一块：文本补全后端的实际手感高度依赖
 * **采样器的先后顺序**，所以那边把顺序做成了可拖拽列表，每个后端一套默认顺序，
 * 外加一个「Neutralize Samplers」把所有会改变分布的采样器关掉。
 *
 * 参数本身在 server/providers/params.mjs（按适配器分开）；这里只管
 * **顺序与开关**这两件正交的事。
 */

import { ValidationError } from '../errors.mjs';

/** 采样器目录：id / 名字 / 分组 / 一句话说明。 */
export const SAMPLER_CATALOG = [
  { id: 'penalties', title: '重复惩罚', group: 'penalty', summary: 'repetition / presence / frequency 惩罚的合并入口' },
  { id: 'dry', title: 'DRY', group: 'penalty', summary: '按序列长度递增的重复抑制，比普通惩罚更不容易伤文风' },
  { id: 'temperature', title: '温度', group: 'core', summary: '越高越随机' },
  { id: 'dynamic_temperature', title: '动态温度', group: 'core', summary: '按熵自动升降温度' },
  { id: 'top_n_sigma', title: 'top-nσ', group: 'filter', summary: '按标准差截断' },
  { id: 'top_k', title: 'Top-K', group: 'filter', summary: '只留概率最高的 K 个' },
  { id: 'typ_p', title: 'Typical P', group: 'filter', summary: '按信息量截断' },
  { id: 'top_p', title: 'Top-P', group: 'filter', summary: '核采样' },
  { id: 'min_p', title: 'Min-P', group: 'filter', summary: '按最高概率的比例设下限' },
  { id: 'tfs', title: 'TFS', group: 'filter', summary: 'tail-free sampling' },
  { id: 'xtc', title: 'XTC', group: 'filter', summary: '排除最可能的那一批，鼓励意外' },
  { id: 'mirostat', title: 'Mirostat', group: 'filter', summary: '按目标困惑度自适应截断' },
  { id: 'smoothing', title: '平滑', group: 'filter', summary: '二次 / 曲线平滑概率分布' },
  { id: 'grammar', title: '语法约束', group: 'constraint', summary: 'GBNF / JSON Schema 强约束输出结构' },
  { id: 'banned_tokens', title: '禁用词表', group: 'constraint', summary: '直接屏蔽 token 或字符串' },
  { id: 'logit_bias', title: 'Logit Bias', group: 'constraint', summary: '逐词加权' },
];

/** 每个后端的默认采样顺序。顺序不同，出来的文风差别很大。 */
export const BACKEND_DEFAULT_ORDER = {
  llamacpp: ['penalties', 'dry', 'top_n_sigma', 'top_k', 'typ_p', 'top_p', 'min_p', 'xtc', 'temperature', 'dynamic_temperature'],
  koboldcpp: ['penalties', 'dry', 'top_k', 'typ_p', 'top_p', 'min_p', 'xtc', 'temperature'],
  ooba: ['penalties', 'dry', 'temperature', 'dynamic_temperature', 'top_k', 'top_p', 'min_p', 'typ_p', 'tfs'],
  aphrodite: ['penalties', 'dry', 'temperature', 'top_p', 'top_k', 'min_p', 'typ_p', 'tfs', 'mirostat'],
};

export const BACKEND_LABELS = {
  llamacpp: 'llama.cpp',
  koboldcpp: 'KoboldCpp',
  ooba: 'Text Generation WebUI',
  aphrodite: 'Aphrodite',
};

export function supportedBackends() {
  return Object.keys(BACKEND_DEFAULT_ORDER);
}

/**
 * 把用户存的顺序规整成合法顺序：认识的按用户顺序在前，
 * 没提到的补到后面（新版本新增的采样器不会因为老配置消失）。
 */
export function normaliseOrder(order = [], backend = 'llamacpp') {
  const known = new Set(SAMPLER_CATALOG.map((item) => item.id));
  const fallback = BACKEND_DEFAULT_ORDER[backend] ?? BACKEND_DEFAULT_ORDER.llamacpp;
  const seen = new Set();
  const result = [];
  for (const id of Array.isArray(order) ? order : []) {
    const key = String(id ?? '').trim();
    if (!known.has(key) || seen.has(key)) continue;
    seen.add(key);
    result.push(key);
  }
  for (const id of fallback) {
    if (!seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  }
  for (const item of SAMPLER_CATALOG) {
    if (!seen.has(item.id)) result.push(item.id);
  }
  return result;
}

/**
 * 生成一份采样器配置。
 * @param {object} input
 * @param {string} [input.backend]
 * @param {string[]} [input.order]
 * @param {string[]} [input.enabled] 不传 = 全开
 * @param {object} [input.params]    采样器参数（由 provider 参数表校验）
 */
export function createSamplerProfile(input = {}) {
  const backend = String(input.backend ?? 'llamacpp');
  if (!BACKEND_DEFAULT_ORDER[backend]) {
    throw new ValidationError(`不认识的文本补全后端：${backend}（支持 ${supportedBackends().join(' / ')}）`);
  }
  const order = normaliseOrder(input.order, backend);
  const known = new Set(SAMPLER_CATALOG.map((item) => item.id));
  const unknownEnabled = (input.enabled ?? []).filter((id) => !known.has(id));
  if (unknownEnabled.length) throw new ValidationError(`不认识的采样器：${unknownEnabled.join('、')}`);
  const enabled = input.enabled === undefined || input.enabled === null
    ? [...order]
    : order.filter((id) => new Set(input.enabled).has(id));
  return {
    backend,
    order,
    enabled,
    disabled: order.filter((id) => !enabled.includes(id)),
    params: { ...(input.params ?? {}) },
  };
}

/** 恢复成这个后端的默认顺序（开关也全开）。 */
export function resetOrder(profile = {}) {
  const backend = profile.backend ?? 'llamacpp';
  return createSamplerProfile({ ...profile, backend, order: BACKEND_DEFAULT_ORDER[backend], enabled: undefined });
}

/**
 * 中性化：把会改变分布的采样器关掉，只留约束类的。
 * 排查「是不是采样参数的问题」时，这是最快的一步。
 */
export function neutralize(profile = {}) {
  const backend = profile.backend ?? 'llamacpp';
  const neutral = ['temperature', 'top_k', 'top_p', 'min_p', 'typ_p', 'tfs', 'xtc', 'mirostat', 'dynamic_temperature'];
  const order = normaliseOrder(profile.order, backend);
  return createSamplerProfile({
    ...profile,
    backend,
    order,
    enabled: order.filter((id) => !neutral.includes(id)),
  });
}

/** 相对默认顺序改了什么（界面上一句话说清）。 */
export function describeDiff(profile = {}) {
  const backend = profile.backend ?? 'llamacpp';
  const defaultOrder = BACKEND_DEFAULT_ORDER[backend] ?? [];
  const current = normaliseOrder(profile.order, backend);
  const moved = [];
  current.forEach((id, index) => {
    const base = defaultOrder.indexOf(id);
    if (base !== -1 && base !== index) moved.push(id);
  });
  const enabled = profile.enabled ?? current;
  const off = current.filter((id) => !enabled.includes(id));
  if (moved.length === 0 && off.length === 0) return '与默认一致';
  const parts = [];
  if (moved.length) parts.push(`顺序改了 ${moved.length} 项`);
  if (off.length) parts.push(`关掉了 ${off.map((id) => SAMPLER_CATALOG.find((item) => item.id === id)?.title ?? id).join('、')}`);
  return parts.join('，');
}
