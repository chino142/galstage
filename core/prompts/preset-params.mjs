/**
 * 酒馆预设顶层的采样参数 → 我们这边的规范名。
 *
 * 只搬"确实是采样参数"的那几个。预设顶层还躺着一堆别的东西
 * （openai_max_context、wi_format、names_behavior、各种 nudge 提示词…），
 * 照搬会把接口不认识的字段发出去 —— 轻则被忽略，重则整个请求 400，
 * 所以这里用白名单，不在表上的一律不搬。
 *
 * 三档模式（对话页可选）：
 *   common —— temperature / top_p / 两类惩罚 / 种子，各家 OpenAI 兼容接口基本都认
 *   all    —— 再加上只有本地推理后端才认的 top_k / min_p / top_a / repetition_penalty
 *   off    —— 完全不用预设的参数，只用「模型接入」里配的
 */

const COMMON_FIELDS = {
  temperature: 'temperature',
  top_p: 'top_p',
  frequency_penalty: 'frequency_penalty',
  presence_penalty: 'presence_penalty',
  seed: 'seed',
};

const LOCAL_FIELDS = {
  top_k: 'top_k',
  min_p: 'min_p',
  top_a: 'top_a',
  repetition_penalty: 'repetition_penalty',
};

/** 这些值是"等于没设"：没必要占位置，也没必要发给接口。 */
const NEUTRAL = {
  frequency_penalty: 0,
  presence_penalty: 0,
  min_p: 0,
  top_a: 0,
  top_k: 0,
  repetition_penalty: 1,
  seed: -1,
};

export const PRESET_PARAM_MODES = [
  {
    id: 'common',
    title: '常用采样参数',
    note: 'temperature / top_p / 频率与存在惩罚 / 种子 —— OpenAI 兼容接口基本都认，改这几个最安全。',
  },
  {
    id: 'all',
    title: '全部（含本地推理专用）',
    note: '再加上 top_k / min_p / top_a / repetition_penalty。云端中转站可能不认这几个字段。',
  },
  { id: 'off', title: '不用预设的参数', note: '只用「模型接入」里给这个提供方 / 模型配的参数。' },
];

export const PRESET_PARAM_MODE_IDS = PRESET_PARAM_MODES.map((mode) => mode.id);

/**
 * 从预设里取出要用的采样参数（已归一化、已丢掉"等于没设"的值）。
 * 适配器支不支持不在这里管 —— 那是 provider 层的事（见 server/providers/params.mjs）。
 *
 * @param {object} preset  酒馆预设（或它的 data）
 * @param {string} mode    common | all | off
 * @returns {object} 形如 { temperature: 1.09, top_p: 0.98 }
 */
export function presetSamplingParams(preset, mode = 'common') {
  if (!preset || typeof preset !== 'object' || mode === 'off') return {};
  const fields = mode === 'all' ? { ...COMMON_FIELDS, ...LOCAL_FIELDS } : COMMON_FIELDS;
  const out = {};
  for (const [from, to] of Object.entries(fields)) {
    const raw = preset[from];
    if (raw === undefined || raw === null || raw === '') continue;
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    if (NEUTRAL[to] !== undefined && value === NEUTRAL[to]) continue;
    out[to] = value;
  }
  return out;
}
