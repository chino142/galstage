/**
 * 按**模型名**自动禁用参数的规则表。
 *
 * 为什么要有这层：适配器表是按协议写的，分辨率到不了单个模型，而各家换代时会
 * 直接"取消某些参数"——最典型的是 Google：
 *   gemini-3.6-flash / gemini-3.7-flash / gemini-3.5-flash-lite 这一代不再接受
 *   temperature / topP / topK / candidateCount（SillyTavern 是直接从请求里删掉再发的，
 *   他们注释里引的就是 Google 那句 "api-changes-and-parameter-updates"）。
 *
 * 所以：**能自动判定的就别让用户手勾**；用户自己的「参数覆盖」是手动兜底。
 * 每条规则 = 匹配模型名的正则 + 要禁掉/要提醒的东西 + 一句给人看的理由。
 */

export const MODEL_PARAM_RULES = [
  {
    id: 'gemini-3-no-sampling',
    // SillyTavern 的写法：3.6 / 3.7 flash 与 3.5 flash-lite
    match: /gemini-3\.[67]-flash|gemini-3\.5-flash-lite/i,
    disable: ['temperature', 'top_p', 'top_k'],
    note: '这一代 Gemini 不再接受 temperature / topP / topK / candidateCount：'
      + '按 Google 的 latest-model 变更与 SillyTavern 的实现，这几个字段一律不发（发了可能被忽略，也可能报错）。',
  },
  {
    id: 'claude-limited-sampling',
    // 某些 Claude 只能留 temperature 和 top_p 之一：这里先提醒，具体留哪个由用户决定
    match: /claude-(opus|sonnet)-4\.[5-9]|claude-5/i,
    conflict: [['temperature', 'top_p']],
    note: '这一代 Claude 属于"受限采样"：temperature 与 top_p 只能留一个 —— 两个都填会被拒。',
  },
];

/** 模型名命中哪些规则。 */
export function rulesForModel(model = '') {
  const name = String(model ?? '');
  if (!name) return [];
  return MODEL_PARAM_RULES.filter((rule) => rule.match.test(name));
}

/**
 * 按模型名算出来的"该禁掉的参数"。
 * @returns {{disable: string[], conflicts: Array<string[]>, notes: string[], ids: string[]}}
 */
export function modelParamPolicy(model = '', { adapter = '' } = {}) {
  void adapter;
  const rules = rulesForModel(model);
  return {
    ids: rules.map((rule) => rule.id),
    disable: [...new Set(rules.flatMap((rule) => rule.disable ?? []))],
    conflicts: rules.flatMap((rule) => rule.conflict ?? []),
    notes: rules.map((rule) => rule.note).filter(Boolean),
  };
}
