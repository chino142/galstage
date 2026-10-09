import { describeFlags, flagsFor } from '../../core/providers-flags.mjs';

/**
 * 采样参数表 —— **按适配器分开**，而且是唯一真相。
 *
 * 为什么必须按适配器分：各家能填的东西根本不一样。
 *   · OpenAI 方言（含 DeepSeek / Kimi / GLM / 硅基流动 / Ollama / vLLM…）：
 *     temperature、top_p、frequency_penalty、presence_penalty、seed、stop、max_tokens…
 *   · Anthropic：没有 frequency/presence penalty，但有 top_k；上限叫 max_tokens 且必填。
 *   · Gemini / Vertex：字段名都不一样 —— topP、topK、maxOutputTokens、stopSequences。
 *   · 旧的 /v1/completions（llama.cpp / KoboldCpp 那类）：又多出 min_p、top_a、
 *     repetition_penalty 这些本地推理才有的旋钮。
 * 所以"给所有模型列同一排输入框"是错的：填了也不会被转发，纯属误导。
 *
 * 这份表同时被三处使用，避免三处各写一份导致漂移：
 *   1) 界面：照它生成输入框（server/api/platform.mjs 把它发给前端）
 *   2) 校验：保存时按 type/min/max 检查（validateAdapterParams）
 *   3) 发请求：按 field 映射成各家真正的字段名（adapterParamMap → pickParams）
 *
 * 字段说明：
 *   key     存进 provider.params 的规范名
 *   field   真正发给提供方的字段名（默认与 key 相同）
 *   manual  true = 适配器自己处理这个字段（例如 Anthropic 的 max_tokens 写在
 *           payload 顶层、Gemini 写在 generationConfig 里），不要塞进通用映射
 */

/**
 * 每个参数"需要哪个能力位"。
 *
 * 有了它，界面就能按**当前模型**把不支持的参数标出来 / 置灰，而不是让你填一个
 * 永远不会被转发出去的旋钮（生成器里那些字段名各家不一样，填了也没用）。
 * 没写的参数 = 任何适配器都能填。
 */
const PARAM_FLAG_HINTS = {
  seed: 'seed',
  stop: 'stopStrings',
  stopSequences: 'stopStrings',
  logit_bias: 'logitBias',
  logprobs: 'logprobs',
  top_logprobs: 'logprobs',
  reasoning_effort: 'reasoningEffort',
  thinking_budget: 'thinkingBudget',
  thinkingBudget: 'thinkingBudget',
  streamMode: 'streaming',
};

const TEMPERATURE = {
  key: 'temperature',
  label: '温度 temperature',
  type: 'number',
  min: 0,
  max: 2,
  step: 0.05,
  help: '越高越随机。角色扮演一般 0.7~1.1；要稳定复现就调低。',
};

const TOP_P = { key: 'top_p', label: '核采样 top_p', type: 'number', min: 0, max: 1, step: 0.01, help: '通常和温度二选一调，别两个一起大改。' };
const TOP_K = { key: 'top_k', label: 'top_k', type: 'int', min: 0, max: 500, step: 1, help: '0 表示关闭。Anthropic 默认开启，OpenAI 系多数不支持（填了可能被忽略）。' };
const MAX_TOKENS = {
  key: 'max_tokens',
  label: '回复上限 max_tokens',
  type: 'int',
  min: 1,
  max: 65536,
  step: 1,
  default: 1024,
  help: '硬上限：写超过这个长度会被中途截断（finish 会是 length）。中文大约 1 token ≈ 1.5 字，想要 600 字以上就调到 1500 以上。',
};
const STOP = { key: 'stop', label: '停止词 stop', type: 'list', help: '一行一个；命中就停止生成。留空表示不加。' };

/**
 * Google 系（Gemini / Vertex）的"安全设置"。
 *
 * manual = 适配器自己把这个字段放到请求体的**顶层**（不是 generationConfig 里）。
 * 不标 manual 的话，它会被当成普通采样参数塞进 generationConfig，Google 会报"不认识的字段"。
 */
const SAFETY_SETTINGS = {
  key: 'safetySettings',
  label: '安全设置 safetySettings',
  type: 'json',
  manual: true,
  help: 'JSON 数组。留空 = 用 Google 默认档位；想放宽就填四类阈值，例如 '
    + '[{"category":"HARM_CATEGORY_HARASSMENT","threshold":"BLOCK_NONE"},'
    + '{"category":"HARM_CATEGORY_HATE_SPEECH","threshold":"BLOCK_NONE"},'
    + '{"category":"HARM_CATEGORY_SEXUALLY_EXPLICIT","threshold":"BLOCK_NONE"},'
    + '{"category":"HARM_CATEGORY_DANGEROUS_CONTENT","threshold":"BLOCK_NONE"}]。'
    + '阈值从松到紧：BLOCK_NONE > BLOCK_ONLY_HIGH > BLOCK_MEDIUM_AND_ABOVE > BLOCK_LOW_AND_ABOVE。'
    + '注意：只有 Google 系认这个参数，个别类别（尤其涉及未成年人的）是硬墙、关不掉；'
    + '走中转站时对方可能直接忽略，参数不报错 ≠ 真生效。',
};

/**
 * 输出方式：流式 / 整段返回。
 * 这不是发给提供方的字段（manual = 适配器自己用）：有些中转站不支持流式，或者流式会断在半路，
 * 选"整段返回"就退回一次普通请求，等它写完再一次性显示。
 */
const STREAM_MODE = {
  key: 'streamMode',
  label: '输出方式',
  type: 'enum',
  options: ['stream', 'full'],
  optionLabels: { stream: '流式（逐字出现，推荐）', full: '整段返回（非流式）' },
  manual: true,
  help: '流式 = 边生成边显示。有些服务 / 中转站的流式会断，或者模型只支持整段返回，那就选"整段返回"（等它写完，最后一次性出现）。',
};

export const ADAPTER_PARAM_SCHEMA = {
  openai: {
    title: 'OpenAI 兼容',
    note: 'OpenAI / DeepSeek / Kimi / GLM / 硅基流动 / Groq / OpenRouter / Ollama / LM Studio / vLLM 都走这套。带 * 的是大多数后端支持、少见的填了可能被忽略。',
    params: [
      STREAM_MODE,
      TEMPERATURE,
      TOP_P,
      MAX_TOKENS,
      { key: 'frequency_penalty', label: '频率惩罚 frequency_penalty', type: 'number', min: -2, max: 2, step: 0.05, help: '正数减少重复用词。' },
      { key: 'presence_penalty', label: '存在惩罚 presence_penalty', type: 'number', min: -2, max: 2, step: 0.05, help: '正数鼓励换话题。' },
      { key: 'seed', label: '随机种子 seed', type: 'int', min: 0, max: 2147483647, step: 1, help: '填了且后端支持时，同参数会得到接近的结果。' },
      STOP,
      { ...TOP_K, label: 'top_k *' },
      { key: 'repetition_penalty', label: '重复惩罚 repetition_penalty *', type: 'number', min: 0, max: 3, step: 0.05, help: '本地推理（Ollama / llama.cpp / vLLM）常用，云端多不支持。' },
      { key: 'min_p', label: 'min_p *', type: 'number', min: 0, max: 1, step: 0.01, help: '本地推理常用，比 top_p 更干净。' },
      { key: 'top_a', label: 'top_a *', type: 'number', min: 0, max: 1, step: 0.01 },
      { key: 'reasoning_effort', label: '推理强度 reasoning_effort', type: 'enum', options: ['low', 'medium', 'high'], help: '只有推理型模型认这个（o 系列、部分中转）。' },
      { key: 'verbosity', label: '啰嗦程度 verbosity', type: 'enum', options: ['low', 'medium', 'high'], help: 'GPT-5 那类新接口认这个；别的后端会忽略。' },
      { key: 'logprobs', label: '返回 logprobs', type: 'boolean' },
      { key: 'top_logprobs', label: 'top_logprobs', type: 'int', min: 0, max: 20, step: 1 },
      { key: 'logit_bias', label: 'logit_bias', type: 'json', help: 'JSON 对象，例如 {"50256": -100}。' },
    ],
  },

  azure: {
    title: 'Azure OpenAI',
    note: '请求体和 OpenAI 一样，但字段比 OpenAI 少（Azure 不收 top_k / min_p 这些）。',
    params: [
      STREAM_MODE,
      TEMPERATURE,
      TOP_P,
      MAX_TOKENS,
      { key: 'frequency_penalty', label: '频率惩罚 frequency_penalty', type: 'number', min: -2, max: 2, step: 0.05 },
      { key: 'presence_penalty', label: '存在惩罚 presence_penalty', type: 'number', min: -2, max: 2, step: 0.05 },
      { key: 'seed', label: '随机种子 seed', type: 'int', min: 0, max: 2147483647, step: 1 },
      STOP,
      { key: 'reasoning_effort', label: '推理强度 reasoning_effort', type: 'enum', options: ['low', 'medium', 'high'] },
      { key: 'logprobs', label: '返回 logprobs', type: 'boolean' },
      { key: 'top_logprobs', label: 'top_logprobs', type: 'int', min: 0, max: 20, step: 1 },
      { key: 'apiVersion', label: 'api-version', type: 'string', help: '一般留空，用内置默认。' },
    ],
  },

  anthropic: {
    title: 'Anthropic',
    note: '没有 frequency/presence penalty；上下文更长，max_tokens 是必填项（这里不填就用默认 1024）。',
    params: [
      STREAM_MODE,
      { ...TEMPERATURE, max: 1, help: 'Anthropic 的范围是 0~1，超过会被拒。' },
      TOP_P,
      { ...TOP_K, max: 250, help: '留空 = 用 Anthropic 自己的默认（开启）。' },
      { ...MAX_TOKENS, max: 128000, manual: true },
      { ...STOP, manual: true, label: '停止序列 stop_sequences' },
    ],
  },

  gemini: {
    title: 'Google Gemini',
    note: '字段名和别家不一样：topP、topK、maxOutputTokens、stopSequences（已自动映射，你按常用名填就行）。',
    params: [
      STREAM_MODE,
      TEMPERATURE,
      { ...TOP_P, field: 'topP' },
      { ...TOP_K, field: 'topK', min: 1, max: 200 },
      { ...MAX_TOKENS, field: 'maxOutputTokens', max: 65536, manual: true },
      { ...STOP, manual: true, label: '停止序列 stopSequences' },
      SAFETY_SETTINGS,
    ],
  },

  vertex: {
    title: 'Google Vertex AI',
    note: '和 Gemini 同一套生成参数，另外多了项目 / 区域 / 认证方式这些连接参数。',
    params: [
      STREAM_MODE,
      TEMPERATURE,
      { ...TOP_P, field: 'topP' },
      { ...TOP_K, field: 'topK', min: 1, max: 200 },
      { ...MAX_TOKENS, field: 'maxOutputTokens', max: 65536, manual: true },
      { ...STOP, manual: true, label: '停止序列 stopSequences' },
      SAFETY_SETTINGS,
      {
        key: 'vertexMode',
        label: '认证方式 vertexMode',
        type: 'enum',
        options: ['express', 'serviceAccount'],
        manual: true,
        help: 'express = 用 API Key（走 aiplatform.googleapis.com 的全局端点）；'
          + 'serviceAccount = 用服务账号 JSON（自己换 OAuth2 令牌，下面三项要填）。',
      },
      { key: 'project', label: 'project（项目号）', type: 'string', manual: true, help: '服务账号模式必填，例如 my-gcp-project。' },
      { key: 'location', label: 'location（区域）', type: 'string', manual: true, help: '例如 us-central1。填 global 时用全局端点。留空默认 us-central1。' },
      { key: 'serviceAccount', label: '服务账号 JSON', type: 'json', manual: true, help: '把服务账号密钥文件的整段 JSON 粘进来（含 client_email 和 private_key）。只存在你自己的数据目录里。' },
    ],
  },

  text: {
    title: '文本补全（/v1/completions）',
    note: 'llama.cpp server / KoboldCpp / 老接口走这条。本地推理的旋钮最多，但也最挑后端。',
    params: [
      STREAM_MODE,
      TEMPERATURE,
      TOP_P,
      { key: 'top_k', label: 'top_k', type: 'int', min: 0, max: 200, step: 1 },
      { key: 'min_p', label: 'min_p', type: 'number', min: 0, max: 1, step: 0.01, help: '本地推理推荐 0.05 左右。' },
      { key: 'top_a', label: 'top_a', type: 'number', min: 0, max: 1, step: 0.01 },
      { key: 'repetition_penalty', label: '重复惩罚 repetition_penalty', type: 'number', min: 0, max: 3, step: 0.05 },
      { key: 'frequency_penalty', label: '频率惩罚 frequency_penalty', type: 'number', min: -2, max: 2, step: 0.05 },
      { key: 'presence_penalty', label: '存在惩罚 presence_penalty', type: 'number', min: -2, max: 2, step: 0.05 },
      { key: 'seed', label: '随机种子 seed', type: 'int', min: 0, max: 2147483647, step: 1 },
      { ...MAX_TOKENS, key: 'max_tokens', help: '这一路有些后端用 max_tokens、有些用 n_predict，本适配器发的是 max_tokens。' },
      STOP,
    ],
  },
};

/** 取某个适配器的参数表；不认识的适配器按 OpenAI 方言处理。 */
export function adapterParamSchema(adapter) {
  const schema = ADAPTER_PARAM_SCHEMA[adapter];
  if (schema) return { id: adapter, ...schema };
  return { id: 'openai', ...ADAPTER_PARAM_SCHEMA.openai };
}

/** key → 实际字段名（manual 的跳过：那些字段适配器自己塞）。 */
export function adapterParamMap(adapter) {
  const map = {};
  for (const item of adapterParamSchema(adapter).params) {
    if (item.manual) continue;
    map[item.key] = item.field ?? item.key;
  }
  return map;
}

/**
 * 只留下这个适配器参数表里声明过的键。
 * 用在"参数不是用户填的"场合（比如从酒馆预设搬过来的采样参数）：宁可少发，也别把
 * 这家接口不认识的字段塞进请求体。值原样保留，不做范围校验（预设里的值不该直接抛错）。
 */
export function pickDeclaredParams(adapter, params = {}) {
  const declared = new Set(adapterParamSchema(adapter).params.map((item) => item.key));
  const out = {};
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    if (declared.has(key)) out[key] = value;
  }
  return out;
}

/** 前端的输入框描述（去掉内部字段，只留界面要用的）。 */
export function adapterParamForm(adapter) {
  const schema = adapterParamSchema(adapter);
  return {
    id: schema.id,
    title: schema.title,
    note: schema.note,
    params: schema.params.map((item) => ({
      key: item.key,
      label: item.label,
      type: item.type,
      min: item.min ?? null,
      max: item.max ?? null,
      step: item.step ?? null,
      default: item.default ?? null,
      options: item.options ?? null,
      optionLabels: item.optionLabels ?? null,
      help: item.help ?? null,
      // 这个参数需要哪个能力位 + 当前适配器支不支持（界面据此置灰并写"这个模型不支持"）
      flag: PARAM_FLAG_HINTS[item.key] ?? null,
      supported: !PARAM_FLAG_HINTS[item.key] || flagsFor(adapter, null).includes(PARAM_FLAG_HINTS[item.key]),
    })),
    // 这套适配器"能做什么"（给界面写"不支持"的理由用）
    flags: flagsFor(adapter, null),
    flagVocabulary: describeFlags(flagsFor(adapter, null)),
  };
}

/**
 * 校验并归一化一份参数。
 *   · 表里的字段：按类型与范围检查，越界直接报错（说清是哪个字段、允许什么范围）
 *   · 表外字段：原样保留 —— 各家奇特参数（自定义 API 的怪字段）不该因为表里没有就丢掉
 */
export function validateAdapterParams(adapter, params = {}) {
  const schema = adapterParamSchema(adapter);
  const known = new Map(schema.params.map((item) => [item.key, item]));
  const out = {};
  const problems = [];

  for (const [key, raw] of Object.entries(params ?? {})) {
    const spec = known.get(key);
    if (!spec) {
      out[key] = raw; // 表外字段原样带过去
      continue;
    }
    if (raw === undefined || raw === null || raw === '') continue; // 留空 = 不发送
    if (spec.type === 'number' || spec.type === 'int') {
      const value = Number(raw);
      if (!Number.isFinite(value)) { problems.push(`${spec.label} 要填数字（收到 ${JSON.stringify(raw)}）`); continue; }
      if (spec.type === 'int' && !Number.isInteger(value)) { problems.push(`${spec.label} 要填整数`); continue; }
      if (spec.min !== undefined && value < spec.min) { problems.push(`${spec.label} 不能小于 ${spec.min}`); continue; }
      if (spec.max !== undefined && value > spec.max) { problems.push(`${spec.label} 不能大于 ${spec.max}`); continue; }
      out[key] = value;
      continue;
    }
    if (spec.type === 'boolean') {
      out[key] = raw === true || raw === 'true' || raw === 1 || raw === '1';
      continue;
    }
    if (spec.type === 'enum') {
      if (!spec.options?.includes(raw)) { problems.push(`${spec.label} 只能是 ${spec.options.join(' / ')}`); continue; }
      out[key] = raw;
      continue;
    }
    if (spec.type === 'list') {
      const list = Array.isArray(raw) ? raw : String(raw).split('\n');
      const cleaned = list.map((item) => String(item ?? '').trim()).filter(Boolean);
      if (cleaned.length) out[key] = cleaned;
      continue;
    }
    if (spec.type === 'json') {
      if (typeof raw === 'string') {
        try {
          out[key] = JSON.parse(raw);
        } catch {
          problems.push(`${spec.label} 要填合法 JSON`);
        }
      } else {
        out[key] = raw;
      }
      continue;
    }
    out[key] = raw;
  }

  if (problems.length) {
    const error = new Error(`采样参数有问题：${problems.join('；')}`);
    error.code = 'VALIDATION_ERROR';
    throw error;
  }
  return out;
}
