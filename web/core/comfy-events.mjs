/**
 * ComfyUI 的共享纯逻辑：地址规范化、错误翻译、队列 / 事件 / history 解释。
 *
 * 为什么放在 web/ 而不是 core/：**服务端与浏览器直连两条路要共用同一份解释**。
 * 浏览器拿不到 core/ 的文件（core 不对外提供），但 web/ 会被静态服务与 exe 资源
 * 一起带走，所以把这份零依赖纯函数放在这里，`core/toolbox/comfy.mjs` 反向 import
 * 它并原样再导出。这样"服务端 runner 看到的进度"和"浏览器直连看到的进度"是
 * 同一套代码，不会漂移；也不违反"web/ 不 import core/"那条约定（依赖方向是
 * core → web 的这个纯文件，web/ 其余部分不反向依赖 core）。
 *
 * 本文件**不许** import 任何东西、不许碰 DOM / fetch / WebSocket / 数据库，
 * 这样服务端、浏览器、单测三边都能直接跑。
 *
 * 事件与端点字段名以 ComfyUI master 源码为准（见 core/toolbox/comfy.mjs 文件头）：
 *   POST /prompt   {prompt, client_id, prompt_id?} → 200 {prompt_id, number, node_errors}；400 {error, node_errors}
 *   GET  /queue    → {queue_running:[...], queue_pending:[...]}，每条是数组，[0]=序号、[1]=prompt_id
 *   GET  /history/{prompt_id} → {[prompt_id]: {prompt, outputs, status}}
 *   GET  /view?filename=&subfolder=&type=output → 图片字节
 *   GET  /ws?clientId=… → WebSocket（事件名见 mapComfyEvent）
 *   GET  /system_stats → 探活用
 */

/** 出图的两种执行方式（蓝图 3.1 + "别人的连接不经过主机"）。 */
export const COMFY_EXECUTION_MODES = [
  {
    id: 'server',
    title: '服务器执行',
    summary: '主机进程去连这个地址（默认，行为与以前一致）。',
    help: '这个地址由服务器访问：多用户模式下等于"主机要能连到你填的地址"。填内网地址会让主机的网络被探测，所以多用户模式默认不用它。',
  },
  {
    id: 'client',
    title: '浏览器直连',
    summary: '由你自己这台机器的浏览器直接连 ComfyUI，主机不发起任何请求。',
    help: '提示词替换仍在服务端做，浏览器只负责提交、看进度、取图、上传到自己的素材库。需要 ComfyUI 以 --enable-cors-header 启动（跨域限制）。多用户模式默认用它。',
  },
];

export function getComfyExecutionMode(id) {
  return COMFY_EXECUTION_MODES.find((item) => item.id === id) ?? COMFY_EXECUTION_MODES[0];
}

/** 补全 / 规范地址：空值退回本地默认，去掉结尾斜杠。 */
export function normaliseBaseUrl(value) {
  const text = String(value ?? '').trim();
  return (text || 'http://127.0.0.1:8188').replace(/\/+$/, '');
}

/** 由 http(s) 地址推导出 WebSocket 地址：http→ws、https→wss。 */
export function comfyWsUrl(baseUrl, clientId = '') {
  const root = normaliseBaseUrl(baseUrl);
  const ws = root.replace(/^http/i, 'ws');
  return `${ws}/ws?clientId=${encodeURIComponent(clientId ?? '')}`;
}

/** 把 fetch / 网络异常翻译成能给用户看的中文原因。 */
export function describeFetchError(err, baseUrl, timeoutMs = 10000) {
  const cause = err?.cause ?? {};
  const code = cause.code ?? err?.code;
  const timeout = err?.name === 'TimeoutError' || code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ETIMEDOUT' || code === 'UND_ERR_HEADERS_TIMEOUT';
  if (timeout) {
    return `连接 ${baseUrl} 超时（${timeoutMs}ms 没回应）。ComfyUI 可能正在忙、或者地址填错了。`;
  }
  if (code === 'ECONNREFUSED') {
    return `连不上 ${baseUrl}：端口没人监听。先确认 ComfyUI 已经启动，再看地址和端口填得对不对。`;
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return `解析不了 ${baseUrl} 的主机名。远程地址要能在这台机器上解析到。`;
  }
  if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET') {
    return `和 ${baseUrl} 的连接被重置了。检查反向代理 / 防火墙，或者换直连地址试试。`;
  }
  if (err?.name === 'AbortError') return `请求 ${baseUrl} 被取消了`;
  // 浏览器里跨域被拦下时，fetch 只会抛一个 TypeError: Failed to fetch，没有 code
  if (err?.name === 'TypeError' && /failed to fetch|networkerror|load failed/i.test(String(err?.message ?? ''))) {
    return `浏览器连不上 ${baseUrl}：可能是没开跨域。用 --enable-cors-header 启动 ComfyUI（例如 --enable-cors-header "*"），或确认地址与端口填对了。`;
  }
  return `连不上 ${baseUrl}：${err?.message ?? err}`;
}

/** 400 的返回里带 node_errors，把节点级的问题也一并说出来。 */
export function comfyErrorMessage(status, text, pathname) {
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  const error = parsed?.error;
  const detail = typeof error === 'string' ? error : error?.message ?? error?.details ?? null;
  const nodeErrors = parsed?.node_errors ?? {};
  const nodes = Object.entries(nodeErrors)
    .map(([nodeId, info]) => {
      const message = info?.errors?.map((item) => item.message ?? item.details).filter(Boolean).join('；') ?? '';
      return message ? `节点 ${nodeId}：${message}` : null;
    })
    .filter(Boolean);
  const head = `ComfyUI 拒绝了这次请求（HTTP ${status}${pathname ? ` ${pathname}` : ''}）`;
  if (detail || nodes.length) return [head, detail, ...nodes].filter(Boolean).join('：');
  return `${head}，没有更多说明`;
}

export function guessMime(filename = '') {
  const ext = String(filename).toLowerCase().split('.').pop();
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  return 'image/png';
}

/** GET /queue 的返回 → 队列摘要。 */
export function summariseQueue(queue = {}) {
  const running = Array.isArray(queue.queue_running) ? queue.queue_running : [];
  const pending = Array.isArray(queue.queue_pending) ? queue.queue_pending : [];
  const pick = (item, state, index) => ({
    promptId: Array.isArray(item) ? item[1] ?? null : item?.prompt_id ?? null,
    number: Array.isArray(item) ? item[0] ?? null : item?.number ?? null,
    position: index,
    state,
  });
  return {
    running: running.length,
    pending: pending.length,
    total: running.length + pending.length,
    items: [...running.map((item, i) => pick(item, 'running', i)), ...pending.map((item, i) => pick(item, 'pending', i))],
  };
}

function nodeProgress(nodes) {
  const list = Object.values(nodes ?? {});
  if (!list.length) return null;
  // 有 max 的取最靠后的一个；都没有就退化成第一个节点
  const scored = list
    .filter((node) => node && Number.isFinite(Number(node.max)))
    .sort((a, b) => Number(b.value ?? 0) - Number(a.value ?? 0));
  const chosen = scored[0] ?? list[0];
  return {
    nodeId: chosen.node_id ?? chosen.nodeId ?? null,
    value: Number(chosen.value ?? 0),
    max: Number(chosen.max ?? 0),
    state: chosen.state ?? null,
  };
}

/**
 * WebSocket 消息 → 统一事件。字段名以 ComfyUI 源码为准（见文件头）。
 * @returns {{type:string, promptId:string|null, nodeId:string|null, value:number|null, max:number|null, state:string|null, error:string|null, output:object|null, queueRemaining:number|null}}
 */
export function mapComfyEvent(message = {}) {
  const type = String(message.type ?? 'unknown');
  const data = message.data && typeof message.data === 'object' ? message.data : {};
  const base = {
    type,
    promptId: data.prompt_id ?? null,
    nodeId: null,
    value: null,
    max: null,
    state: null,
    error: null,
    output: null,
    queueRemaining: null,
  };
  switch (type) {
    case 'status':
      return { ...base, queueRemaining: data.status?.exec_info?.queue_remaining ?? null };
    case 'execution_start':
      return { ...base, state: 'running' };
    case 'execution_cached':
      return { ...base, state: 'cached' };
    case 'executing': {
      const nodeId = data.node ?? null;
      return { ...base, nodeId, state: nodeId === null ? 'finishing' : 'running' };
    }
    case 'executed':
      return { ...base, nodeId: data.node ?? null, state: 'executed', output: data.output ?? null };
    case 'progress':
      return { ...base, nodeId: data.node ?? null, value: Number(data.value ?? 0), max: Number(data.max ?? 0), state: 'progress' };
    case 'progress_state': {
      const node = nodeProgress(data.nodes);
      return { ...base, nodeId: node?.nodeId ?? null, value: node?.value ?? null, max: node?.max ?? null, state: node?.state ?? 'progress' };
    }
    case 'execution_success':
      return { ...base, state: 'success' };
    case 'execution_error':
      return {
        ...base,
        nodeId: data.node_id ?? data.node ?? null,
        state: 'error',
        error: [data.exception_type, data.exception_message].filter(Boolean).join(': ') || 'ComfyUI 执行失败',
      };
    default:
      return base;
  }
}

/** 从 /history 的一条记录里挑出所有图片。 */
export function collectHistoryImages(history = {}) {
  const images = [];
  for (const [nodeId, output] of Object.entries(history.outputs ?? {})) {
    for (const image of output?.images ?? []) {
      images.push({ nodeId, filename: image.filename, subfolder: image.subfolder ?? '', type: image.type ?? 'output' });
    }
  }
  return images;
}

export function historyStatus(history = {}) {
  const status = history.status ?? {};
  const str = status.status_str ?? null;
  if (str === 'success') return { status: 'done', error: null };
  if (str === 'error') {
    const messages = status.messages ?? [];
    const first = messages.find((item) => Array.isArray(item) && item[0] === 'execution_error');
    const detail = first?.[1]?.exception_message ?? 'ComfyUI 执行失败';
    return { status: 'error', error: detail };
  }
  return { status: 'running', error: null };
}

export function progressPercent(run = {}) {
  const max = Number(run.progressMax ?? 0);
  if (!Number.isFinite(max) || max <= 0) return null;
  const value = Number(run.progress ?? 0);
  return Math.max(0, Math.min(100, Math.round((value / max) * 100)));
}

/** 终态判断（服务端 runner 与浏览器直连都要用，免得各写一份）。 */
export const COMFY_TERMINAL_STATUSES = ['done', 'error', 'cancelled'];

export function isComfyTerminal(status) {
  return COMFY_TERMINAL_STATUSES.includes(status);
}

// ------------------------------------------------------------------ 参考图标记

/**
 * 参考图标记：图片参数的值先存成 `asset:<assetId>`，发请求前由执行方
 * （服务端 runner / 浏览器直连）把素材上传到 ComfyUI 的 input 目录，再换成文件名。
 * 这样"图生图 / 局部重绘 / 扩图"在两种执行方式下走同一套，引用解析也只有一份代码。
 */
export const ASSET_REF_PREFIX = 'asset:';

export function makeAssetRef(assetId) {
  return `${ASSET_REF_PREFIX}${String(assetId ?? '').trim()}`;
}

export function isAssetRef(value) {
  return typeof value === 'string' && value.startsWith(ASSET_REF_PREFIX) && value.length > ASSET_REF_PREFIX.length;
}

export function readAssetRef(value) {
  return isAssetRef(value) ? value.slice(ASSET_REF_PREFIX.length) : null;
}

/** 遍历 prompt（JSON 结构）收集所有 `asset:` 引用 → [{ path: ['8','inputs','image'], assetId }] */
export function collectAssetRefs(prompt) {
  const out = [];
  const walk = (node, path) => {
    if (typeof node === 'string') {
      if (isAssetRef(node)) out.push({ path, assetId: readAssetRef(node) });
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, [...path, index]));
      return;
    }
    if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) walk(value, [...path, key]);
    }
  };
  walk(prompt, []);
  return out;
}

/** 把 `asset:` 引用替换成上传后的文件名。mapping 是 `{ assetId: filename }`。 */
export function applyAssetRefs(prompt, mapping = {}) {
  for (const ref of collectAssetRefs(prompt)) {
    const name = mapping[ref.assetId];
    if (!name) continue;
    let cursor = prompt;
    for (const key of ref.path.slice(0, -1)) cursor = cursor?.[key];
    const last = ref.path[ref.path.length - 1];
    if (cursor && last !== undefined) cursor[last] = name;
  }
  return prompt;
}
