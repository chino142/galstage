/**
 * 提供方能力位：让界面按"这个模型能做什么"决定显示哪些开关。
 *
 * 抄的是 RisuAI 那套正交拆分——`Provider`（谁）/ `Format`（怎么发）/
 * `Flags`（能做什么）/ `Tokenizer`（怎么数）/ `Parameters`（有哪些旋钮）。
 * 本项目已经有「适配器 + 预设」两层，缺的是中间那一层：能力位。
 *
 * 没有它就会出现"给 Claude 显示 Gemini 的 thinking 档位"这种界面。
 * 有了它，参数面板可以按 flag 显隐，而不是按服务商硬编码 if-else。
 */

/** 能力位词表。id 用 camelCase，和 Risu 的叫法对齐，方便对照源码。 */
export const PROVIDER_FLAGS = [
  { id: 'thinking', title: '思考模式', summary: '支持把推理过程与正文分开输出' },
  { id: 'thinkingBudget', title: '思考预算', summary: '可以用 token 数指定思考长度' },
  { id: 'thinkingAdaptive', title: '自适应思考', summary: '由模型自行决定思考深度，不能指定预算' },
  { id: 'reasoningEffort', title: '推理档位', summary: '接受 low / medium / high 这类档位参数' },
  { id: 'prefill', title: '续写预填', summary: '支持 assistant 前缀续写（prefill）' },
  { id: 'cache', title: '提示词缓存', summary: '会返回缓存命中量，可用于省钱统计' },
  { id: 'promptCaching', title: '缓存标记', summary: '请求里可以打缓存断点' },
  { id: 'vision', title: '图片输入', summary: '能吃图片' },
  { id: 'imageOutput', title: '图片输出', summary: '能直接产出图片' },
  { id: 'audioInput', title: '音频输入', summary: '能吃音频' },
  { id: 'audioOutput', title: '音频输出', summary: '能产出语音' },
  { id: 'streaming', title: '流式', summary: '支持 SSE 流式返回' },
  { id: 'toolCalling', title: '工具调用', summary: '支持 function calling' },
  { id: 'jsonMode', title: '结构化输出', summary: '支持 JSON 模式或 schema 约束' },
  { id: 'logprobs', title: 'Logprobs', summary: '返回 token 概率' },
  { id: 'logitBias', title: 'Logit Bias', summary: '接受逐词加权' },
  { id: 'seed', title: '随机种子', summary: '接受固定 seed' },
  { id: 'stopStrings', title: '自定义停止串', summary: '接受自定义停止串' },
  { id: 'systemPrompt', title: '独立系统提示', summary: '有独立的 system 角色位' },
  { id: 'developerRole', title: 'developer 角色', summary: '用 developer 而不是 system' },
  { id: 'firstSystemOnly', title: '只认首条系统提示', summary: 'system 只能放最前面' },
  { id: 'alternateRole', title: '必须交替发言', summary: '强制 user / assistant 交替' },
  { id: 'mustStartWithUser', title: '必须以用户开头', summary: '第一条必须是 user' },
  { id: 'aiflag', title: 'AI 味开关', summary: '可通过参数降低官方的"AI 腔"倾向' },
];

const FLAG_IDS = new Set(PROVIDER_FLAGS.map((flag) => flag.id));

/** 每个适配器的默认能力位。预设可以在上面覆盖。 */
export const ADAPTER_FLAGS = {
  openai: ['streaming', 'toolCalling', 'vision', 'jsonMode', 'seed', 'stopStrings', 'systemPrompt', 'logitBias', 'prefill'],
  azure: ['streaming', 'toolCalling', 'vision', 'jsonMode', 'seed', 'stopStrings', 'systemPrompt', 'logitBias', 'prefill'],
  anthropic: ['streaming', 'toolCalling', 'vision', 'systemPrompt', 'firstSystemOnly', 'thinking', 'thinkingBudget', 'cache', 'promptCaching', 'prefill', 'aiflag'],
  gemini: ['streaming', 'toolCalling', 'vision', 'audioInput', 'jsonMode', 'systemPrompt', 'thinking', 'thinkingBudget', 'logprobs', 'stopStrings'],
  vertex: ['streaming', 'toolCalling', 'vision', 'systemPrompt', 'thinking', 'thinkingBudget', 'cache'],
  text: ['streaming', 'stopStrings', 'logitBias', 'seed', 'logprobs'],
};

/** 预设级覆盖：只写和适配器默认不一样的地方。 */
export const PRESET_FLAG_OVERRIDES = {
  openai: ['reasoningEffort', 'developerRole', 'promptCaching'],
  'openai-response': ['reasoningEffort', 'developerRole'],
  deepseek: ['thinking', 'thinkingBudget', 'cache', 'reasoningEffort', 'aiflag'],
  moonboat: [],
  moonshot: ['thinking', 'thinkingBudget'],
  zhipu: ['thinking', 'toolCalling'],
  siliconflow: ['reasoningEffort'],
  groq: ['reasoningEffort', 'toolCalling'],
  xai: ['reasoningEffort', 'vision'],
  openrouter: ['reasoningEffort', 'promptCaching', 'cache', 'vision'],
  together: ['reasoningEffort'],
  mistral: ['jsonMode', 'toolCalling'],
  ollama: ['seed', 'stopStrings', 'jsonMode'],
  lmstudio: ['seed', 'stopStrings', 'jsonMode', 'logprobs'],
  llamacpp: ['seed', 'stopStrings', 'logitBias', 'logprobs', 'jsonMode'],
  koboldcpp: ['seed', 'stopStrings', 'logitBias', 'logprobs', 'aiflag'],
  vllm: ['seed', 'stopStrings', 'logitBias', 'logprobs'],
  vertex: ['thinking', 'thinkingBudget', 'cache', 'vision'],
  'vertex-gemini': ['thinking', 'thinkingBudget', 'cache', 'vision'],
  'vertex-claude': ['thinking', 'thinkingBudget', 'cache', 'promptCaching', 'prefill', 'vision'],
  'claude-cli': ['thinking', 'thinkingBudget', 'firstSystemOnly', 'prefill'],
  'gemini-cli': ['streaming', 'vision', 'thinking'],
  relay: ['streaming', 'systemPrompt', 'stopStrings', 'seed'],
};

/**
 * 取某个预设的能力位：适配器默认 + 预设覆盖。
 * @param {string} adapter 适配器 id
 * @param {string} [presetId] 预设 id
 */
export function flagsFor(adapter, presetId = null) {
  const base = new Set(ADAPTER_FLAGS[adapter] ?? []);
  const override = presetId ? PRESET_FLAG_OVERRIDES[presetId] : null;
  if (override) for (const flag of override) base.add(flag);
  return [...base].filter((flag) => FLAG_IDS.has(flag));
}

export function supports(flags = [], flag) {
  return flags.includes(flag);
}

/**
 * 参数面板该显示哪些开关。
 *
 * gate 是"这个参数需要哪个能力位"；没有 gate 的一律显示。
 * 这就是"能力位驱动 UI"的落地方式：加一个参数只要在表里写 gate，
 * 不需要在界面代码里写 if (provider === 'claude')。
 */
export const PARAM_GATES = [
  { id: 'reasoningEffort', title: '推理档位', gate: 'reasoningEffort', choices: ['auto', 'min', 'low', 'medium', 'high', 'max'] },
  { id: 'thinkingBudget', title: '思考预算（token）', gate: 'thinkingBudget', type: 'number' },
  { id: 'thinkingAdaptive', title: '自适应思考', gate: 'thinkingAdaptive', type: 'boolean' },
  { id: 'jsonMode', title: '结构化输出', gate: 'jsonMode', type: 'boolean' },
  { id: 'logitBias', title: 'Logit Bias', gate: 'logitBias', type: 'json' },
  { id: 'seed', title: '随机种子', gate: 'seed', type: 'number' },
  { id: 'stopStrings', title: '自定义停止串', gate: 'stopStrings', type: 'list' },
  { id: 'logprobs', title: '返回 Logprobs', gate: 'logprobs', type: 'boolean' },
  { id: 'prefill', title: '续写预填', gate: 'prefill', type: 'string' },
  { id: 'visionInput', title: '允许贴图', gate: 'vision', type: 'boolean' },
  { id: 'temperature', title: '温度' },
  { id: 'topP', title: 'Top-P' },
  { id: 'maxTokens', title: '回复上限 max_tokens' },
];

/**
 * 给定能力位，返回参数面板该显示的项与该项被隐藏的原因。
 */
export function visibleParams(flags = []) {
  const list = [];
  for (const param of PARAM_GATES) {
    if (!param.gate) {
      list.push({ ...param, visible: true });
      continue;
    }
    const visible = flags.includes(param.gate);
    list.push({ ...param, visible, reason: visible ? null : `该模型不支持「${param.title}」，已隐藏` });
  }
  return list;
}

/** 给界面用的：能力位带上中文名。 */
export function describeFlags(flags = []) {
  return flags.map((id) => PROVIDER_FLAGS.find((flag) => flag.id === id)).filter(Boolean);
}
