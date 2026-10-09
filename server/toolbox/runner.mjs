/**
 * ComfyUI 执行器：提交任务、盯进度、把出的图落进素材库并绑回消息。
 *
 * 为什么不是"提交完就不管"：
 *   - ComfyUI 的 /prompt 立刻返回，真正的生成要几十秒到几分钟；
 *   - 进度（跑到第几步）只在 WebSocket 上有（executing / progress / progress_state）；
 *   - 完成的结果在 GET /history/{prompt_id} 里，所以还要有个轮询兜底。
 *
 * 于是这里做两件事：
 *   1) 常连一条 WebSocket，把进度写进 comfy_runs（细粒度、实时）；
 *   2) 有一个轮询循环负责"收尾"——history 出来了就去下载图片、入库、绑消息。
 * 两者都能独立工作：WebSocket 连不上也不影响出图，只是进度不那么细。
 *
 * 有意偏离：ComfyUI 自带前端会在 WebSocket 断开时重连并重新订阅；我们只有
 * 一个固定 clientId，且轮询兜底，所以重连只是"重新连上继续收事件"，
 * 不做历史事件回放（轮询已经把状态补齐了）。
 */

import { randomBytes } from 'node:crypto';

import {
  applyAssetRefs,
  collectAssetRefs,
  collectHistoryImages,
  historyStatus,
  mapComfyEvent,
} from '../../core/toolbox/comfy.mjs';
import { ProviderError } from '../../core/errors.mjs';
import { createComfyClient, normaliseBaseUrl } from './comfy.mjs';

const POLL_INTERVAL_MS = 1200;
const WS_RETRY_MS = 4000;
const MISSING_TICKS_BEFORE_FAIL = 5;

export function createComfyRunner({
  store,
  assets,
  getConfig,
  attachImages = null,
  logger = console,
  createClient = createComfyClient,
  launcher = null,
} = {}) {
  const clientId = randomBytes(16).toString('hex');
  let client = null;
  let clientRoot = null;
  let ws = null;
  let wsTimer = null;
  let pollTimer = null;
  let stopped = false;
  let lastQueue = { running: 0, pending: 0, total: 0, items: [] };
  let lastQueueError = null;
  let connected = false;
  const missingTicks = new Map();

  function config() {
    const raw = getConfig?.() ?? {};
    return {
      baseUrl: normaliseBaseUrl(raw.baseUrl),
      enabled: raw.enabled !== false,
      timeoutMs: Number(raw.timeoutMs ?? 10000) || 10000,
      executionMode: raw.executionMode ?? 'server',
    };
  }

  /**
   * 浏览器直连模式下，主机**不向**用户填的地址发任何请求（HTTP 或 WebSocket）。
   * 这是 SSRF 收敛点：地址由用户可控，client 模式下主机的网络不该被它探测。
   */
  function isClientMode() {
    return config().executionMode === 'client';
  }

  function ensureClient() {
    const conf = config();
    if (!client || clientRoot !== conf.baseUrl) {
      client = createClient({ baseUrl: conf.baseUrl, timeoutMs: conf.timeoutMs, logger });
      clientRoot = conf.baseUrl;
      // 地址换了：旧的 WebSocket 已经没意义
      closeWs();
    }
    return client;
  }

  // ------------------------------------------------------------------ WebSocket

  function closeWs() {
    if (wsTimer) {
      clearTimeout(wsTimer);
      wsTimer = null;
    }
    if (ws) {
      const socket = ws;
      ws = null;
      try {
        socket.close();
      } catch {
        // ignore
      }
    }
  }

  function scheduleReconnect() {
    if (stopped || wsTimer) return;
    wsTimer = setTimeout(() => {
      wsTimer = null;
      connectWs();
    }, WS_RETRY_MS);
    wsTimer.unref?.();
  }

  function connectWs() {
    if (stopped || ws) return;
    const conf = config();
    if (!conf.enabled || conf.executionMode === 'client') return;
    let socket;
    try {
      ensureClient();
      socket = new WebSocket(client.wsUrl(clientId));
    } catch (err) {
      logger?.debug?.(`[comfy] WebSocket 建不起来：${err?.message ?? err}`);
      scheduleReconnect();
      return;
    }
    ws = socket;
    socket.addEventListener('open', () => {
      connected = true;
      logger?.debug?.('[comfy] WebSocket 已连接');
    });
    socket.addEventListener('message', (event) => {
      if (typeof event.data === 'string') handleWsMessage(event.data);
    });
    socket.addEventListener('close', () => {
      if (ws === socket) ws = null;
      connected = false;
      scheduleReconnect();
    });
    socket.addEventListener('error', () => {
      // close 事件随后一定会来，重连逻辑放那里
    });
  }

  function handleWsMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return; // 有些节点会往 WS 推二进制/日志，忽略非 JSON
    }
    const event = mapComfyEvent(message);
    if (event.queueRemaining !== null) {
      lastQueue = { ...lastQueue, total: Number(event.queueRemaining) };
    }
    if (!event.promptId) return;
    const run = store.findRunByPromptId(event.promptId);
    if (!run || isTerminal(run.status)) return;
    const patch = {};
    if (event.nodeId) patch.nodeId = event.nodeId;
    if (event.value !== null && event.value !== undefined) patch.progress = event.value;
    if (event.max !== null && event.max !== undefined) patch.progressMax = event.max;
    if (event.state === 'progress' || event.state === 'running' || event.state === 'cached') patch.status = 'running';
    if (event.state === 'error') {
      patch.status = 'error';
      patch.error = event.error ?? 'ComfyUI 执行失败';
    }
    if (Object.keys(patch).length) {
      try {
        store.updateRun(run.id, patch);
      } catch (err) {
        logger?.debug?.(`[comfy] 写进度失败：${err?.message ?? err}`);
      }
    }
    if (event.state === 'executed' || event.state === 'success' || event.state === 'error' || event.state === 'finishing') {
      void refreshRun(store.getRun(run.id)).catch(() => {});
    }
  }

  // ------------------------------------------------------------------ 轮询收尾

  function isTerminal(status) {
    return status === 'done' || status === 'error' || status === 'cancelled';
  }

  function ensurePoller() {
    if (pollTimer || stopped) return;
    pollTimer = setInterval(() => {
      void tick().catch(() => {});
    }, POLL_INTERVAL_MS);
    pollTimer.unref?.();
  }

  function stopPollerIfIdle() {
    if (!pollTimer) return;
    if (store.activeRuns().length === 0 && !config().enabled) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  async function tick() {
    if (isClientMode()) {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      return;
    }
    const active = store.activeRuns();
    if (!active.length) {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      return;
    }
    const comfy = ensureClient();
    try {
      const queue = await comfy.queue();
      lastQueue = queue;
      lastQueueError = null;
    } catch (err) {
      lastQueueError = err?.message ?? String(err);
      // 连不上 ComfyUI：这一轮什么都不改，等下一轮
      return;
    }
    const inQueue = new Map(lastQueue.items.map((item) => [item.promptId, item.state]));
    for (const run of active) {
      if (isTerminal(run.status)) continue;
      const state = run.promptId ? inQueue.get(run.promptId) : null;
      if (state && run.status !== 'running') {
        store.updateRun(run.id, { status: 'running' });
        run.status = 'running';
      }
      await refreshRun(run, state !== undefined);
    }
    stopPollerIfIdle();
  }

  /** 拉一次 history；有就收尾（下载图片 / 记错误），没有就维持现状。 */
  async function refreshRun(run, seenInQueue = false) {
    if (!run || isTerminal(run.status)) return run;
    const comfy = ensureClient();
    let history = null;
    try {
      history = await comfy.history(run.promptId);
    } catch (err) {
      logger?.debug?.(`[comfy] 读 history 失败：${err?.message ?? err}`);
      return run;
    }
    if (!history) {
      if (!seenInQueue) {
        const ticks = (missingTicks.get(run.id) ?? 0) + 1;
        missingTicks.set(run.id, ticks);
        if (ticks >= MISSING_TICKS_BEFORE_FAIL) {
          missingTicks.delete(run.id);
          return store.updateRun(run.id, {
            status: 'error',
            error: 'ComfyUI 的队列和历史里都找不到这次任务了：可能在 ComfyUI 那边被清掉了。',
          });
        }
      } else {
        missingTicks.delete(run.id);
      }
      return run;
    }
    missingTicks.delete(run.id);
    const verdict = historyStatus(history);
    if (verdict.status === 'running') return run;
    if (verdict.status === 'error') {
      return store.updateRun(run.id, { status: 'error', error: verdict.error ?? 'ComfyUI 执行失败' });
    }
    const images = await persistImages(run, history);
    // 跑完了就直接满格：进度条停在 30% 会让人以为还没结束
    const updated = store.updateRun(run.id, {
      status: 'done',
      images,
      error: null,
      progress: run.progressMax ?? run.progress ?? null,
      progressMax: run.progressMax ?? null,
    });
    if (images.length) {
      try {
        attachImages?.({ chatId: run.chatId, messageId: run.messageId, run: updated, images });
      } catch (err) {
        logger?.debug?.(`[comfy] 把图绑回消息失败：${err?.message ?? err}`);
      }
      logger?.info?.(`[comfy] 出图完成：${images.length} 张（${run.workflowName ?? run.workflowId ?? '工作流'}）`);
    }
    return updated;
  }

  async function persistImages(run, history) {
    if (!assets) return [];
    const comfy = ensureClient();
    const out = [];
    for (const image of collectHistoryImages(history)) {
      try {
        const { buffer, mime } = await comfy.fetchImage(image);
        const asset = assets.save({
          buffer,
          kind: 'image',
          name: image.filename,
          mime,
          meta: { source: 'comfyui', workflowId: run.workflowId, runId: run.id, promptId: run.promptId, nodeId: image.nodeId, subfolder: image.subfolder },
        });
        out.push({ assetId: asset.id, filename: image.filename, subfolder: image.subfolder, type: image.type, nodeId: image.nodeId, mime: asset.mime, size: asset.size });
      } catch (err) {
        logger?.warn?.(`[comfy] 图片 ${image.filename} 落库失败：${err?.message ?? err}`);
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ 对外接口

  async function submit(input) {
    const conf = config();
    if (!conf.enabled) throw new ProviderError('ComfyUI 还没启用：去「工具箱 → ComfyUI」打开开关，填好地址');
    if (conf.executionMode === 'client') {
      throw new ProviderError('当前是「浏览器直连」模式：出图由浏览器执行，主机不提交任务。把连接方式改成「服务器执行」才会走这里。');
    }
    // 出图前自动拉起 ComfyUI（没配启动命令、或者开关关着、或者端口上已经有人，都只是空跑一次）
    if (launcher) {
      let launched = null;
      try {
        launched = await launcher.ensure();
      } catch (err) {
        throw new ProviderError(`ComfyUI 没在跑，自动启动也失败了：${err?.message ?? err}`);
      }
      if (launched?.ok && launched.started) logger?.info?.('ComfyUI 已由酒馆在后台拉起');
      else if (launched?.ok === false && launched.reason === 'not-ready') {
        throw new ProviderError(`ComfyUI 拉起来了但没就绪（端口 ${launched.port}）。最近输出：${(launched.logs ?? []).join(' / ') || '（没有输出）'}`);
      }
    }
    const comfy = ensureClient();
    // 参考图（图生图 / 重绘 / 扩图）：先把素材传到 ComfyUI 的 input 目录，再把 asset: 换成文件名。
    const prompt = await resolveAssetRefs(input.prompt, comfy);
    const result = await comfy.submit(prompt, { clientId });
    const run = store.insertRun({
      workflowId: input.workflowId ?? null,
      workflowName: input.workflowName ?? null,
      kind: input.kind ?? null,
      chatId: input.chatId ?? null,
      messageId: input.messageId ?? null,
      promptId: result.promptId,
      status: 'queued',
      values: input.values ?? {},
      reason: input.reason ?? null,
    });
    launcher?.touch?.();
    ensurePoller();
    connectWs();
    void tick().catch(() => {});
    return run;
  }

  /** 把 prompt 里的 `asset:<id>` 引用逐张上传到 ComfyUI，返回替换后的 prompt。 */
  async function resolveAssetRefs(prompt, comfy) {
    const refs = collectAssetRefs(prompt);
    if (!refs.length) return prompt;
    if (!assets) throw new ProviderError('这次出图要用参考图，但没挂素材库端口');
    const mapping = {};
    for (const ref of refs) {
      if (mapping[ref.assetId]) continue;
      const found = assets.buffer(ref.assetId);
      if (!found) throw new ProviderError(`参考图素材不存在：${ref.assetId}`);
      const asset = found.asset ?? {};
      const uploaded = await comfy.uploadImage({
        buffer: found.buffer,
        name: asset.name ?? `${ref.assetId}.png`,
        mime: asset.mime ?? 'image/png',
      });
      mapping[ref.assetId] = uploaded.ref;
    }
    return applyAssetRefs(prompt, mapping);
  }

  async function cancel(runId) {
    const run = store.getRun(runId);
    if (!run) return null;
    const comfy = ensureClient();
    try {
      await comfy.interrupt(run.promptId);
    } catch (err) {
      logger?.debug?.(`[comfy] interrupt 失败：${err?.message ?? err}`);
    }
    return store.updateRun(runId, { status: 'cancelled' });
  }

  async function test() {
    try {
      return await ensureClient().test();
    } catch (err) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  }

  async function queue() {
    try {
      const summary = await ensureClient().queue();
      lastQueue = summary;
      lastQueueError = null;
      return summary;
    } catch (err) {
      lastQueueError = err?.message ?? String(err);
      return { ...lastQueue, error: lastQueueError };
    }
  }

  /** 这台 ComfyUI 上装了哪些 LoRA（拉不到就返回空清单 + 原因，不抛）。 */
  async function loras() {
    try {
      return { items: await ensureClient().loras(), error: null };
    } catch (err) {
      return { items: [], error: err?.message ?? String(err) };
    }
  }

  /** 重启后把没盯完的任务接回来。 */
  function resume() {
    if (isClientMode()) return { resumed: 0 };
    const active = store.activeRuns();
    if (!active.length) return { resumed: 0 };
    ensurePoller();
    connectWs();
    return { resumed: active.length };
  }

  function stop() {
    stopped = true;
    closeWs();
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  return {
    clientId,
    submit,
    cancel,
    test,
    queue,
    loras,
    resume,
    stop,
    refreshRun: (runId) => refreshRun(store.getRun(runId)),
    status() {
      return { connected, baseUrl: config().baseUrl, queue: lastQueue, queueError: lastQueueError };
    },
  };
}
