/** 后端调用封装：出错统一抛 ApiError，501 单独标记出来方便界面显示"未实现"。 */

export class ApiError extends Error {
  constructor(message, { status = 0, code = 'UNKNOWN', details = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  get notImplemented() {
    return this.status === 501 || this.code === 'NOT_IMPLEMENTED';
  }

  get offline() {
    return this.status === 0;
  }
}

export async function api(path, { method = 'GET', body, headers = {}, signal } = {}) {
  let response;
  try {
    response = await fetch(path, {
      method,
      headers: body === undefined ? headers : { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (err) {
    throw new ApiError('连不上服务，确认一下服务是否还在运行', { status: 0, code: 'OFFLINE' });
  }

  if (response.status === 204) return null;

  const type = response.headers.get('content-type') ?? '';
  // 只有真正的 JSON 才当 JSON 解析。`application/x-ndjson`（酒馆 JSONL 导出）
  // 里含 "json" 三个字母但不是单个 JSON 文档，按 JSON 解会失败并静默变 null。
  const isJson = /application\/json|application\/[a-z0-9.+-]*\+json/i.test(type);
  const payload = isJson ? await response.json().catch(() => null) : await response.text();

  if (!response.ok) {
    const error = payload?.error ?? {};
    // 多用户模式下会话过期：广播一下，让 app.js 回到登录页
    if (response.status === 401 && typeof window !== 'undefined') {
      window.dispatchEvent?.(new CustomEvent('tavern:unauthorized'));
    }
    throw new ApiError(error.message ?? `请求失败（${response.status}）`, {
      status: response.status,
      code: error.code ?? 'HTTP_ERROR',
      details: error.details ?? null,
    });
  }
  return payload;
}

export const get = (path, options) => api(path, options);
export const post = (path, body, options) => api(path, { ...options, method: 'POST', body });
export const put = (path, body, options) => api(path, { ...options, method: 'PUT', body });
export const del = (path, options) => api(path, { ...options, method: 'DELETE' });

/**
 * POST + 读取 SSE 流。
 * EventSource 只能发 GET，所以 Agent 这类"带参数的流式接口"得手写解析。
 * onEvent(eventName, dataObject) 每收到一条就调一次。
 */
export async function streamPost(path, body, onEvent, { signal } = {}) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
    signal,
  });
  if (!response.ok || !response.body) {
    let message = `请求失败（${response.status}）`;
    try {
      const payload = await response.json();
      message = payload?.error?.message ?? message;
    } catch {
      // 保留默认文案
    }
    if (response.status === 401 && typeof window !== 'undefined') {
      window.dispatchEvent?.(new CustomEvent('tavern:unauthorized'));
    }
    throw new ApiError(message, { status: response.status });
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      let event = 'message';
      const dataLines = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
      if (!dataLines.length) continue;
      let data = null;
      try {
        data = JSON.parse(dataLines.join('\n'));
      } catch {
        data = { text: dataLines.join('\n') };
      }
      onEvent?.(event, data);
    }
  }
}
