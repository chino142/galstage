/**
 * Token 估算与花费计算。
 *
 * 硬约束是零依赖，所以不能打包各家 tokenizer（本项目早期版本带过一份
 * BPE 词表，几 MB，不符合"单文件 exe + 零依赖"的方向）。这里用启发式估算：
 *   - CJK 字符（含全角标点）约 1 字 1 token；
 *   - 拉丁字母/数字约 4 字符 1 token；
 *   - 其它符号约 2 字符 1 token。
 * 这是**估算**，不是精确值。模型真实返回的 usage 会覆盖它；界面上会标注"≈"。
 * 真正需要精确值时，等接入 tokenizer 素材或让提供方返回 usage 即可。
 */

const CJK = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF\uFF00-\uFFEF]/u;
const LATIN = /[A-Za-z0-9]/;

export function estimateTokens(text) {
  const value = String(text ?? '');
  if (!value) return 0;
  let cjk = 0;
  let latin = 0;
  let other = 0;
  for (const char of value) {
    if (CJK.test(char)) cjk += 1;
    else if (LATIN.test(char)) latin += 1;
    else other += 1;
  }
  return Math.max(1, Math.ceil(cjk + latin / 4 + other / 2));
}

/** 消息列表的总 token（拼起来估算，省得逐条取整累加偏大）。 */
export function estimateMessagesTokens(messages = []) {
  return messages.reduce((sum, message) => sum + estimateTokens(message.content ?? message), 0);
}

/**
 * 花费。提供方 params 里可以填 priceIn / priceOut（单位：元 / 百万 token）。
 * 没填就是 null —— 界面显示"未配置单价"，而不是假装 0。
 */
export function computeCost(usage, prices = {}) {
  if (!usage) return null;
  const priceIn = Number(prices.priceIn);
  const priceOut = Number(prices.priceOut);
  if (!Number.isFinite(priceIn) && !Number.isFinite(priceOut)) return null;
  const prompt = Number(usage.promptTokens ?? 0);
  const completion = Number(usage.completionTokens ?? 0);
  const cost = (Number.isFinite(priceIn) ? (prompt / 1_000_000) * priceIn : 0) + (Number.isFinite(priceOut) ? (completion / 1_000_000) * priceOut : 0);
  return Number(cost.toFixed(6));
}
