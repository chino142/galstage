/**
 * 平台接口：模型接入（已实现）、素材库与数据导入导出（占位）。
 *
 * 提供方是第一批真正落地的功能：密钥加密存放，列表永远不带明文 key。
 */

import { stubs } from './_helpers.mjs';
import { ADAPTERS, PRESETS } from '../providers/catalog.mjs';
import { AUTH_STYLES, DEFAULT_AUTH_STYLE } from '../providers/auth.mjs';
import { adapterParamForm, validateAdapterParams } from '../providers/params.mjs';
import { getProviderParamOverrides, setProviderParamOverrides } from '../db/providers.mjs';
import { modelParamPolicy } from '../../core/providers-model-rules.mjs';
import {
  listProviders,
  getProvider,
  createProvider,
  updateProvider,
  deleteProvider,
  getProviderExtraBody,
  setProviderExtraBody,
} from '../db/providers.mjs';
import { createThumbnailStore } from '../db/studio.mjs';
import { detachAssetRefs } from '../db/chat.mjs';
import { testProxy } from '../providers/proxy.mjs';
import { proxyStatus } from '../providers/http.mjs';

/** 缩略图仓储按 repo 缓存一份。 */
const THUMBS = new WeakMap();
function thumbsFor(repo) {
  if (!repo) return null;
  if (!THUMBS.has(repo)) THUMBS.set(repo, createThumbnailStore({ repo }));
  return THUMBS.get(repo);
}

export function register(router, { engine, repo, models, masterKey, assets }) {
  router.get('/api/providers', (ctx) => {
    const items = listProviders(repo);
    const kinds = engine.providers.kinds().map((kind) => {
      const mine = items.filter((item) => item.kind === kind.id);
      return {
        ...kind,
        count: mine.length,
        implemented: mine.some((item) => item.enabled),
        providers: mine.map((item) => ({ id: item.id, label: item.label, status: item.enabled ? 'ready' : 'planned' })),
      };
    });
    // 采样参数按适配器分开：界面照 adapterParams[适配器] 渲染输入框，
    // 这样"能填的"和"真发得出去的"永远是同一套（两边共用 params.mjs 那份表）。
    const adapterParams = Object.fromEntries(ADAPTERS.map((item) => [item.id, adapterParamForm(item.id)]));
    return ctx.json(200, { kinds, adapters: ADAPTERS, presets: PRESETS, adapterParams, items });
  });

  /** 单独给一个适配器的参数表（界面切适配器时不用整份重拉）。 */
  router.get('/api/providers/params/:adapter', (ctx) => ctx.json(200, adapterParamForm(ctx.params.adapter)));

  /** 保存前按适配器校验参数；不合法就把原因交回去，由调用方回 400。 */
  function tryParams(adapter, params) {
    if (params === undefined) return { ok: true, value: undefined };
    try {
      return { ok: true, value: validateAdapterParams(adapter, params ?? {}) };
    } catch (err) {
      return { ok: false, message: err?.message ?? String(err) };
    }
  }

  const withParams = (body, value) => ({ ...body, ...(value === undefined ? {} : { params: value }) });

  router.get('/api/providers/auth-styles', (ctx) =>
    ctx.json(200, { items: AUTH_STYLES, defaults: DEFAULT_AUTH_STYLE }),
  );

  /**
   * 本地代理托管会以**服务进程的身份**执行配置里的命令。单机模式（你自己的机器）随便用；
   * 多用户模式下只有管理员能用 —— 否则任何一个有账号的人都能在主机上执行任意命令，
   * 那等于把整个租户隔离作废（能读别人的 tavern.db / master.key）。租户运行时那边
   * （`server/tenants.mjs`）对非管理员账号干脆不建 launcher，这里是接口这一层的同一道闸。
   */
  function launcherAllowed(ctx) {
    if (!ctx.app.multiUser) return true;
    return ctx.app.auth?.user?.role === 'admin';
  }
  const LAUNCHER_DENIED = '多用户模式下只有管理员能配置 / 启动本地代理：那等于在主机上执行命令。要自己用，就在单机模式（或管理员账号）下跑。';

  /** 本地代理（CLI / 反重力那类渠道）的启停与日志。 */
  router.post('/api/providers/:id/start', async (ctx) => {
    if (!launcherAllowed(ctx)) return ctx.fail(403, 'FORBIDDEN', LAUNCHER_DENIED);
    if (!models.launcher) return ctx.fail(501, 'NOT_IMPLEMENTED', '这一版没有启用本地代理托管');
    return ctx.json(200, await models.launcher.start(ctx.params.id));
  });

  router.post('/api/providers/:id/stop', (ctx) => {
    if (!launcherAllowed(ctx)) return ctx.fail(403, 'FORBIDDEN', LAUNCHER_DENIED);
    if (!models.launcher) return ctx.fail(501, 'NOT_IMPLEMENTED', '这一版没有启用本地代理托管');
    models.launcher.stop(ctx.params.id);
    return ctx.json(200, { ok: true });
  });

  router.get('/api/providers/:id/launcher', (ctx) => {
    const item = getProvider(repo, ctx.params.id);
    if (!item) return ctx.fail(404, 'NOT_FOUND', `没有这个提供方：${ctx.params.id}`);
    const status = models.launcher ? models.launcher.status(ctx.params.id) : { running: false, ready: false, logs: [] };
    return ctx.json(200, { configured: item.launcher, status });
  });

  router.post('/api/providers', async (ctx) => {
    const body = (await ctx.body()) ?? {};
    if (body.launcher && !launcherAllowed(ctx)) return ctx.fail(403, 'FORBIDDEN', LAUNCHER_DENIED);
    const cleaned = tryParams(body.adapter ?? 'openai', body.params);
    if (!cleaned.ok) return ctx.fail(400, 'VALIDATION_ERROR', cleaned.message);
    return ctx.json(201, createProvider(repo, masterKey, withParams(body, cleaned.value)));
  });

  router.get('/api/providers/:id', (ctx) => {
    const item = getProvider(repo, ctx.params.id);
    if (!item) return ctx.fail(404, 'NOT_FOUND', `没有这个提供方：${ctx.params.id}`);
    return ctx.json(200, item);
  });

  router.put('/api/providers/:id', async (ctx) => {
    const body = (await ctx.body()) ?? {};
    if (body.launcher && !launcherAllowed(ctx)) return ctx.fail(403, 'FORBIDDEN', LAUNCHER_DENIED);
    const existing = getProvider(repo, ctx.params.id);
    if (!existing) return ctx.fail(404, 'NOT_FOUND', `没有这个提供方：${ctx.params.id}`);
    const cleaned = tryParams(body.adapter ?? existing.adapter ?? 'openai', body.params);
    if (!cleaned.ok) return ctx.fail(400, 'VALIDATION_ERROR', cleaned.message);
    return ctx.json(200, updateProvider(repo, masterKey, ctx.params.id, withParams(body, cleaned.value)));
  });

  router.delete('/api/providers/:id', (ctx) => {
    deleteProvider(repo, ctx.params.id);
    return ctx.noContent();
  });

  router.get('/api/providers/:id/models', async (ctx) => {
    const list = await models.models(ctx.params.id);
    return ctx.json(200, { items: list, total: list.length });
  });

  router.post('/api/providers/:id/test', async (ctx) => {
    ctx.bodyLimit = 64 * 1024;
    return ctx.json(200, await models.test(ctx.params.id));
  });

  // ---- 素材库：出图的结果、参考图都放这里 ----
  router.get('/api/assets', (ctx) => {
    if (!assets) return ctx.json(200, { items: [], total: 0 });
    const items = assets.list({ kind: ctx.query.kind ?? null, limit: ctx.query.limit ?? 100 });
    return ctx.json(200, { items, total: items.length });
  });

  router.post('/api/assets', async (ctx) => {
    if (!assets) return ctx.fail(501, 'NOT_IMPLEMENTED', '这一版没有启用素材库');
    ctx.bodyLimit = 32 * 1024 * 1024;
    const body = (await ctx.body()) ?? {};
    if (!body.data) return ctx.fail(400, 'VALIDATION_ERROR', '上传素材要带 data（base64）');
    const buffer = Buffer.from(String(body.data).replace(/^data:[^,]*,/, ''), 'base64');
    if (!buffer.length) return ctx.fail(400, 'VALIDATION_ERROR', '素材内容是空的');
    const saved = assets.save({
      buffer,
      kind: body.kind ?? 'image',
      name: body.name ?? null,
      mime: body.mime ?? 'application/octet-stream',
      width: body.width ?? null,
      height: body.height ?? null,
      meta: body.meta ?? {},
    });
    return ctx.json(201, saved);
  });

  router.get('/api/assets/:id', (ctx) => {
    if (!assets) return ctx.fail(501, 'NOT_IMPLEMENTED', '这一版没有启用素材库');
    const found = assets.get(ctx.params.id);
    if (!found) return ctx.fail(404, 'NOT_FOUND', `没有这个素材：${ctx.params.id}`);
    return ctx.json(200, found);
  });

  /**
   * 允许"原样内联发出去"的类型。除此之外一律降级成 application/octet-stream + 下载，
   * 绝不把存在库里的 mime 直接回给浏览器 —— 否则"上传一个 mime=text/html 的素材，
   * 再打开它的 URL"就是在同源里执行任意脚本（stored XSS）。
   */
  // 能 inline 的类型 = 浏览器要"当资源加载"而不是"当文件下载"的：图片、光标、字体、音视频。
  // 光标（.cur/.ico）和字体是卡内前端的常客；缺了它们，卡里的自定义光标和 @font-face 会静默失效。
  const INLINE_ASSET_TYPES = /^(image\/(png|jpe?g|webp|gif|bmp|avif|svg\+xml|x-icon)|font\/[a-z0-9.+-]+|audio\/[a-z0-9.+-]+|video\/[a-z0-9.+-]+)$/i;

  /** 真正取字节的接口：前端 <img src> 直接指这里。 */
  router.get('/api/assets/:id/file', (ctx) => {
    if (!assets) return ctx.fail(501, 'NOT_IMPLEMENTED', '这一版没有启用素材库');
    const found = assets.buffer(ctx.params.id);
    if (!found) return ctx.fail(404, 'NOT_FOUND', `没有这个素材：${ctx.params.id}`);
    const stored = String(found.asset.mime ?? '');
    const inline = INLINE_ASSET_TYPES.test(stored);
    // 这两条是"万一还是被当成文档打开"的兜底：不准猜类型，也不准执行任何东西
    ctx.res.setHeader('X-Content-Type-Options', 'nosniff');
    ctx.res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    if (!inline) ctx.res.setHeader('Content-Disposition', 'attachment');
    return ctx.text(200, found.buffer, inline ? stored : 'application/octet-stream');
  });

  router.delete('/api/assets/:id', (ctx) => {
    if (!assets) return ctx.fail(501, 'NOT_IMPLEMENTED', '这一版没有启用素材库');
    if (!assets.remove(ctx.params.id)) return ctx.fail(404, 'NOT_FOUND', `没有这个素材：${ctx.params.id}`);
    thumbsFor(repo)?.remove(ctx.params.id);
    return ctx.noContent();
  });

  /**
   * 删掉一张出图（ComfyUI 面板上的「删除这张」）：
   * 素材文件 + 缩略图 + 出图记录里的引用 + 消息附件里的引用，一次收干净；
   * 摘完一张不剩的那条出图记录也一起删掉（不然"最近的出图"里会剩一排空壳卡片）。
   * 只删素材的话，出图列表和聊天里会各留一张裂图 —— 那条路子仍然留给素材库自己的删除。
   */
  router.delete('/api/comfy/images/:assetId', (ctx) => {
    if (!assets) return ctx.fail(501, 'NOT_IMPLEMENTED', '这一版没有启用素材库');
    const assetId = String(ctx.params.assetId ?? '').trim();
    if (!assetId) return ctx.fail(400, 'VALIDATION_ERROR', '要删哪张图？');
    const comfy = engine?.services?.comfy ?? null;
    const touched = comfy?.detachImage ? comfy.detachImage(assetId) : [];
    const pruned = comfy?.pruneRuns ? comfy.pruneRuns(touched) : 0;
    const messages = detachAssetRefs(repo, assetId);
    const removed = assets.remove(assetId);
    if (!removed && !touched.length && !messages) return ctx.fail(404, 'NOT_FOUND', `没有这张图：${assetId}`);
    if (removed) thumbsFor(repo)?.remove(assetId);
    return ctx.json(200, { assetId, removed, runs: touched.length, pruned, messages });
  });

  /**
   * 缩略图：素材库原来直接用原图靠 CSS 缩，几百张就卡。
   * 小图由浏览器端 canvas 生成后传上来（零依赖，也不需要服务端装图像库）。
   */
  router.get('/api/assets/:id/thumb', (ctx) => {
    const store = thumbsFor(repo);
    const found = store?.get(ctx.params.id);
    if (!found) return ctx.fail(404, 'NOT_FOUND', `这张素材还没有缩略图：${ctx.params.id}`);
    ctx.res.setHeader('X-Content-Type-Options', 'nosniff');
    ctx.res.setHeader('Cache-Control', 'public, max-age=86400');
    return ctx.text(200, found.bytes, found.mime || 'image/webp');
  });

  router.post('/api/assets/:id/thumbnail', async (ctx) => {
    const store = thumbsFor(repo);
    if (!store) return ctx.fail(501, 'NOT_IMPLEMENTED', '这一版没有启用素材库');
    ctx.bodyLimit = 4 * 1024 * 1024;
    const body = (await ctx.body()) ?? {};
    if (!body.data) return ctx.fail(400, 'VALIDATION_ERROR', '缩略图要带 data（base64）');
    const buffer = Buffer.from(String(body.data).replace(/^data:[^,]*,/, ''), 'base64');
    if (!buffer.length) return ctx.fail(400, 'VALIDATION_ERROR', '缩略图内容是空的');
    if (buffer.length > 2 * 1024 * 1024) return ctx.fail(400, 'VALIDATION_ERROR', '缩略图太大了（上限 2MB）');
    const saved = store.save(ctx.params.id, {
      mime: String(body.mime ?? 'image/webp'),
      bytes: buffer,
      width: body.width ?? null,
      height: body.height ?? null,
    });
    return ctx.json(201, { assetId: ctx.params.id, mime: saved.mime, bytes: buffer.length });
  });

  router.get('/api/assets/:id/thumb/status', (ctx) => {
    const store = thumbsFor(repo);
    return ctx.json(200, { has: Boolean(store?.has(ctx.params.id)) });
  });

  // ---- 网络代理：给连不上外网的模型走代理 ----
  router.get('/api/net/proxy', (ctx) => ctx.json(200, proxyStatus()));

  router.post('/api/net/proxy/test', async (ctx) => {
    const body = (await ctx.body()) ?? {};
    const target = String(body.proxy ?? '');
    if (!target.trim()) return ctx.fail(400, 'VALIDATION_ERROR', '要先填代理地址');
    const result = await testProxy(target);
    return ctx.json(200, result);
  });

  // ---- 自定义请求体：给懂行的人完全接管发出去的 JSON ----
  router.get('/api/providers/:id/extra-body', (ctx) => {
    const found = getProvider(repo, ctx.params.id);
    if (!found) return ctx.fail(404, 'NOT_FOUND', `没有这个提供方：${ctx.params.id}`);
    return ctx.json(200, { providerId: ctx.params.id, extraBody: getProviderExtraBody(repo, ctx.params.id) });
  });

  router.put('/api/providers/:id/extra-body', async (ctx) => {
    const found = getProvider(repo, ctx.params.id);
    if (!found) return ctx.fail(404, 'NOT_FOUND', `没有这个提供方：${ctx.params.id}`);
    const body = (await ctx.body()) ?? {};
    const extra = body.extraBody ?? body;
    if (extra && (typeof extra !== 'object' || Array.isArray(extra))) {
      return ctx.fail(400, 'VALIDATION_ERROR', 'extraBody 必须是一个 JSON 对象');
    }
    return ctx.json(200, { providerId: ctx.params.id, extraBody: setProviderExtraBody(repo, ctx.params.id, extra ?? {}) });
  });

  /**
   * 参数覆盖表：这家模型不认哪些参数（连预设带来的也一起丢）、又有哪些专属参数。
   * 各家模型换代时扔参数/加参数，适配器表分辨率到不了单个模型，所以放在提供方这一层。
   */
  router.get('/api/providers/:id/param-overrides', (ctx) => {
    const found = getProvider(repo, ctx.params.id);
    if (!found) return ctx.fail(404, 'NOT_FOUND', `没有这个提供方：${ctx.params.id}`);
    // 顺带把"按模型名自动判定的禁用"也回给界面（例如 Gemini 3.6/3.7 flash 不收 temperature）
    return ctx.json(200, {
      providerId: ctx.params.id,
      ...getProviderParamOverrides(repo, ctx.params.id),
      modelPolicy: modelParamPolicy(found.model ?? '', { adapter: found.adapter }),
    });
  });

  router.put('/api/providers/:id/param-overrides', async (ctx) => {
    const found = getProvider(repo, ctx.params.id);
    if (!found) return ctx.fail(404, 'NOT_FOUND', `没有这个提供方：${ctx.params.id}`);
    const body = (await ctx.body()) ?? {};
    return ctx.json(200, { providerId: ctx.params.id, ...setProviderParamOverrides(repo, ctx.params.id, body) });
  });

  /**
   * 试探这家到底认哪些参数：逐个参数发一个最小请求，谁的错就记在谁头上。
   *
   * 为什么不查文档就够了：多数"新模型不认老参数"的表现是 400 里点名，
   * 而各家（尤其转站）行为不一样 —— 实测最准。每个参数一次极小请求，
   * 失败只记结果，不影响别的参数。
   */
  router.post('/api/providers/:id/probe-params', async (ctx) => {
    const found = getProvider(repo, ctx.params.id);
    if (!found) return ctx.fail(404, 'NOT_FOUND', `没有这个提供方：${ctx.params.id}`);
    const body = (await ctx.body()) ?? {};
    const candidates = Array.isArray(body.params) && body.params.length
      ? body.params.map((item) => (typeof item === 'string' ? { key: item } : item)).slice(0, 24)
      : [
          { key: 'temperature', value: 1 },
          { key: 'top_p', value: 0.9 },
          { key: 'top_k', value: 40 },
          { key: 'seed', value: 7 },
          { key: 'logit_bias', value: { 50256: -100 } },
          { key: 'logprobs', value: true },
          { key: 'presence_penalty', value: 0.5 },
          { key: 'frequency_penalty', value: 0.5 },
          { key: 'reasoning_effort', value: 'low' },
          { key: 'thinking_level', value: 'low' },
        ];
    const results = [];
    for (const item of candidates) {
      const key = String(item?.key ?? '').trim();
      if (!key) continue;
      const value = item.value ?? true;
      try {
        await models.complete(ctx.params.id, {
          model: found.model ?? null,
          messages: [{ role: 'user', content: 'ping' }],
          params: { [key]: value, max_tokens: 1, streamMode: 'full' },
        });
        results.push({ key, ok: true });
      } catch (err) {
        const message = String(err?.message ?? err);
        // 有的后端是"整个参数集不认某个字段"，报错里会点名；没点名也记下来
        const named = message.toLowerCase().includes(key.toLowerCase());
        results.push({ key, ok: false, named, error: message.slice(0, 300) });
      }
    }
    return ctx.json(200, {
      providerId: ctx.params.id,
      model: found.model ?? null,
      ok: results.filter((item) => item.ok).length,
      failed: results.filter((item) => !item.ok).length,
      results,
      note: '失败里 named=true 表示对方报错时**点名**了这个字段，基本可以断定它不认；'
        + 'named=false 的可能是别的原因（网络 / key / 模型名），再看一眼报错内容。'
        + '确认不认的，就在「这家模型不认哪些参数」里勾上，之后连预设带来的同名参数也会被丢掉。',
    });
  });

  stubs(router, [
    ['GET', '/api/data/export', '导出全部数据'],
    ['POST', '/api/data/import', '导入数据'],
    ['GET', '/api/data/schema', '数据库结构'],
    ['POST', '/api/data/vacuum', '整理数据库'],
  ]);
}
