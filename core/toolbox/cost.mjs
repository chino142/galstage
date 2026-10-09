/**
 * 花费相关的纯逻辑：用量归一化、算钱、缓存节省、预估 vs 实际。
 *
 * 各家的 usage 字段名不一样，这里统一成一套（和 server/providers/adapters.mjs
 * 已经归一化的 {promptTokens, completionTokens, totalTokens} 兼容，同时多认几种
 * 缓存字段，方便以后提供方把缓存命中一起报上来）：
 *   OpenAI      prompt_tokens / completion_tokens / total_tokens
 *               prompt_tokens_details.cached_tokens
 *   Anthropic   input_tokens / output_tokens / cache_read_input_tokens
 *   Gemini      promptTokenCount / candidatesTokenCount / totalTokenCount
 *               cachedContentTokenCount
 *
 * 缓存字段：适配层（server/providers/adapters.mjs）会把各家的缓存命中数
 * 归一成 `cachedTokens` 一起发过来，所以这里能直接读到；提供方没上报时才是 0。
 */

/** 从各家形状里抠出统一的用量。 */
export function normaliseUsage(usage = {}) {
  const source = usage && typeof usage === 'object' ? usage : {};
  const promptTokens = num(source.promptTokens ?? source.prompt_tokens ?? source.input_tokens ?? source.promptTokenCount);
  const completionTokens = num(source.completionTokens ?? source.completion_tokens ?? source.output_tokens ?? source.candidatesTokenCount);
  const totalTokens = num(source.totalTokens ?? source.total_tokens ?? source.totalTokenCount) || promptTokens + completionTokens;
  const cachedTokens = num(
    source.cachedTokens ??
      source.cacheReadTokens ??
      source.prompt_tokens_details?.cached_tokens ??
      source.cache_read_input_tokens ??
      source.cachedContentTokenCount ??
      source.input_tokens_details?.cached_tokens,
  );
  return { promptTokens, completionTokens, totalTokens, cachedTokens };
}

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * 缓存命中省下的钱。
 * 命中的输入 token 本来要按 priceIn 收，实际只按 priceIn * discount 收，
 * 所以省下 cachedTokens * priceIn * (1 - discount)。
 */
export function cacheSavings({ cachedTokens = 0, priceIn = null, discount = 0.1 } = {}) {
  const cached = Number(cachedTokens ?? 0);
  const price = Number(priceIn);
  if (!Number.isFinite(price) || cached <= 0) return 0;
  const rate = Math.min(1, Math.max(0, Number(discount) || 0));
  return Number(((cached / 1_000_000) * price * (1 - rate)).toFixed(6));
}

/** 预估 vs 实际：给界面一个"我们的估算偏了多少"的百分比。 */
export function estimationDelta(estimated = 0, actual = 0) {
  const est = Number(estimated ?? 0);
  const act = Number(actual ?? 0);
  if (!act) return { estimated: est, actual: act, diff: est - act, percent: null };
  return { estimated: est, actual: act, diff: est - act, percent: Number((((est - act) / act) * 100).toFixed(1)) };
}

/** 把 totals 里的数字统一成"界面能直接显示"的形状。 */
export function describeTotals(totals = {}) {
  return {
    turns: Number(totals.turns ?? 0),
    promptTokens: Number(totals.promptTokens ?? 0),
    completionTokens: Number(totals.completionTokens ?? 0),
    totalTokens: Number(totals.totalTokens ?? 0),
    cachedTokens: Number(totals.cachedTokens ?? 0),
    cost: Number(Number(totals.cost ?? 0).toFixed(6)),
    cacheSavings: Number(Number(totals.cacheSavings ?? 0).toFixed(6)),
    unpricedTurns: Number(totals.unpricedTurns ?? 0),
    reportedTurns: Number(totals.reportedTurns ?? 0),
    estimatedTurns: Number(totals.turns ?? 0) - Number(totals.reportedTurns ?? 0),
    prompt: estimationDelta(totals.estimatedPromptTokens, totals.promptTokens),
    completion: estimationDelta(totals.estimatedCompletionTokens, totals.completionTokens),
  };
}

/** 按天统计补零：没有用量的日子也要出现在表里，不然折线会跳。 */
export function fillDays(rows = [], days = 14, now = new Date()) {
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const out = [];
  for (let index = days - 1; index >= 0; index -= 1) {
    const date = new Date(now.getTime() - index * 86400000);
    const key = date.toISOString().slice(0, 10);
    const found = byKey.get(key);
    out.push(
      found
        ? found
        : {
            key,
            turns: 0,
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            cachedTokens: 0,
            estimatedPromptTokens: 0,
            estimatedCompletionTokens: 0,
            cost: 0,
            cacheSavings: 0,
            unpricedTurns: 0,
            reportedTurns: 0,
          },
    );
  }
  return out;
}

/**
 * 兜底用的示例价目（元 / 百万 token）。
 *
 * 只在"一个提供方都还没配"的时候才会显示 —— 界面上那排「+ 模型名」按钮优先用
 * **你自己配的提供方与模型绑定**（见 server/api/toolbox.mjs 的 pricingSuggestions）。
 * 写死一张表的下场就是过一阵全是老型号，所以这份只当空库时的占位示例，
 * 价格仍按当时核对的官方价，用户自己改。
 */
export const PRICE_PRESETS = [
  { label: 'GPT-4o', model: 'gpt-4o', priceIn: 18, priceOut: 72 },
  { label: 'GPT-4o mini', model: 'gpt-4o-mini', priceIn: 1.1, priceOut: 4.4 },
  { label: 'Claude Sonnet', model: 'claude-3-5-sonnet', priceIn: 22, priceOut: 110 },
  { label: 'Claude Haiku', model: 'claude-3-5-haiku', priceIn: 5.8, priceOut: 29 },
  { label: 'Gemini 1.5 Pro', model: 'gemini-1.5-pro', priceIn: 8.7, priceOut: 35 },
  { label: 'DeepSeek V3', model: 'deepseek-chat', priceIn: 1.4, priceOut: 5.6 },
];
