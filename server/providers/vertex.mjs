/**
 * Google Vertex AI 适配器。
 *
 * 和 AI Studio（generativelanguage.googleapis.com）不是一回事：
 *   - 地址形状：/v1/projects/{project}/locations/{location}/publishers/google/models/{model}:xxx
 *   - 鉴权：服务账号（OAuth2 Bearer）或 express 模式的 API key
 *   - 好消息：Gemini 的请求体与 SSE 格式和 AI Studio 完全一致，Claude 的也和 Anthropic 一致，
 *     所以这里只处理"地址 + 鉴权 + 挑哪条路径"，编解码全部复用现有实现。
 *
 * 两种模式：
 *   params.vertexMode = 'express'        —— 用 API key，走全局端点
 *   params.vertexMode = 'serviceAccount' —— 用服务账号 JSON（放 params.serviceAccount）
 * 模型名以 claude 开头时走 :streamRawPredict（Anthropic 请求体），否则走 Gemini 那套。
 */

import { createSign } from 'node:crypto';

import {
  anthropicToolPayload,
  finaliseToolCalls,
  geminiToolPayload,
  parseSSE,
  readError,
  toAnthropicTurns,
  toGeminiContents,
} from './adapters.mjs';
import { applyImagesToMessages } from '../../core/media/vision.mjs';
import { resolveAuth, withQuery } from './auth.mjs';

const DEFAULT_LOCATION = 'us-central1';
const ANTHROPIC_VERTEX_VERSION = 'vertex-2023-10-16';

/** token 缓存：同一把服务账号不用每次换 token。 */
const tokenCache = new Map();

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

function parseServiceAccount(raw) {
  if (!raw) throw new Error('Vertex 服务账号模式需要填服务账号 JSON');
  const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!value.client_email || !value.private_key) {
    throw new Error('服务账号 JSON 里缺少 client_email 或 private_key');
  }
  return value;
}

function vertexBase({ baseUrl, location, mode }) {
  if (baseUrl) return String(baseUrl).replace(/\/+$/, '');
  if (mode === 'express') return 'https://aiplatform.googleapis.com';
  const loc = location || DEFAULT_LOCATION;
  return loc === 'global' ? 'https://aiplatform.googleapis.com' : `https://${loc}-aiplatform.googleapis.com`;
}

export function vertexModelPath({ mode, project, location, model }) {
  if (mode === 'express') {
    return `/v1/publishers/google/models/${encodeURIComponent(model)}`;
  }
  const loc = location || DEFAULT_LOCATION;
  if (!project) throw new Error('Vertex 服务账号模式需要填 project');
  return `/v1/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(loc)}/publishers/google/models/${encodeURIComponent(model)}`;
}

export function vertexUrl({ baseUrl, mode, project, location, model, method, authQuery = '' }) {
  const path = `${vertexModelPath({ mode, project, location, model })}:${method}`;
  const url = `${vertexBase({ baseUrl, location, mode })}${path}?alt=sse`;
  return withQuery(url, authQuery);
}

async function getAccessToken(serviceAccount) {
  const cacheKey = serviceAccount.client_email;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 60000) return cached.token;

  const now = Math.floor(Date.now() / 1000);
  const tokenUri = serviceAccount.token_uri || 'https://oauth2.googleapis.com/token';
  const signingInput = [
    base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' })),
    base64url(
      JSON.stringify({
        iss: serviceAccount.client_email,
        scope: 'https://www.googleapis.com/auth/cloud-platform',
        aud: tokenUri,
        iat: now,
        exp: now + 3600,
      }),
    ),
  ].join('.');

  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  const assertion = `${signingInput}.${signer.sign(serviceAccount.private_key).toString('base64url')}`;

  const response = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  if (!response.ok) throw new Error(`换取 Vertex 访问令牌失败：${await readError(response)}`);
  const json = await response.json();
  const token = json.access_token;
  if (!token) throw new Error('Vertex 令牌响应里没有 access_token');
  tokenCache.set(cacheKey, { token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 });
  return token;
}

async function vertexAuth({ apiKey, authStyle, params, headers }) {
  const mode = params.vertexMode ?? 'express';
  if (mode === 'serviceAccount') {
    const token = await getAccessToken(parseServiceAccount(params.serviceAccount));
    return { headers: { Authorization: `Bearer ${token}`, ...headers } };
  }
  const auth = resolveAuth(authStyle ?? 'query', apiKey);
  return { headers: { ...auth.headers, ...headers }, query: auth.query };
}

function isClaude(model) {
  return String(model ?? '').toLowerCase().startsWith('claude');
}

/** 流式聊天。Gemini 系与 Claude 系在这里分流，之后共用各自的解析器。 */
export async function* streamVertex({ baseUrl, apiKey, model, messages = [], system, params = {}, signal, authStyle, headers = {}, extraHeaders = {}, extraBody = {}, maxTokens = 1024, prefill = '', tools = null, toolChoice = null }) {
  const mode = params.vertexMode ?? 'express';
  const auth = await vertexAuth({ apiKey, authStyle, params, headers: { ...headers, ...extraHeaders } });

  if (isClaude(model)) {
    const full = params.streamMode === 'full';
    // 复用 Anthropic 那套 turns 构造：图片（content 块）与工具回合（tool_use / tool_result）都在里面
    const turns = toAnthropicTurns(applyImagesToMessages(messages, 'anthropic'));
    if (prefill) turns.push({ role: 'assistant', content: prefill });

    const url = vertexUrl({
      baseUrl,
      mode,
      project: params.project,
      location: params.location,
      model,
      method: full ? 'rawPredict' : 'streamRawPredict',
      authQuery: auth.query ?? '',
    });
    const response = await fetch(url, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json', ...auth.headers },
      body: JSON.stringify({
        anthropic_version: ANTHROPIC_VERTEX_VERSION,
        max_tokens: params.max_tokens ?? maxTokens,
        messages: turns,
        stream: !full,
        ...(system ? { system } : {}),
        ...pickNumeric(params, { temperature: 'temperature', top_p: 'top_p', top_k: 'top_k' }),
        ...(params.stop ? { stop_sequences: Array.isArray(params.stop) ? params.stop : [params.stop] } : {}),
        ...anthropicToolPayload(tools, toolChoice),
        ...extraBody,
      }),
    });
    if (!response.ok) throw new Error(await readError(response));

    // 非流式（rawPredict）：整份 message 一次回来
    if (full) {
      const data = await response.json().catch(() => null);
      if (!data || typeof data !== 'object') throw new Error('Vertex（Claude）返回的不是 JSON（非流式）');
      const toolEntries = [];
      for (const block of data.content ?? []) {
        if (block?.type === 'text' && block.text) yield { type: 'text', text: block.text };
        else if (block?.type === 'thinking' && block.thinking) yield { type: 'thinking', text: block.thinking };
        else if (block?.type === 'tool_use') toolEntries.push({ id: block.id, name: block.name, arguments: JSON.stringify(block.input ?? {}) });
      }
      const calls = finaliseToolCalls(toolEntries);
      if (calls.length) yield { type: 'tool_calls', calls };
      if (data.usage) yield { type: 'usage', usage: anthropicUsage(data.usage) };
      if (data.stop_reason) yield { type: 'finish', reason: data.stop_reason };
      yield { type: 'done' };
      return;
    }

    // 流式：tool_use 由 content_block_start 起头、input_json_delta 分片、content_block_stop 收尾
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
        if (event.usage) yield { type: 'usage', usage: anthropicUsage(event.usage) };
        if (event.delta?.stop_reason) yield { type: 'finish', reason: event.delta.stop_reason };
      } else if (event.type === 'error') {
        throw new Error(event.error?.message ?? 'Vertex（Claude）流返回错误');
      }
    }
    {
      const calls = finaliseToolCalls(
        [...toolByIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, value]) => value),
      );
      if (calls.length) yield { type: 'tool_calls', calls };
    }
    yield { type: 'done' };
    return;
  }

  // Gemini 系：请求体与 AI Studio 一致
  const full = params.streamMode === 'full';
  // 复用 Gemini 那套 contents 构造：图片（inlineData）与工具回合（functionCall / functionResponse）都在里面
  const contents = toGeminiContents(messages);
  if (prefill) contents.push({ role: 'model', parts: [{ text: prefill }] });

  const url = vertexUrl({
    baseUrl,
    mode,
    project: params.project,
    location: params.location,
    model,
    method: full ? 'generateContent' : 'streamGenerateContent',
    authQuery: auth.query ?? '',
  });
  const response = await fetch(url, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', ...auth.headers },
    body: JSON.stringify({
      contents,
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      ...geminiToolPayload(tools, toolChoice),
      // generationConfig 要和「自定义参数」里的 generationConfig 合并，别整个顶掉
      generationConfig: {
        maxOutputTokens: params.max_tokens ?? maxTokens,
        ...pickNumeric(params, { temperature: 'temperature', top_p: 'topP', top_k: 'topK' }),
        ...(params.stop ? { stopSequences: Array.isArray(params.stop) ? params.stop : [params.stop] } : {}),
        ...(extraBody?.generationConfig ?? {}),
      },
      ...(params.safetySettings ? { safetySettings: params.safetySettings } : {}),
      ...Object.fromEntries(Object.entries(extraBody ?? {}).filter(([key]) => key !== 'generationConfig')),
    }),
  });
  if (!response.ok) throw new Error(await readError(response));

  // 非流式：一次拿到完整 candidates
  if (full) {
    const data = await response.json().catch(() => null);
    if (!data || typeof data !== 'object') throw new Error('Vertex 返回的不是 JSON（非流式）');
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
    if (data.usageMetadata) yield { type: 'usage', usage: geminiUsage(data.usageMetadata) };
    if (candidate?.finishReason) yield { type: 'finish', reason: candidate.finishReason };
    yield { type: 'done' };
    return;
  }

  // 流式：Gemini 通常一帧给一个完整 functionCall，但仍按帧累加（有的中转会切开）
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
    if (event.usageMetadata) yield { type: 'usage', usage: geminiUsage(event.usageMetadata) };
    if (candidate?.finishReason) yield { type: 'finish', reason: candidate.finishReason };
  }
  {
    const calls = finaliseToolCalls(streamToolEntries);
    if (calls.length) yield { type: 'tool_calls', calls };
  }
  yield { type: 'done' };
}

/** Anthropic 的 usage → 我们统一的形状（含缓存命中，Vertex 的 Claude 也会给）。 */
function anthropicUsage(usage = {}) {
  return {
    promptTokens: usage.input_tokens ?? 0,
    completionTokens: usage.output_tokens ?? 0,
    totalTokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
    cachedTokens: usage.cache_read_input_tokens ?? 0,
  };
}

/** Gemini 的 usageMetadata → 我们统一的形状（含缓存命中）。 */
function geminiUsage(meta = {}) {
  return {
    promptTokens: meta.promptTokenCount ?? 0,
    completionTokens: meta.candidatesTokenCount ?? 0,
    totalTokens: meta.totalTokenCount ?? 0,
    cachedTokens: meta.cachedContentTokenCount ?? 0,
  };
}

function pickNumeric(source, mapping) {
  const out = {};
  for (const [from, to] of Object.entries(mapping)) {
    const value = source[from];
    if (value === undefined || value === null || value === '') continue;
    out[to] = value;
  }
  return out;
}

/** Vertex 没有"列模型"的公共接口，让上层退化成真发一次请求来测。 */
export async function listVertexModels() {
  throw new Error('Vertex 不支持列举模型，请手动填写模型名（测试按钮会改用真实请求验证）');
}

export async function embedVertexTexts({ baseUrl, apiKey, model, inputs, params = {}, authStyle, headers = {} }) {
  const list = Array.isArray(inputs) ? inputs : [inputs];
  if (!list.length) return [];
  const mode = params.vertexMode ?? 'express';
  const auth = await vertexAuth({ apiKey, authStyle, params, headers });

  if (mode === 'serviceAccount') {
    const url = vertexUrl({ baseUrl, mode, project: params.project, location: params.location, model, method: 'predict', authQuery: auth.query ?? '' });
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth.headers },
      body: JSON.stringify({
        instances: list.map((text) => ({ content: text, task_type: params.taskType ?? 'RETRIEVAL_DOCUMENT' })),
      }),
    });
    if (!response.ok) throw new Error(await readError(response));
    const json = await response.json();
    return (json.predictions ?? []).map((item) => item.embeddings?.values ?? []);
  }

  // express 模式走 AI Studio 的批嵌入接口
  const url = withQuery(
    `${vertexBase({ baseUrl, mode }).replace('/v1', '/v1beta')}/models/${encodeURIComponent(model)}:batchEmbedContents`,
    auth.query ?? '',
  );
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth.headers },
    body: JSON.stringify({ requests: list.map((text) => ({ model: `models/${model}`, content: { parts: [{ text }] } })) }),
  });
  if (!response.ok) throw new Error(await readError(response));
  const json = await response.json();
  return (json.embeddings ?? []).map((item) => item.values ?? []);
}
