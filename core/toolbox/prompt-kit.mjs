/**
 * 出图提示词的「加工台」—— 照酒馆那套扩展（智绘姬）的做法，把提示词管起来。
 *
 * 三件事，按这个顺序做：
 *   1) 词替换：把聊天里的中文 / 口语词换成绘画 tag（"马尾" → "ponytail"）；
 *   2) 风格预设：一套正 / 负提示词（赛璐璐 / 厚涂 / 写实…），一次换整个画风；
 *   3) 质量词：可选的一段"保底正 / 负词"，点一下开关。
 * 三样都**加在**工作流自己的正 / 负提示词后面（不覆盖它）—— 角色 LoRA 触发词、
 * 场景描写、情绪都还在，只是被"翻译"和"润色"了一遍。
 *
 * 纯逻辑：不碰 HTTP / 数据库，能直接单测。
 */

import { detectPromptSlots, tidyPrompt } from './comfy.mjs';

export const DEFAULT_QUALITY_POSITIVE = 'masterpiece, best quality, very aesthetic, absurdres';
export const DEFAULT_QUALITY_NEGATIVE = 'worst quality, low quality, lowres, jpeg artifacts, watermark, signature';

function text(value, max = 1000) {
  return String(value ?? '').slice(0, max);
}

/** 收一收：规则条数、名字长度都设个上限，坏数据不进流程。 */
export function normalisePromptKit(raw = {}) {
  const replacements = (Array.isArray(raw.replacements) ? raw.replacements : [])
    .map((item) => ({ from: text(item?.from, 60).trim(), to: text(item?.to, 200).trim() }))
    .filter((item) => item.from)
    .slice(0, 200);
  const styles = (Array.isArray(raw.styles) ? raw.styles : [])
    .map((item, index) => ({
      id: String(item?.id ?? `style-${index + 1}`).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || `style-${index + 1}`,
      name: text(item?.name, 40).trim() || `风格 ${index + 1}`,
      positive: text(item?.positive).trim(),
      negative: text(item?.negative).trim(),
    }))
    .slice(0, 50);
  return {
    replacements,
    styles,
    activeStyleId: styles.some((item) => item.id === raw.activeStyleId) ? String(raw.activeStyleId) : '',
    quality: {
      enabled: raw.quality?.enabled === true,
      positive: text(raw.quality?.positive ?? DEFAULT_QUALITY_POSITIVE, 500).trim(),
      negative: text(raw.quality?.negative ?? DEFAULT_QUALITY_NEGATIVE, 500).trim(),
    },
  };
}

/** 词替换：逐条扫，`from` 出现几次就换几次（不区分大小写的那种复杂情况先不管）。 */
export function applyReplacements(input, replacements = []) {
  let out = String(input ?? '');
  let count = 0;
  for (const rule of replacements) {
    const from = String(rule?.from ?? '');
    if (!from) continue;
    const pieces = out.split(from);
    if (pieces.length > 1) {
      count += pieces.length - 1;
      out = pieces.join(String(rule?.to ?? ''));
    }
  }
  return { text: out, count };
}

/**
 * 把加工台套到一份已经渲染好的工作流上。
 *
 * @returns {{prompt:object, summary:{replaced:number, style:string|null, quality:boolean, touched:string[]}}}
 */
export function applyPromptKit(prompt, rawKit = {}) {
  const kit = normalisePromptKit(rawKit);
  const style = kit.styles.find((item) => item.id === kit.activeStyleId) ?? null;
  const extraPositive = [style?.positive, kit.quality.enabled ? kit.quality.positive : ''].map((item) => String(item ?? '').trim()).filter(Boolean);
  const extraNegative = [style?.negative, kit.quality.enabled ? kit.quality.negative : ''].map((item) => String(item ?? '').trim()).filter(Boolean);
  const summary = { replaced: 0, style: style?.name ?? null, quality: kit.quality.enabled, touched: [] };
  if (!kit.replacements.length && !extraPositive.length && !extraNegative.length) return { prompt, summary };

  const slots = detectPromptSlots(prompt);
  const touch = (slot, extras, label) => {
    if (!slot) return;
    const node = prompt?.[slot.nodeId];
    if (!node?.inputs || !(slot.input in node.inputs)) return;
    const replaced = applyReplacements(String(node.inputs[slot.input] ?? ''), kit.replacements);
    summary.replaced += replaced.count;
    node.inputs[slot.input] = tidyPrompt([replaced.text, ...extras].join(', '));
    summary.touched.push(label);
  };
  touch(slots?.positive, extraPositive, 'positive');
  touch(slots?.negative, extraNegative, 'negative');
  return { prompt, summary };
}

/** 界面用：给一张当前生效的"总览"，让人一眼看清会加什么。 */
export function describePromptKit(raw = {}) {
  const kit = normalisePromptKit(raw);
  const style = kit.styles.find((item) => item.id === kit.activeStyleId) ?? null;
  return {
    ...kit,
    activeStyle: style,
    effective: {
      positive: [style?.positive, kit.quality.enabled ? kit.quality.positive : ''].filter(Boolean).join(', '),
      negative: [style?.negative, kit.quality.enabled ? kit.quality.negative : ''].filter(Boolean).join(', '),
    },
  };
}
