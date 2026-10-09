/**
 * 酒馆预设**顶层字段**里，我们能照做的那些。
 *
 * 为什么单独一个文件：采样参数（temperature 那一批）走 preset-params.mjs，
 * 剩下的顶层字段是另一类东西 —— 传输方式、推理强度、继续/扮演/群聊的提示词、
 * 世界书与角色字段的格式模板、要不要用系统提示词…… 以前这些是直接丢掉的，
 * 用户就得自己去界面上手抄一遍。这里把它们翻译成我们这边的选项。
 *
 * 取值原则：
 *   · 只在预设**明确写了**的时候才覆盖（没写的字段返回 undefined，保持我们自己的默认）
 *   · 数值做范围钳制，离谱的值宁可不用（例如 openai_max_tokens = 65535 那种"解锁"写法）
 *   · 不认识的、我们没有对应机制的字段一律不碰（见 docs / 上手指南里的说明）
 */

const EFFORT_ALIASES = { min: 'low', minimal: 'low', low: 'low', medium: 'medium', mid: 'medium', high: 'high', max: 'high', maximum: 'high' };
const VERBOSITY_VALUES = ['low', 'medium', 'high'];

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function text(value) {
  const source = String(value ?? '').trim();
  return source || undefined;
}

export function presetOptions(preset) {
  const source = preset && typeof preset === 'object' ? preset : {};
  const out = {};

  // ---- 传输 / 推理 ----
  if (source.stream_openai === false) out.streamMode = 'full';
  else if (source.stream_openai === true) out.streamMode = 'stream';

  const effort = EFFORT_ALIASES[String(source.reasoning_effort ?? '').trim().toLowerCase()];
  if (effort) out.reasoningEffort = effort;
  const verbosity = String(source.verbosity ?? '').trim().toLowerCase();
  if (VERBOSITY_VALUES.includes(verbosity)) out.verbosity = verbosity;

  // 回复上限：只在是个正常数字时才要（65535 这种"解锁"写法也照收，钳到我们要的上限）
  const maxTokens = finite(source.openai_max_tokens);
  if (maxTokens && maxTokens > 0) out.maxTokens = Math.min(65536, Math.max(1, Math.round(maxTokens)));

  // 上下文预算：unlocked = true 表示"用模型真实上限"，那种情况我们不设死预算
  const maxContext = finite(source.openai_max_context);
  if (maxContext && maxContext > 0 && source.max_context_unlocked !== true && maxContext <= 1_000_000) {
    out.contextBudget = Math.round(maxContext);
  }

  // ---- 生成流程里的提示词（我们有等价物才搬）----
  const continueNudge = text(source.continue_nudge_prompt);
  if (continueNudge) out.continueNudge = continueNudge;
  const impersonationPrompt = text(source.impersonation_prompt);
  if (impersonationPrompt) out.impersonateNudge = impersonationPrompt;
  const groupNudge = text(source.group_nudge_prompt);
  if (groupNudge) out.groupNudge = groupNudge;
  const prefill = text(source.assistant_prefill);
  if (prefill) out.prefill = prefill;
  const sendIfEmpty = text(source.send_if_empty);
  if (sendIfEmpty) out.sendIfEmpty = sendIfEmpty;

  if (source.continue_prefill !== undefined) out.continuePrefill = source.continue_prefill === true;
  const continuePostfix = source.continue_postfix;
  if (typeof continuePostfix === 'string' && continuePostfix) out.continuePostfix = continuePostfix;

  // ---- 提示词形状 ----
  if (source.use_sysprompt === false) out.useSystemPrompt = false;
  if (source.squash_system_messages === false) out.squashSystemMessages = false;

  const formats = {
    worldbook: text(source.wi_format),
    scenario: text(source.scenario_format),
    personality: text(source.personality_format),
  };
  if (formats.worldbook || formats.scenario || formats.personality) out.formats = formats;

  return out;
}

/**
 * 把预设的格式模板套到内容上。
 * 酒馆两种写法都见过：`{{scenario}}`（宏占位）和 `{0}`（序号占位）。
 * 模板跟默认写法一样就直接返回原文（不做多余的包装）。
 */
export function applyFormatTemplate(template, macroName, value) {
  const body = String(value ?? '');
  const tpl = String(template ?? '').trim();
  if (!tpl || !body) return body;
  if (tpl === `{{${macroName}}}` || tpl === '{0}') return body;
  const replaced = tpl
    .replace(new RegExp(`\\{\\{${macroName}\\}\\}`, 'gi'), body)
    .replace(/\{0\}/g, body);
  return replaced === tpl ? `${tpl}\n${body}` : replaced;
}
