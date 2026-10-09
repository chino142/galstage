/**
 * Logit Bias 预设：把「哪些词压下去、哪些词抬起来」存成一套，可导入导出。
 *
 * 调参时常用的两组：压制「AI 腔」词（一丝、不易察觉、仿佛），
 * 以及压制「替用户说话」（你点了点头、你说）。
 */

import { ValidationError } from '../errors.mjs';

export const BIAS_RANGE = { min: -100, max: 100 };
export const MAX_ENTRIES = 300;

/** 常见的两套起手预设。 */
export const BUILTIN_LOGIT_PRESETS = [
  {
    id: 'builtin:anti-ai-flavor',
    name: '压 AI 腔',
    summary: '把烂大街的描写短语压下去，让文风更像人写的',
    bias: {
      一丝: -40, 一抹: -40, 不易察觉: -60, 仿佛: -30, 不禁: -30,
      嘴角: -30, 眼中闪过: -60, 勾起: -40, 张了张嘴: -50, 指节泛白: -60,
    },
  },
  {
    id: 'builtin:no-user-voice',
    name: '别替用户说话',
    summary: '压制模型替 {{user}} 行动或说话的写法',
    bias: { 你点了: -50, 你说: -40, 你决定: -50, 你感到: -40, 你意识到: -50 },
  },
];

export function normaliseLogitBias(input = {}) {
  const entries = Object.entries(input ?? {});
  if (entries.length > MAX_ENTRIES) throw new ValidationError(`词表最多 ${MAX_ENTRIES} 条`);
  const bias = {};
  for (const [rawWord, rawValue] of entries) {
    const word = String(rawWord ?? '');
    if (!word) continue;
    if (/^\d+$/.test(word)) throw new ValidationError(`「${word}」是纯数字 token id，这一版只支持文本词表`);
    const value = Number(rawValue);
    if (!Number.isFinite(value)) throw new ValidationError(`「${word}」的权重不是数字`);
    if (value < BIAS_RANGE.min || value > BIAS_RANGE.max) {
      throw new ValidationError(`「${word}」的权重要在 ${BIAS_RANGE.min} 到 ${BIAS_RANGE.max} 之间`);
    }
    bias[word] = Math.round(value);
  }
  return bias;
}

export function normalisePreset(raw = {}) {
  const name = String(raw.name ?? '').trim();
  if (!name) throw new ValidationError('Logit Bias 预设需要名字');
  return {
    id: raw.id ? String(raw.id) : null,
    name,
    summary: String(raw.summary ?? '').trim(),
    bias: normaliseLogitBias(raw.bias ?? {}),
  };
}

/** 合并多个预设；后一个覆盖前一个。 */
export function mergeBias(...presets) {
  const out = {};
  for (const preset of presets) {
    if (!preset) continue;
    Object.assign(out, normaliseLogitBias(preset.bias ?? preset));
  }
  return out;
}

export function describeBias(bias = {}) {
  const entries = Object.entries(bias);
  if (!entries.length) return '空';
  const down = entries.filter(([, value]) => value < 0).length;
  const up = entries.filter(([, value]) => value > 0).length;
  return `${entries.length} 条（压低 ${down} / 抬高 ${up}）`;
}
