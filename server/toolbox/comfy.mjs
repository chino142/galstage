/**
 * ComfyUI HTTP / WebSocket 客户端。
 *
 * 只用 node 内置：全局 fetch + 全局 WebSocket（Node 24 自带，实测 typeof
 * WebSocket === 'function'）。零第三方依赖这条硬约束不破。
 *
 * 端点与事件名对着 ComfyUI master 分支源码核过（见 core/toolbox/comfy.mjs 文件头）：
 *   POST /prompt              {prompt, client_id, prompt_id?} → {prompt_id, number, node_errors}
 *   GET  /queue               → {queue_running, queue_pending}
 *   GET  /history/{prompt_id} → {[prompt_id]: {prompt, outputs, status}}
 *   GET  /view?filename=…     → 图片字节
 *   GET  /system_stats        → 用来做连通性测试（不启动采样就能探活）
 *   GET  /object_info         → 节点定义（给"可填参数"做参考）
 *   GET  /ws?clientId=…       → WebSocket，事件见 mapComfyEvent
 *
 * 超时：每个请求都走 AbortSignal.timeout，连不上立刻给出人话原因，
 * 不会让界面一直转圈。
 */

import { ProviderError } from '../../core/errors.mjs';
import { extractLoraNames, summariseQueue } from '../../core/toolbox/comfy.mjs';
import { comfyErrorMessage, describeFetchError, guessMime, normaliseBaseUrl } from '../../web/core/comfy-events.mjs';

// 地址规范化与错误翻译也在 web/core/comfy-events.mjs（浏览器直连要共用同一套人话），
// 这里再导出，保持 server 侧原有的 import 路径。
export { comfyErrorMessage, describeFetchError, guessMime, normaliseBaseUrl };

export function createComfyClient({ baseUrl = 'http://127.0.0.1:8188', timeoutMs = 10000, logger = console } = {}) {
  const root = normaliseBaseUrl(baseUrl);

  function url(pathname) {
    return `${root}${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
  }

  async function request(pathname, { method = 'GET', body = undefined, timeout = timeoutMs } = {}) {
    let response;
    try {
      response = await fetch(url(pathname), {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(Math.max(200, timeout)),
      });
    } catch (err) {
      throw new ProviderError(describeFetchError(err, root, timeout), { baseUrl: root, path: pathname });
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new ProviderError(comfyErrorMessage(response.status, text, pathname), { baseUrl: root, path: pathname, status: response.status });
    }
    return response;
  }

  async function json(pathname, options) {
    const response = await request(pathname, options);
    return response.json().catch(() => null);
  }

  const api = {
    get baseUrl() {
      return root;
    },

    /** 连通性测试：只打 /system_stats，不启动任何采样。 */
    async test() {
      try {
        const stats = await json('/system_stats', { timeout: Math.min(timeoutMs, 6000) });
        return {
          ok: true,
          stats: {
            system: stats?.system?.os ?? null,
            comfyuiVersion: stats?.system?.comfyui_version ?? null,
            pythonVersion: stats?.system?.python_version ?? null,
            devices: (stats?.devices ?? []).map((device) => ({
              name: device.name ?? null,
              type: device.type ?? null,
              vramTotal: device.vram_total ?? null,
              vramFree: device.vram_free ?? null,
            })),
          },
        };
      } catch (err) {
        return { ok: false, error: err?.message ?? String(err) };
      }
    },

    async queue() {
      const data = await json('/queue', { timeout: Math.min(timeoutMs, 6000) });
      return summariseQueue(data ?? {});
    },

    async objectInfo() {
      return json('/object_info');
    },

    /** 这台 ComfyUI 上有哪些 LoRA（从 LoraLoader 的候选值里取，扫的是它的 models/loras）。 */
    async loras() {
      const names = new Set();
      let lastError = null;
      let reachable = false;
      for (const nodeClass of ['LoraLoader', 'LoraLoaderModelOnly']) {
        try {
          const info = await json(`/object_info/${nodeClass}`, { timeout: Math.max(timeoutMs, 15000) });
          reachable = true;
          for (const name of extractLoraNames(info)) names.add(name);
        } catch (err) {
          // 这个节点类不存在（比如只装了 ModelOnly）就跳过；两边都失败说明是连不上
          lastError = err;
        }
      }
      if (!reachable && lastError) throw lastError;
      return [...names].sort();
    },

    /** 提交一个 prompt。带固定 client_id，WebSocket 才会把这条的进度推给我们。 */
    async submit(prompt, { clientId } = {}) {
      const data = await json('/prompt', {
        method: 'POST',
        body: { prompt, client_id: clientId ?? null },
        timeout: Math.max(timeoutMs, 15000),
      });
      if (!data?.prompt_id) throw new ProviderError('ComfyUI 没有返回 prompt_id，这次提交没被接受');
      return { promptId: data.prompt_id, number: data.number ?? null, nodeErrors: data.node_errors ?? {} };
    },

    /** GET /history/{prompt_id}：没跑完就是空对象，跑完才有 outputs 与 status。 */
    async history(promptId) {
      if (!promptId) return null;
      const data = await json(`/history/${encodeURIComponent(promptId)}`, { timeout: Math.min(timeoutMs, 8000) });
      return data?.[promptId] ?? null;
    },

    imageUrl({ filename, subfolder = '', type = 'output' }) {
      const params = new URLSearchParams({ filename: String(filename), subfolder: String(subfolder ?? ''), type: String(type ?? 'output') });
      return url(`/view?${params.toString()}`);
    },

    async fetchImage(image) {
      const response = await request(
        `/view?${new URLSearchParams({ filename: String(image.filename), subfolder: String(image.subfolder ?? ''), type: String(image.type ?? 'output') }).toString()}`,
        { timeout: Math.max(timeoutMs, 20000) },
      );
      const buffer = Buffer.from(await response.arrayBuffer());
      return { buffer, mime: response.headers.get('content-type') ?? guessMime(image.filename) };
    },

    async interrupt(promptId = null) {
      await request('/interrupt', { method: 'POST', body: promptId ? { prompt_id: promptId } : {}, timeout: Math.min(timeoutMs, 6000) });
      return { ok: true };
    },

    /**
     * 把一张参考图传到 ComfyUI 的 input 目录（图生图 / 局部重绘 / 扩图要用）。
     * 对着 ComfyUI master 的 server.py 核过：`POST /upload/image` 收 multipart 的 `image` 字段，
     * 返回 `{name, subfolder, type}`；LoadImage.image 用 `subfolder/name` 或 `name`。
     */
    async uploadImage({ buffer, name = 'silver-tavern-ref.png', mime = 'image/png', subfolder = '', overwrite = true } = {}) {
      if (!buffer?.length) throw new ProviderError('参考图内容为空，传不了');
      const form = new FormData();
      form.append('image', new Blob([buffer], { type: mime }), name);
      if (subfolder) form.append('subfolder', subfolder);
      form.append('overwrite', overwrite ? 'true' : 'false');
      let response;
      try {
        response = await fetch(url('/upload/image'), { method: 'POST', body: form, signal: AbortSignal.timeout(Math.max(timeoutMs, 20000)) });
      } catch (err) {
        throw new ProviderError(describeFetchError(err, root, timeoutMs), { baseUrl: root, path: '/upload/image' });
      }
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new ProviderError(comfyErrorMessage(response.status, text, '/upload/image'), { baseUrl: root, path: '/upload/image', status: response.status });
      }
      const data = await response.json().catch(() => null);
      const filename = data?.name ?? name;
      const dir = data?.subfolder ?? subfolder ?? '';
      return { name: filename, subfolder: dir, ref: dir ? `${dir}/${filename}` : filename, type: data?.type ?? 'input' };
    },

    async free(payload = { unload_models: false, free_memory: false }) {
      await request('/free', { method: 'POST', body: payload });
      return { ok: true };
    },

    wsUrl(clientId) {
      const ws = root.replace(/^http/i, 'ws');
      return `${ws}/ws?clientId=${encodeURIComponent(clientId ?? '')}`;
    },
  };

  return api;
}

