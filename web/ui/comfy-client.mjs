/**
 * ComfyUI 浏览器直连（client 模式）。
 *
 * 为什么有它：多用户模式下，朋友的 ComfyUI 主机多半连不上，而且"主机去请求用户
 * 填的地址"本身就是内网探测（SSRF）。所以 client 模式改成**浏览器**直接和用户
 * 自己机器上的 ComfyUI 说话，主机只做"参数替换 / 落库 / 记账"这些不碰地址的事。
 *
 * 分工：
 *   - 参数替换：仍在服务端（复用 POST /api/comfy/workflows/:id/preview 的最终 prompt；
 *     自动触发的待办任务服务端已经算好 prompt，存在 run.values.prompt 里）。
 *   - 提交 / 进度 / 取图：这里做（原生 fetch + WebSocket）。
 *   - 入库 / 绑消息 / 落记录：走服务端接口（/api/assets、消息 attachments、client-runs）。
 *
 * 事件解释用的是 web/core/comfy-events.mjs —— 与服务端 runner 同一份代码，不重写。
 */

import { get, post, put } from '../core/api.mjs';
import {
  applyAssetRefs,
  collectAssetRefs,
  collectHistoryImages,
  comfyErrorMessage,
  comfyWsUrl,
  describeFetchError,
  guessMime,
  historyStatus,
  mapComfyEvent,
  normaliseBaseUrl,
  summariseQueue,
} from '../core/comfy-events.mjs';

const POLL_MS = 1500;
const HISTORY_TIMEOUT_MS = 12 * 60 * 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomClientId() {
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  if (typeof btoa === 'function') return btoa(binary);
  return Buffer.from(bytes).toString('base64'); // 单测/冒烟里没有 btoa 时兜底
}

/** 直接对用户自己的 ComfyUI 发请求：网络异常与 HTTP 错误都翻成人话。 */
async function comfyFetch(baseUrl, pathname, { method = 'GET', body, timeoutMs = 10000 } = {}) {
  const root = normaliseBaseUrl(baseUrl);
  let response;
  try {
    response = await fetch(`${root}${pathname}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(Math.max(500, timeoutMs)) : undefined,
    });
  } catch (err) {
    throw new Error(describeFetchError(err, root, timeoutMs));
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(comfyErrorMessage(response.status, text, pathname));
  }
  return response;
}

/** 在浏览器里探活（GET /system_stats）。 */
export async function testComfyBrowser(baseUrl, { timeoutMs = 8000 } = {}) {
  const root = normaliseBaseUrl(baseUrl);
  try {
    const response = await comfyFetch(root, '/system_stats', { timeoutMs });
    const stats = await response.json().catch(() => null);
    return {
      ok: true,
      baseUrl: root,
      stats: {
        system: stats?.system?.os ?? null,
        comfyuiVersion: stats?.system?.comfyui_version ?? null,
        devices: (stats?.devices ?? []).map((device) => ({ name: device.name ?? null, type: device.type ?? null })),
      },
    };
  } catch (err) {
    return { ok: false, baseUrl: root, error: err?.message ?? String(err) };
  }
}

/** 在浏览器里看队列（GET /queue）。 */
export async function clientQueue(baseUrl, { timeoutMs = 8000 } = {}) {
  try {
    const response = await comfyFetch(baseUrl, '/queue', { timeoutMs });
    const data = await response.json().catch(() => null);
    return summariseQueue(data ?? {});
  } catch (err) {
    return { ...summariseQueue({}), error: err?.message ?? String(err) };
  }
}

/**
 * 跑一次浏览器直连出图。返回最终的 run 记录。
 * @param {object} options
 * @param {string} options.baseUrl          你自己的 ComfyUI 地址
 * @param {string} options.workflowId
 * @param {string|null} options.runId       领走一条 pending-client 时传
 * @param {string|null} options.chatId
 * @param {string|null} options.messageId
 * @param {object} options.values           手动发起时的参数（走 /preview）
 * @param {string|null} options.prompt      已经由服务端算好的最终 prompt（待办任务用）
 */
export async function runClientImage(options = {}) {
  const {
    baseUrl,
    workflowId,
    runId = null,
    chatId = null,
    messageId = null,
    values = {},
    seed = null,
    reason = 'client',
    prompt: providedPrompt = null,
    onProgress = null,
  } = options;
  const root = normaliseBaseUrl(baseUrl);
  if (!workflowId && !providedPrompt) throw new Error('要指定 workflowId');

  // 1) 最终 prompt：手动发起时现算（复用服务端 /preview）；待办任务用服务端存好的。
  let prompt = providedPrompt;
  if (!prompt) {
    const preview = await post(`/api/comfy/workflows/${workflowId}/preview`, { values, chatId, seed });
    prompt = preview?.prompt ?? null;
  }
  if (!prompt) throw new Error('服务端没能算出最终 prompt');

  // 参考图（图生图 / 重绘 / 扩图）：把本租户素材上传到这台 ComfyUI 的 input 目录
  prompt = await resolvePromptAssets(root, prompt);

  // 2) 提交给用户自己的 ComfyUI
  const clientId = randomClientId();
  const submitted = await comfyFetch(root, '/prompt', {
    method: 'POST',
    body: { prompt, client_id: clientId },
    timeoutMs: 15000,
  }).then((response) => response.json());
  if (!submitted?.prompt_id) throw new Error('ComfyUI 没有返回 prompt_id，这次提交没被接受');
  const promptId = submitted.prompt_id;

  // 3) 登记 / 领走待办（落到本租户的 comfy_runs）
  let run = await post('/api/comfy/client-runs', { runId, workflowId, chatId, messageId, promptId, values: providedPrompt ? undefined : values, reason });
  const report = (patch) => put(`/api/comfy/client-runs/${run.id}`, patch).then((updated) => { run = updated; return updated; }).catch(() => run);

  // 4) 进度：WebSocket 拿细进度（连不上不影响出图），history 轮询收尾
  let wsError = null;
  let socket = null;
  try {
    socket = new WebSocket(comfyWsUrl(root, clientId));
    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return;
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      const mapped = mapComfyEvent(message);
      if (mapped.promptId && mapped.promptId !== promptId) return;
      if (mapped.state === 'error') wsError = mapped.error ?? 'ComfyUI 执行失败';
      if (mapped.state && !['success', 'error'].includes(mapped.state)) {
        const patch = { status: 'running' };
        if (mapped.nodeId) patch.nodeId = mapped.nodeId;
        if (mapped.value !== null && mapped.value !== undefined) patch.progress = mapped.value;
        if (mapped.max !== null && mapped.max !== undefined) patch.progressMax = mapped.max;
        void report(patch);
        onProgress?.(mapped);
      }
    });
    socket.addEventListener('error', () => {
      // close 之后会重试不了（这是一次性任务），忽略即可 —— 轮询是兜底
    });
  } catch {
    socket = null;
  }

  const startedAt = Date.now();
  try {
    while (Date.now() - startedAt < HISTORY_TIMEOUT_MS) {
      if (wsError) {
        return report({ status: 'error', error: wsError });
      }
      let history = null;
      try {
        const response = await comfyFetch(root, `/history/${encodeURIComponent(promptId)}`, { timeoutMs: 8000 });
        const data = await response.json().catch(() => null);
        history = data?.[promptId] ?? null;
      } catch {
        // 单次读失败不算数，下一轮再看
      }
      if (history) {
        const verdict = historyStatus(history);
        if (verdict.status === 'error') return report({ status: 'error', error: verdict.error ?? 'ComfyUI 执行失败' });
        if (verdict.status === 'done') {
          const images = await uploadImages(root, run, history, promptId);
          if (images.length && chatId && messageId) {
            try {
              await post(`/api/chats/${chatId}/messages/${messageId}/attachments`, { assetIds: images.map((image) => image.assetId) });
            } catch {
              // 图片已经进了素材库，绑消息失败不算这次出图失败
            }
          }
          const done = await report({ status: 'done', images, error: null });
          if (typeof window !== 'undefined' && typeof CustomEvent === 'function') {
            window.dispatchEvent?.(new CustomEvent('tavern:comfy-updated', { detail: { runId: done?.id ?? run.id, chatId, messageId } }));
          }
          return done;
        }
      }
      await sleep(POLL_MS);
    }
    return report({ status: 'error', error: '等 ComfyUI 的 history 超时了：图可能还在排队，或者 ComfyUI 那边没跑完。' });
  } finally {
    try {
      socket?.close();
    } catch {
      // ignore
    }
  }
}

/** 把 prompt 里的 `asset:<id>` 引用逐张从素材库取出来、上传到 ComfyUI，换成文件名。 */
async function resolvePromptAssets(root, prompt) {
  const refs = collectAssetRefs(prompt);
  if (!refs.length) return prompt;
  const mapping = {};
  for (const ref of refs) {
    if (mapping[ref.assetId]) continue;
    const meta = await get(`/api/assets/${encodeURIComponent(ref.assetId)}`).catch(() => null);
    const response = await fetch(`/api/assets/${encodeURIComponent(ref.assetId)}/file`);
    if (!response.ok) throw new Error(`参考图素材读不出来：${ref.assetId}`);
    const buffer = await response.arrayBuffer();
    const mime = meta?.mime ?? response.headers.get('content-type') ?? 'image/png';
    const name = meta?.name ?? `${ref.assetId}.png`;
    mapping[ref.assetId] = await uploadImageToComfy(root, { buffer, name, mime });
  }
  return applyAssetRefs(prompt, mapping);
}

async function uploadImageToComfy(root, { buffer, name = 'silver-tavern-ref.png', mime = 'image/png' }) {
  const form = new FormData();
  form.append('image', new Blob([buffer], { type: mime }), name);
  form.append('overwrite', 'true');
  let response;
  try {
    response = await fetch(`${root}/upload/image`, { method: 'POST', body: form, signal: AbortSignal.timeout(30000) });
  } catch (err) {
    throw new Error(describeFetchError(err, root, 30000));
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(comfyErrorMessage(response.status, text, '/upload/image'));
  }
  const data = await response.json().catch(() => null);
  const filename = data?.name ?? name;
  const subfolder = data?.subfolder ?? '';
  return subfolder ? `${subfolder}/${filename}` : filename;
}

/** 把 history 里的图逐张取回、上传到**当前租户**的素材库。 */
async function uploadImages(root, run, history, promptId) {
  const out = [];
  for (const image of collectHistoryImages(history)) {
    try {
      const params = new URLSearchParams({
        filename: String(image.filename),
        subfolder: String(image.subfolder ?? ''),
        type: String(image.type ?? 'output'),
      });
      const response = await comfyFetch(root, `/view?${params.toString()}`, { timeoutMs: 30000 });
      const buffer = await response.arrayBuffer();
      const mime = response.headers.get('content-type') ?? guessMime(image.filename);
      const asset = await post('/api/assets', {
        data: arrayBufferToBase64(buffer),
        kind: 'image',
        name: image.filename,
        mime,
        meta: {
          source: 'comfyui-client',
          workflowId: run.workflowId ?? null,
          runId: run.id,
          promptId,
          nodeId: image.nodeId,
          subfolder: image.subfolder,
        },
      });
      out.push({
        assetId: asset.id,
        filename: image.filename,
        subfolder: image.subfolder,
        type: image.type,
        nodeId: image.nodeId,
        mime: asset.mime,
        size: asset.size,
      });
    } catch {
      // 单张图取不到就跳过，别让整次出图失败
    }
  }
  return out;
}

/** 拉本租户里"该由浏览器出"的待办任务。 */
export async function listPendingClientRuns() {
  const data = await get('/api/comfy/runs?status=pending-client&limit=20');
  return data?.items ?? [];
}

/** 把所有待办任务依次跑掉。返回每条的结果，方便界面汇报。 */
export async function runPendingClientRuns({ baseUrl, onResult = null } = {}) {
  const pending = await listPendingClientRuns();
  const results = [];
  for (const run of pending) {
    const params = run.values ?? {};
    try {
      const done = await runClientImage({
        baseUrl,
        workflowId: run.workflowId,
        runId: run.id,
        chatId: run.chatId,
        messageId: run.messageId,
        prompt: params.prompt ?? null,
        values: params.applied ?? {},
        seed: params.seed ?? null,
        reason: run.reason ?? 'client',
      });
      results.push({ ok: true, run: done });
    } catch (err) {
      const message = err?.message ?? String(err);
      await put(`/api/comfy/client-runs/${run.id}`, { status: 'error', error: message }).catch(() => {});
      results.push({ ok: false, run, error: message });
    }
    onResult?.(results[results.length - 1]);
  }
  return results;
}

/**
 * 后台泵：前端打开着的时候，每隔一会儿领一次待办任务。
 * 没有前端在线时任务就一直挂着，下次打开再跑 —— 这正是 client 模式的语义。
 */
export function startComfyClientPump({ intervalMs = 12000 } = {}) {
  let timer = null;
  let busy = false;
  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const config = await get('/api/comfy/config');
      const settings = config?.settings ?? {};
      if (settings['comfy.executionMode'] !== 'client') return;
      if (settings['comfy.enabled'] === false) return;
      await runPendingClientRuns({ baseUrl: settings['comfy.baseUrl'] });
    } catch {
      // 服务或 ComfyUI 暂时不可用：下一次再看
    } finally {
      busy = false;
    }
  }
  void tick();
  timer = setInterval(() => { void tick(); }, Math.max(4000, Number(intervalMs) || 12000));
  timer.unref?.();
  return () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
}
