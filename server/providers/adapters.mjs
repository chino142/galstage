/**
 * 模型适配层。
 *
 * 五个适配器全部收敛到同一个异步生成器接口，上层不关心是哪一家：
 *   streamChat({ adapter, baseUrl, apiKey, model, messages, system, params, signal })
 *   产出 { type: 'text' | 'thinking' | 'logprobs' | 'usage' | 'finish' | 'done' }
 *
 * 请求形状移植自本项目早期版本（那版已按各家文档核对过），这里重写了注释与
 * 参数归一化部分。Anthropic 与 Azure 的字段差异见各自函数上的说明。
 */

import { DEFAULT_AZURE_API_VERSION, ANTHROPIC_VERSION } from './catalog.mjs';
import { resolveAuth, withQuery } from './auth.mjs';
// 采样参数的唯一真相在 params.mjs：界面照它渲染、保存照它校验、这里照它映射字段。
// 以前是各个适配器手写一份映射表，很容易出现"界面能填、发出去被丢掉"。
import { adapterParamMap } from './params.mjs';
// 出网统一走这里：配了网络代理就走代理，没配就是普通 fetch。
import { httpFetch } from './http.mjs';
import { applyImagesToMessages, toGeminiParts } from '../../core/media/vision.mjs';

function joinUrl(base, path) {
  return `${String(base || '').replace(/\/+$/, '')}${path}`;
}

/** Azure 把部署名放在路径里；用户可能把 `/openai` 一起粘进来，这里去掉。 */
function azureUrl(baseUrl, deployment, path, apiVersion) {
  const base = String(baseUrl || '')
    .replace(/\/+$/, '')
    .replace(/\/openai$/i, '');
  const version = apiVersion || DEFAULT_AZURE_API_VERSION;
  return `${base}/openai/deployments/${encodeURIComponent(deployment)}${path}?api-version=${encodeURIComponent(version)}`;
}

/** 逐行解析 SSE。空行与 `:` 开头的注释行直接跳过，`[DONE]` 结束流。 */
export async function* parseSSE(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      let line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (!line || line.startsWith(':')) continue;
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      if (payload === '[DONE]') return;
      try {
        yield JSON.parse(payload);
      } catch {
        // 半截帧或心跳，忽略
      }
    }
  }
}

export async function readError(response) {
  let detail = '';
  try {
    const text = await response.text();
    try {
      const json = JSON.parse(text);
      detail = json?.error?.message ?? json?.message ?? text;
    } catch {
      detail = text;
    }
  } catch {
    // 读不到就算了
  }
  return `${response.status} ${response.statusText}${detail ? ` — ${String(detail).slice(0, 400)}` : ''}`;
}

function pickParams(source = {}, mapping) {
  const out = {};
  for (const [from, to] of Object.entries(mapping)) {
    const value = source[from];
    if (value === undefined || value === null || value === '') continue;
    out[to] = value;
  }
  return out;
}

/**
 * 函数调用（工具）这一块的公共零件。
 *
 * 三家的形状差得远，但上层只想看到一个东西：`{ id, name, arguments }`，
 * `arguments` 已经是从 JSON 解出来的对象。这里集中做归一化，别让上层认三种方言。
 */

/** 各家的工具定义 → OpenAI 的 `{type:'function', function:{...}}`。 */
export function openAIToolDefinitions(tools = []) {
  return (Array.isArray(tools) ? tools : [])
    .filter((tool) => tool && tool.name)
    .map((tool) => ({
      type: 'function',
      function: {
        name: String(tool.name),
        ...(tool.description ? { description: String(tool.description) } : {}),
        parameters: tool.parameters && typeof tool.parameters === 'object' ? tool.parameters : { type: 'object', properties: {} },
      },
    }));
}

/**
 * 工具定义 → Gemini 的 `tools[].functionDeclarations[]`。
 * Gemini 与 Vertex 共用同一套形状，所以单独抽出来，两边都调这一个。
 */
export function geminiToolPayload(tools = null, toolChoice = null) {
  if (!tools?.length) return {};
  return {
    tools: [{
      functionDeclarations: tools.map((tool) => ({
        name: tool.name,
        ...(tool.description ? { description: String(tool.description) } : {}),
        parameters: tool.parameters ?? { type: 'object', properties: {} },
      })),
    }],
    ...(toolChoice && typeof toolChoice === 'object' ? { toolConfig: { functionCallingConfig: toolChoice } } : {}),
  };
}

/** 工具定义 → Anthropic 的 `tools[]` + `tool_choice`。Vertex 上的 Claude 也用这一套。 */
export function anthropicToolPayload(tools = null, toolChoice = null) {
  if (!tools?.length) return {};
  return {
    tools: tools.map((tool) => ({
      name: tool.name,
      ...(tool.description ? { description: String(tool.description) } : {}),
      input_schema: tool.parameters ?? { type: 'object', properties: {} },
    })),
    tool_choice: toolChoice && typeof toolChoice === 'object' ? toolChoice : { type: toolChoice === 'none' ? 'none' : 'auto' },
  };
}

/**
 * 流式增量拼装（OpenAI 方言）：每个 chunk 可能只带半截 `arguments` 字符串，
 * `id` / `name` 有些中转会在每一帧重复发，重复拼会拼出 `game_contentgame_content`。
 * 所以 id 和 name 只在还是空的时候写入——这一条是跟着酒馆 `#applyToolCallDelta` 来的。
 */
function accumulateOpenAIToolCall(store, deltas) {
  for (const delta of Array.isArray(deltas) ? deltas : []) {
    if (!delta || typeof delta !== 'object') continue;
    const index = Number.isInteger(delta.index) ? delta.index : store.length;
    if (!store[index]) store[index] = { id: '', name: '', arguments: '' };
    const target = store[index];
    if (typeof delta.id === 'string' && delta.id && !target.id) target.id = delta.id;
    if (typeof delta.type === 'string' && delta.type && !target.type) target.type = delta.type;
    const fn = delta.function ?? {};
    if (typeof fn.name === 'string' && fn.name && !target.name) target.name = fn.name;
    if (typeof fn.arguments === 'string') target.arguments += fn.arguments;
  }
}

/** 参数是 JSON 字符串；空串是合法的「没有参数」，解不开就当成空对象并说明。 */
function parseToolArguments(raw, notes) {
  const text = typeof raw === 'string' ? raw.trim() : raw;
  if (text === '' || text === undefined || text === null) return {};
  if (typeof text === 'object') return text;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : { value: parsed };
  } catch {
    notes?.push(`工具参数不是合法 JSON，原样交给工具：${String(text).slice(0, 120)}`);
    return { __raw: String(text) };
  }
}

/** 把拼装好的原始记录整理成上层用的 `calls`，顺手把明显空壳的丢掉。 */
export function finaliseToolCalls(entries = [], notes) {
  const calls = [];
  for (const entry of entries) {
    if (!entry) continue;
    const name = String(entry.name ?? '').trim();
    if (!name) continue;
    calls.push({
      id: String(entry.id ?? '').trim() || `call_${calls.length}`,
      name,
      arguments: parseToolArguments(entry.arguments, notes),
    });
  }
  return calls;
}

function normaliseUsage(usage = {}) {
  return {
    promptTokens: usage.prompt_tokens ?? usage.input_tokens ?? 0,
    completionTokens: usage.completion_tokens ?? usage.output_tokens ?? 0,
    totalTokens: usage.total_tokens ?? 0,
    // 提示词缓存命中（蓝图 3.2「缓存节省」）。这里只做字段透传，不改别的逻辑；
    // 各家的字段名差异由 core/toolbox/cost.mjs 的 normaliseUsage 统一读取。
    cachedTokens:
      usage.cachedTokens ??
      usage.cacheReadTokens ??
      usage.prompt_tokens_details?.cached_tokens ??
      usage.cache_read_input_tokens ??
      usage.cachedContentTokenCount ??
      usage.input_tokens_details?.cached_tokens ??
      0,
  };
}

export function toGeminiContents(messages = []) {
  // 工具回合：模型侧是 `functionCall` 部件，工具结果回填成 `functionResponse` 部件，
  // 而且 Gemini 的 functionResponse 要带**工具名**，所以先把 id → name 记下来。
  const nameById = new Map();
  const contents = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.role === 'system') continue;
    if (Array.isArray(message?.tool_calls) && message.tool_calls.length) {
      const parts = [
        ...toGeminiParts(message.content, message.images ?? []),
        ...message.tool_calls.map((call) => {
          const name = call.function?.name;
          if (call.id) nameById.set(call.id, name);
          return { functionCall: { name, args: parseToolArguments(call.function?.arguments) } };
        }),
      ];
      contents.push({ role: 'model', parts });
      continue;
    }
    if (message?.role === 'tool') {
      contents.push({
        role: 'user',
        parts: [{
          functionResponse: {
            name: nameById.get(message.tool_call_id) ?? 'unknown',
            response: { result: String(message.content ?? '') },
          },
        }],
      });
      continue;
    }
    contents.push({
      role: message?.role === 'assistant' ? 'model' : 'user',
      parts: toGeminiParts(message?.content, message?.images ?? []),
    });
  }
  return contents;
}

/** 统一入口。 */
export async function* streamChat(options) {
  switch (options.adapter) {
    case 'anthropic':
      yield* streamAnthropic(options);
      break;
    case 'gemini':
      yield* streamGemini(options);
      break;
    case 'azure':
      yield* streamAzure(options);
      break;
    case 'text':
      yield* streamTextCompletion(options);
      break;
    case 'openai':
    default:
      yield* streamOpenAICompatible(options);
  }
}

// ---------------------------------------------------------------- OpenAI 方言

async function* streamOpenAICompatible({ baseUrl, apiKey, model, messages = [], system, params = {}, signal, extraHeaders = {}, authStyle, headers = {}, extraBody = {}, tools = null, toolChoice = null }) {
  const auth = resolveAuth(authStyle ?? 'bearer', apiKey);
  // 带图的消息按 OpenAI 的多模态格式展开（没有图就还是普通字符串）。
  const turns = applyImagesToMessages(messages, 'openai');
  const toolPayload = tools?.length ? { tools: openAIToolDefinitions(tools), tool_choice: toolChoice ?? 'auto' } : {};
  yield* openAIStyleStream({
    url: withQuery(joinUrl(baseUrl, '/chat/completions'), auth.query),
    authHeaders: { ...auth.headers, ...headers, ...extraHeaders },
    signal,
    payload: {
      model,
      messages: system ? [{ role: 'system', content: system }, ...turns] : turns,
      stream: params.streamMode !== 'full',
      ...pickParams(params, adapterParamMap('openai')),
      ...toolPayload,
      ...extraBody,
    },
  });
}

/** Azure：请求体与 OpenAI 一样，但部署名在路径上、密钥走 api-key 头。 */
async function* streamAzure({ baseUrl, apiKey, model, messages = [], system, params = {}, signal, extraHeaders = {}, authStyle, headers = {}, extraBody = {}, tools = null, toolChoice = null }) {
  const auth = resolveAuth(authStyle ?? 'api-key', apiKey);
  const turns = applyImagesToMessages(messages, 'openai');
  const toolPayload = tools?.length ? { tools: openAIToolDefinitions(tools), tool_choice: toolChoice ?? 'auto' } : {};
  yield* openAIStyleStream({
    url: withQuery(azureUrl(baseUrl, model, '/chat/completions', params.apiVersion), auth.query),
    authHeaders: { ...auth.headers, ...headers, ...extraHeaders },
    signal,
    payload: {
      messages: system ? [{ role: 'system', content: system }, ...turns] : turns,
      stream: params.streamMode !== 'full',
      ...pickParams(params, adapterParamMap('azure')),
      ...toolPayload,
      ...extraBody,
    },
  });
}

/**
 * 旧的 /v1/completions：没有角色，一整段提示词进去、`choices[].text` 出来。
 * 不提供 chat 接口的本地模型走这条。
 */
async function* streamTextCompletion({ baseUrl, apiKey, model, prompt, params = {}, maxTokens = 1024, signal, extraHeaders = {}, authStyle, headers = {} }) {
  const auth = resolveAuth(authStyle ?? 'bearer', apiKey);
  yield* openAIStyleStream({
    url: withQuery(joinUrl(baseUrl, '/completions'), auth.query),
    authHeaders: { ...auth.headers, ...headers, ...extraHeaders },
    signal,
    payload: {
      ...(model ? { model } : {}),
      prompt: String(prompt ?? ''),
      stream: params.streamMode !== 'full',
      max_tokens: params.max_tokens ?? maxTokens,
      ...pickParams(params, adapterParamMap('text')),
    },
    readText: (event) => {
      const choice = event?.choices?.[0];
      return choice?.delta?.content ?? choice?.delta?.text ?? choice?.text ?? '';
    },
  });
}

async function* openAIStyleStream({ url, payload, authHeaders = {}, signal, readText }) {
  const response = await httpFetch(url, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', ...authHeaders },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(await readError(response));

  // 非流式（整段返回）：一次 POST，读 choices[].message，事件照发，上层不用改。
  if (payload.stream === false) {
    const data = await response.json().catch(() => null);
    if (!data || typeof data !== 'object') throw new Error('提供方返回的不是 JSON（非流式）');
    const notes = [];
    const toolEntries = [];
    for (const choice of data.choices ?? []) {
      const message = choice?.message ?? {};
      const thinking = message.reasoning_content ?? message.reasoning;
      if (typeof thinking === 'string' && thinking) yield { type: 'thinking', text: thinking };
      const text = readText ? readText(choice) : message.content;
      if (typeof text === 'string' && text) yield { type: 'text', text };
      // 整段返回时工具调用是现成的数组，直接归一化。
      for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
        toolEntries.push({
          id: call?.id,
          name: call?.function?.name,
          arguments: call?.function?.arguments,
        });
      }
      if (choice?.finish_reason) yield { type: 'finish', reason: choice.finish_reason };
    }
    const calls = finaliseToolCalls(toolEntries, notes);
    if (calls.length) yield { type: 'tool_calls', calls, notes };
    if (data.usage) yield { type: 'usage', usage: normaliseUsage(data.usage) };
    yield { type: 'done' };
    return;
  }

  // 流式：工具调用是按 index 分片推过来的，边收边拼。
  const toolStore = [];
  const toolNotes = [];
  for await (const event of parseSSE(response.body)) {
    if (readText) {
      const text = readText(event);
      if (typeof text === 'string' && text) yield { type: 'text', text };
    } else {
      const delta = event?.choices?.[0]?.delta;
      if (delta) {
        const thinking = delta.reasoning_content ?? delta.reasoning;
        if (typeof thinking === 'string' && thinking) yield { type: 'thinking', text: thinking };
        if (typeof delta.content === 'string' && delta.content) yield { type: 'text', text: delta.content };
        if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) {
          const before = toolStore.length;
          accumulateOpenAIToolCall(toolStore, delta.tool_calls);
          // 新出现的工具调用立刻报一声，界面上能显示「正在调用 xxx」，不用等到整轮结束。
          for (let index = before; index < toolStore.length; index++) {
            if (toolStore[index]?.name) yield { type: 'tool_start', name: toolStore[index].name };
          }
        }
      }
      const logprobs = event?.choices?.[0]?.logprobs?.content;
      if (Array.isArray(logprobs) && logprobs.length) yield { type: 'logprobs', content: logprobs };
    }
    if (event.usage) yield { type: 'usage', usage: normaliseUsage(event.usage) };
    const finish = event.choices?.[0]?.finish_reason;
    if (finish) yield { type: 'finish', reason: finish };
  }
  const calls = finaliseToolCalls(toolStore, toolNotes);
  if (calls.length) yield { type: 'tool_calls', calls, notes: toolNotes };
  yield { type: 'done' };
}

// ---------------------------------------------------------------- Anthropic

/**
 * Anthropic 的工具回合要还原成 content 块：assistant 带 `tool_use`，
 * 紧接着的 user 带 `tool_result`。我们的内部记录是 OpenAI 形状，这里翻译过去。
 */
export function toAnthropicTurns(messages = []) {
  const turns = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (Array.isArray(message?.tool_calls) && message.tool_calls.length) {
      turns.push({
        role: 'assistant',
        content: [
          ...(message.content ? [{ type: 'text', text: String(message.content) }] : []),
          ...message.tool_calls.map((call) => ({
            type: 'tool_use',
            id: call.id,
            name: call.function?.name,
            input: parseToolArguments(call.function?.arguments),
          })),
        ],
      });
      continue;
    }
    if (message?.role === 'tool') {
      turns.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: message.tool_call_id, content: String(message.content ?? '') }],
      });
      continue;
    }
    turns.push({ role: message?.role === 'assistant' ? 'assistant' : 'user', content: message?.content });
  }
  return turns;
}

async function* streamAnthropic({ baseUrl, apiKey, model, messages = [], system, params = {}, maxTokens = 1024, signal, extraHeaders = {}, prefill = '', authStyle, headers = {}, extraBody = {}, tools = null, toolChoice = null }) {
  // Anthropic 的图片是 content 块数组里的 image/source。
  const turns = toAnthropicTurns(applyImagesToMessages(messages, 'anthropic'));
  if (prefill) turns.push({ role: 'assistant', content: prefill });

  const toolPayload = anthropicToolPayload(tools, toolChoice);
  const auth = resolveAuth(authStyle ?? 'x-api-key', apiKey);
  const response = await httpFetch(withQuery(joinUrl(baseUrl, '/messages'), auth.query), {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      'anthropic-version': ANTHROPIC_VERSION,
      ...auth.headers,
      ...headers,
      ...extraHeaders,
    },
    body: JSON.stringify({
      model,
      max_tokens: params.max_tokens ?? maxTokens,
      messages: turns,
      stream: params.streamMode !== 'full',
      ...(system ? { system } : {}),
      ...pickParams(params, adapterParamMap('anthropic')),
      ...(params.stop ? { stop_sequences: Array.isArray(params.stop) ? params.stop : [params.stop] } : {}),
      ...toolPayload,
      ...extraBody,
    }),
  });
  if (!response.ok) throw new Error(await readError(response));

  // 非流式：Anthropic 回的是一整份 message，content 是块数组（text / thinking）
  if (params.streamMode === 'full') {
    const data = await response.json().catch(() => null);
    if (!data || typeof data !== 'object') throw new Error('Anthropic 返回的不是 JSON（非流式）');
    const toolEntries = [];
    for (const block of data.content ?? []) {
      if (block?.type === 'text' && block.text) yield { type: 'text', text: block.text };
      else if (block?.type === 'thinking' && block.thinking) yield { type: 'thinking', text: block.thinking };
      else if (block?.type === 'tool_use') {
        toolEntries.push({ id: block.id, name: block.name, arguments: JSON.stringify(block.input ?? {}) });
      }
    }
    const calls = finaliseToolCalls(toolEntries);
    if (calls.length) yield { type: 'tool_calls', calls };
    if (data.usage) yield { type: 'usage', usage: normaliseUsage({ input_tokens: data.usage.input_tokens, output_tokens: data.usage.output_tokens }) };
    if (data.stop_reason) yield { type: 'finish', reason: data.stop_reason };
    yield { type: 'done' };
    return;
  }

  // 流式：tool_use 由 content_block_start 起头、input_json_delta 分片、content_block_stop 收尾。
  const toolByIndex = new Map();
  for await (const event of parseSSE(response.body)) {
    if (event.type === 'content_block_start') {
      const block = event.content_block ?? {};
      if (block.type === 'tool_use') {
        toolByIndex.set(event.index, { id: block.id, name: block.name, arguments: '' });
        yield { type: 'tool_start', name: block.name };
      }
    } else if (event.type === 'content_block_delta') {
      const delta = event.delta ?? {};
      if (delta.type === 'text_delta' && delta.text) yield { type: 'text', text: delta.text };
      else if (delta.type === 'thinking_delta' && delta.thinking) yield { type: 'thinking', text: delta.thinking };
      else if (delta.type === 'input_json_delta') {
        const target = toolByIndex.get(event.index);
        if (target) target.arguments += delta.partial_json ?? '';
      }
    } else if (event.type === 'message_delta') {
      if (event.usage) yield { type: 'usage', usage: normaliseUsage(event.usage) };
      if (event.delta?.stop_reason) yield { type: 'finish', reason: event.delta.stop_reason };
    } else if (event.type === 'error') {
      throw new Error(event.error?.message ?? 'Anthropic 流返回错误');
    }
  }
  {
    const calls = finaliseToolCalls(
      [...toolByIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, value]) => value),
    );
    if (calls.length) yield { type: 'tool_calls', calls };
  }
  yield { type: 'done' };
}

// ---------------------------------------------------------------- Gemini

async function* streamGemini({ baseUrl, apiKey, model, messages = [], system, params = {}, maxTokens = 1024, signal, extraHeaders = {}, authStyle, headers = {}, extraBody = {}, tools = null, toolChoice = null }) {
  const auth = resolveAuth(authStyle ?? 'x-goog-api-key', apiKey);
  const full = params.streamMode === 'full';
  const toolPayload = geminiToolPayload(tools, toolChoice);
  const url = withQuery(
    joinUrl(baseUrl, `/models/${encodeURIComponent(model)}:${full ? 'generateContent' : 'streamGenerateContent'}${full ? '' : '?alt=sse'}`),
    auth.query,
  );
  const response = await httpFetch(url, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', ...auth.headers, ...headers, ...extraHeaders },
    body: JSON.stringify({
      contents: toGeminiContents(messages),
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      ...toolPayload,
      // generationConfig 要和"自定义参数"（extraBody.generationConfig）**合并**，
      // 不能让它整个覆盖掉 —— 例如 path 写成 generationConfig.thinkingConfig.thinkingLevel 时
      // 只该多一个 thinkingConfig，不能把 temperature / maxOutputTokens 一起顶掉。
      generationConfig: {
        maxOutputTokens: params.max_tokens ?? maxTokens,
        ...pickParams(params, adapterParamMap('gemini')),
        ...(params.stop ? { stopSequences: Array.isArray(params.stop) ? params.stop : [params.stop] } : {}),
        ...(extraBody?.generationConfig ?? {}),
      },
      ...(params.safetySettings ? { safetySettings: params.safetySettings } : {}),
      // 顶层还是照旧展开 extraBody，但 generationConfig 已经在上面合过了，别再覆盖一次
      ...Object.fromEntries(Object.entries(extraBody ?? {}).filter(([key]) => key !== 'generationConfig')),
    }),
  });
  if (!response.ok) throw new Error(await readError(response));

  // 非流式：一次拿到完整 candidates
  if (full) {
    const data = await response.json().catch(() => null);
    if (!data || typeof data !== 'object') throw new Error('Gemini 返回的不是 JSON（非流式）');
    const candidate = data.candidates?.[0];
    const toolEntries = [];
    for (const part of candidate?.content?.parts ?? []) {
      if (part?.functionCall) {
        toolEntries.push({ name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args ?? {}) });
        continue;
      }
      if (typeof part.text !== 'string' || !part.text) continue;
      if (part.thought === true) yield { type: 'thinking', text: part.text };
      else yield { type: 'text', text: part.text };
    }
    const calls = finaliseToolCalls(toolEntries);
    if (calls.length) yield { type: 'tool_calls', calls };
    if (data.usageMetadata) {
      yield {
        type: 'usage',
        usage: {
          promptTokens: data.usageMetadata.promptTokenCount ?? 0,
          completionTokens: data.usageMetadata.candidatesTokenCount ?? 0,
          totalTokens: data.usageMetadata.totalTokenCount ?? 0,
          cachedTokens: data.usageMetadata.cachedContentTokenCount ?? 0,
        },
      };
    }
    if (candidate?.finishReason) yield { type: 'finish', reason: candidate.finishReason };
    yield { type: 'done' };
    return;
  }

  // 流式：Gemini 一般一帧给一个完整的 functionCall，但按帧累加更稳（有的中转会切开）。
  const streamToolEntries = [];
  for await (const event of parseSSE(response.body)) {
    const candidate = event?.candidates?.[0];
    for (const part of candidate?.content?.parts ?? []) {
      if (part?.functionCall) {
        streamToolEntries.push({ name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args ?? {}) });
        if (part.functionCall.name) yield { type: 'tool_start', name: part.functionCall.name };
        continue;
      }
      if (typeof part.text !== 'string' || !part.text) continue;
      if (part.thought === true) yield { type: 'thinking', text: part.text };
      else yield { type: 'text', text: part.text };
    }
    if (event.usageMetadata) {
      yield {
        type: 'usage',
        usage: {
          promptTokens: event.usageMetadata.promptTokenCount ?? 0,
          completionTokens: event.usageMetadata.candidatesTokenCount ?? 0,
          totalTokens: event.usageMetadata.totalTokenCount ?? 0,
          cachedTokens: event.usageMetadata.cachedContentTokenCount ?? 0,
        },
      };
    }
    if (candidate?.finishReason) yield { type: 'finish', reason: candidate.finishReason };
  }
  {
    const calls = finaliseToolCalls(streamToolEntries);
    if (calls.length) yield { type: 'tool_calls', calls };
  }
  yield { type: 'done' };
}

// ---------------------------------------------------------------- 非流式辅助

/** 把流收成一次性结果。写卡 Agent 的技能都直接用它。 */
export async function collectStream(stream) {
  let text = '';
  let thinking = '';
  let usage = null;
  let finish = null;
  let logprobs = [];
  let toolCalls = [];
  for await (const event of stream) {
    if (event.type === 'text') text += event.text;
    else if (event.type === 'thinking') thinking += event.text;
    else if (event.type === 'usage') usage = event.usage;
    else if (event.type === 'finish') finish = event.reason;
    else if (event.type === 'logprobs') logprobs = event.content;
    else if (event.type === 'tool_calls') toolCalls = event.calls ?? [];
  }
  return { text, thinking, usage, finish, logprobs, toolCalls };
}

// ---------------------------------------------------------------- 模型列表

export async function listModels({ adapter, baseUrl, apiKey, params = {}, extraHeaders = {}, authStyle, headers = {} }) {
  if (adapter === 'azure') {
    const auth = resolveAuth(authStyle ?? 'api-key', apiKey);
    const base = String(baseUrl || '').replace(/\/+$/, '').replace(/\/openai$/i, '');
    const version = params.apiVersion || DEFAULT_AZURE_API_VERSION;
    const response = await httpFetch(withQuery(`${base}/openai/models?api-version=${encodeURIComponent(version)}`, auth.query), {
      headers: { ...auth.headers, ...headers, ...extraHeaders },
    });
    if (!response.ok) throw new Error(await readError(response));
    const json = await response.json();
    return (json.data ?? []).map((item) => item.id ?? item.model).filter(Boolean);
  }

  if (adapter === 'gemini') {
    const auth = resolveAuth(authStyle ?? 'x-goog-api-key', apiKey);
    const response = await httpFetch(withQuery(joinUrl(baseUrl, '/models'), auth.query), {
      headers: { ...auth.headers, ...headers, ...extraHeaders },
    });
    if (!response.ok) throw new Error(await readError(response));
    const json = await response.json();
    return (json.models ?? [])
      .filter((item) => (item.supportedGenerationMethods ?? []).includes('generateContent'))
      .map((item) => String(item.name).replace(/^models\//, ''));
  }

  if (adapter === 'anthropic') {
    const auth = resolveAuth(authStyle ?? 'x-api-key', apiKey);
    const response = await httpFetch(withQuery(joinUrl(baseUrl, '/models'), auth.query), {
      headers: { 'anthropic-version': ANTHROPIC_VERSION, ...auth.headers, ...headers, ...extraHeaders },
    });
    if (!response.ok) throw new Error(await readError(response));
    const json = await response.json();
    return (json.data ?? []).map((item) => item.id);
  }

  const auth = resolveAuth(authStyle ?? 'bearer', apiKey);
  const response = await httpFetch(withQuery(joinUrl(baseUrl, '/models'), auth.query), {
    headers: { ...auth.headers, ...headers, ...extraHeaders },
  });
  if (!response.ok) throw new Error(await readError(response));
  const json = await response.json();
  return (json.data ?? []).map((item) => item.id).sort();
}

// ---------------------------------------------------------------- 嵌入

export async function embedTexts({ adapter, baseUrl, apiKey, model, inputs, params = {}, extraHeaders = {}, authStyle, headers = {} }) {
  const list = Array.isArray(inputs) ? inputs : [inputs];
  if (!list.length) return [];

  if (adapter === 'gemini') {
    const auth = resolveAuth(authStyle ?? 'x-goog-api-key', apiKey);
    const response = await httpFetch(withQuery(joinUrl(baseUrl, `/models/${encodeURIComponent(model)}:batchEmbedContents`), auth.query), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth.headers, ...headers, ...extraHeaders },
      body: JSON.stringify({
        requests: list.map((text) => ({ model: `models/${model}`, content: { parts: [{ text }] } })),
      }),
    });
    if (!response.ok) throw new Error(await readError(response));
    const json = await response.json();
    return (json.embeddings ?? []).map((item) => item.values ?? []);
  }

  if (adapter === 'azure') {
    const auth = resolveAuth(authStyle ?? 'api-key', apiKey);
    const response = await httpFetch(withQuery(azureUrl(baseUrl, model, '/embeddings', params.apiVersion), auth.query), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth.headers, ...headers, ...extraHeaders },
      body: JSON.stringify({ input: list }),
    });
    if (!response.ok) throw new Error(await readError(response));
    const json = await response.json();
    return (json.data ?? []).map((item) => item.embedding ?? []);
  }

  if (adapter === 'anthropic') {
    throw new Error('Anthropic 没有嵌入接口，请另配一个嵌入提供方');
  }

  const auth = resolveAuth(authStyle ?? 'bearer', apiKey);
  const response = await httpFetch(withQuery(joinUrl(baseUrl, '/embeddings'), auth.query), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...auth.headers,
      ...headers,
      ...extraHeaders,
    },
    body: JSON.stringify({ model, input: list }),
  });
  if (!response.ok) throw new Error(await readError(response));
  const json = await response.json();
  return (json.data ?? []).map((item) => item.embedding ?? []);
}
