/**
 * 角色卡接口（写卡区的第一块）。
 *
 * 注意注册顺序：静态路径要排在 :id 之前，否则 /api/characters/fields
 * 会被当成 id = "fields" 的请求。路由器是"先注册先匹配"。
 *
 * 导入 / 解析走原始字节（PNG 卡没有 JSON body），但为了配合界面的批量导入，
 * 同一个 import 接口也接受 JSON：`{ files: [{ name, dataBase64 }] }`。
 * 两条路径都要能用 —— 界面用哪条就别再只支持另一条（玩卡区踩过这个坑）。
 */

import { ValidationError } from '../../core/errors.mjs';
import { LOCKABLE_FIELDS, checkLocks, extrasOf, mergeExtras, withExtras } from '../../core/cards/extras.mjs';
import { platformCardFromExport } from '../../core/cards/platform-import.mjs';
import {
  LOCALISE_LIMITS,
  findExternalUrls,
  kindFromMime,
  mapWithConcurrency,
  nameFromUrl,
  rewriteExternalUrls,
  sniffMime,
} from '../../core/frontend/localise.mjs';
import { openSse } from '../http/sse.mjs';
import { httpFetch } from '../providers/http.mjs';
import { safeAutoBackup } from './_helpers.mjs';
import { readZip } from '../toolbox/zip.mjs';

const CARD_BODY_LIMIT = 64 * 1024 * 1024;

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

/** 是不是 zip（卡包常这么发）：看头四个字节。 */
function looksLikeZip(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length > 4 && buffer.subarray(0, 4).equals(ZIP_MAGIC);
}

/**
 * 把一个 zip 摊成卡片文件列表：只挑 PNG / JSON，跳过目录和 macOS 的垃圾（__MACOSX / 点开头）。
 * 卡包通常还套一层文件夹，所以取 basename 当卡名。
 */
function expandCardZip(name, buffer) {
  let entries;
  try {
    entries = readZip(buffer);
  } catch (err) {
    throw new ValidationError(`${name} 打不开：${err?.message ?? '不是有效的 zip'}`);
  }
  const out = [];
  for (const entry of entries) {
    const entryName = String(entry?.name ?? '').replace(/\\/g, '/');
    if (!entryName || entryName.endsWith('/')) continue;
    if (entryName.startsWith('__MACOSX/')) continue;
    if (entryName.split('/').some((segment) => segment.startsWith('.'))) continue;
    if (!/\.(png|json)$/i.test(entryName)) continue;
    out.push({ name: entryName.split('/').pop(), buffer: entry.data });
  }
  if (!out.length) throw new ValidationError(`${name} 里没有 PNG / JSON 卡`);
  return out;
}

/** 头像在前端是 dataURL / base64 字符串，落库前解成 Buffer。 */
function decodeAvatar(payload) {
  if (payload && typeof payload.avatar === 'string') {
    const base64 = payload.avatar.replace(/^data:[^,]*,/, '');
    payload.avatar = base64 ? Buffer.from(base64, 'base64') : null;
  }
  return payload;
}

/** 把一次请求读成 [{ name, buffer }]，兼容原始字节与 JSON 批量两种写法。 */
async function readCardFiles(ctx) {
  const raw = await ctx.readRawBody();
  const type = String(ctx.req.headers['content-type'] ?? '');
  if (type.includes('json')) {
    let payload;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new ValidationError('请求体不是合法 JSON');
    }
    const incoming = Array.isArray(payload?.files) ? payload.files : payload?.dataBase64 ? [payload] : [];
    if (!incoming.length) throw new ValidationError('没有收到任何卡文件（files 为空）');
    return incoming.flatMap((file) => {
      const base64 = String(file.dataBase64 ?? file.data ?? '');
      if (!base64) throw new ValidationError(`文件 ${file.name ?? '（无名）'} 没有内容`);
      const item = { name: file.name ?? '未命名', buffer: Buffer.from(base64, 'base64') };
      return looksLikeZip(item.buffer) ? expandCardZip(item.name, item.buffer) : [item];
    });
  }
  if (!raw.length) throw new ValidationError('请求体是空的，没有卡文件');
  const name = ctx.query.name ?? '未命名';
  return looksLikeZip(raw) ? expandCardZip(name, raw) : [{ name, buffer: raw }];
}

export function register(router, { engine, logger, assets }) {
  const cards = engine.services.cards;
  const frontend = engine.services.frontend;

  // ---- 字段表与统计（静态路径，必须在 :id 之前）----
  router.get('/api/characters/fields', (ctx) =>
    ctx.json(200, { items: cards.fields(), groups: engine.blueprint.cards.groups }),
  );
  router.get('/api/characters/stats', async (ctx) => ctx.json(200, await cards.stats()));

  router.get('/api/characters', async (ctx) => {
    const query = {
      q: ctx.query.q ?? '',
      tag: ctx.query.tag ?? '',
      favorite: ctx.query.favorite === undefined ? null : ctx.query.favorite === 'true' || ctx.query.favorite === '1',
      source: ctx.query.source ?? '',
      status: ctx.query.status ?? '',
      sort: ctx.query.sort ?? 'updated',
      limit: ctx.query.limit ?? 200,
      offset: ctx.query.offset ?? 0,
    };
    const { items, total } = await cards.list(query);
    return ctx.json(200, { items, total });
  });

  // ---- 解析与批量导入（不落库 / 落库）----
  router.post('/api/characters/parse', async (ctx) => {
    const files = await readCardFiles(ctx);
    return ctx.json(200, await cards.parse(files[0].buffer, { name: files[0].name }));
  }, { bodyLimit: CARD_BODY_LIMIT });

  router.post('/api/characters/import', async (ctx) => {
    const files = await readCardFiles(ctx);
    // 批量导入是会一次性写很多行的破坏性操作（也可能覆盖同名卡），先留一份。
    if (files.length > 1) safeAutoBackup({ engine, logger, reason: '批量导入角色卡前', kind: 'pre-import' });
    const result = await cards.importFiles(files, { source: ctx.query.source ?? 'imported' });
    return ctx.json(201, result);
  }, { bodyLimit: CARD_BODY_LIMIT });

  router.post('/api/characters', async (ctx) => {
    const payload = decodeAvatar(await ctx.body());
    return ctx.json(201, await cards.create(payload ?? {}));
  }, { bodyLimit: CARD_BODY_LIMIT });

  /**
   * 从那个闭源平台的「作品 JSON」导入一张卡。
   *
   * 默认导成 imported（安全档：跑之前要你点一次信任、保存要过静态检查）。
   * 自己写的作品可以用 ?source=original，直接按"自己的卡"处理。
   * 映射细节见 core/cards/platform-import.mjs。
   */
  router.post('/api/characters/import-platform', async (ctx) => {
    const body = (await ctx.body()) ?? {};
    const doc = body.document ?? body;
    let mapped;
    try {
      mapped = platformCardFromExport(doc, { name: body.name });
    } catch (err) {
      return ctx.fail(400, 'BAD_PLATFORM_CARD', err?.message ?? String(err));
    }
    const source = ctx.query.source === 'original' ? 'original' : 'imported';
    const created = await cards.create({
      data: mapped.card,
      name: mapped.card.name,
      source,
      tags: mapped.card.tags,
    });
    // 卡内前端代码 + 平台专属字段（bgm / 推荐问题 / 默认消息数）都挂在 extras 上
    const merged = mergeExtras(extrasOf(created.data), { frontend: mapped.frontend, platform: mapped.platform });
    let saved = await cards.update(created.id, {
      data: withExtras(created.data, merged),
      note: '从平台作品导入',
    });

    /**
     * 封面：平台给的是一个网址，顺手抓回来 —— 别让搬过来的卡在卡库里是一片占位图。
     *
     * 两种落法：
     *   · PNG → 直接当卡头像（导出的 PNG 卡要把头像嵌回去，所以只认 PNG）
     *   · 其它图片（jpeg / webp…）→ 存进素材库，卡片数据里记一个 cover，
     *     列表照样显示它（我们零依赖，没法在服务端转码，所以不硬转）
     * 抓不到就算了：封面是附属品，不能因为它让导入失败（PotatoVN 也是这个路子）。
     */
    let coverReport = null;
    /** 抓一张平台给的图存进素材库（封面 / 横幅都走它）。返回 { assetId, mime, bytes } 或抛错。 */
    const grabImage = async (url) => {
      const response = await fetch(url, { redirect: 'follow' });
      if (!response.ok) throw new Error(`对方返回 ${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      if (!buffer.length) throw new Error('抓回来是空的');
      if (buffer.length > LOCALISE_LIMITS.maxFileBytes) throw new Error(`${(buffer.length / 1048576).toFixed(1)}MB，太大了`);
      const mime = sniffMime({ buffer, url, contentType: response.headers.get('content-type') ?? '' });
      if (!String(mime).startsWith('image/')) throw new Error(`不是一个图片（${mime}）`);
      if (mime === 'image/png') return { buffer, mime, bytes: buffer.length, png: true };
      const asset = assets.save({
        buffer,
        kind: 'image',
        name: nameFromUrl(url),
        mime,
        meta: { sourceUrl: url, from: 'platform-import' },
      });
      return { mime, bytes: buffer.length, png: false, assetId: asset.id };
    };
    const coverUrl = String(mapped.cover ?? '');
    if (/^https?:\/\//i.test(coverUrl)) {
      try {
        const grabbed = await grabImage(coverUrl);
        if (grabbed.png) {
          saved = (await cards.update(saved.id, { avatar: grabbed.buffer, note: '导入封面' })) ?? saved;
          coverReport = { ok: true, mime: grabbed.mime, bytes: grabbed.bytes, as: 'avatar' };
        } else {
          const data = { ...saved.data, extensions: { ...(saved.data?.extensions ?? {}), st_cover: grabbed.assetId } };
          saved = (await cards.update(saved.id, { data, note: '导入封面素材' })) ?? saved;
          coverReport = { ok: true, mime: grabbed.mime, bytes: grabbed.bytes, as: 'asset', assetId: grabbed.assetId };
        }
      } catch (err) {
        coverReport = { ok: false, error: String(err?.message ?? err) };
      }
    }

    // 卡自己的背景（横幅）：存成素材，挂进卡内前端 —— 沙箱里会变成 --st-card-bg
    let backgroundReport = null;
    const bgUrl = String(mapped.backgroundImage ?? '');
    if (/^https?:\/\//i.test(bgUrl)) {
      try {
        const grabbed = await grabImage(bgUrl);
        let assetId = grabbed.assetId;
        if (!assetId) {
          // PNG 也走素材库（背景不要求 PNG，头像才要）
          const asset = assets.save({
            buffer: grabbed.buffer,
            kind: 'image',
            name: nameFromUrl(bgUrl),
            mime: grabbed.mime,
            meta: { sourceUrl: bgUrl, from: 'platform-import-background' },
          });
          assetId = asset.id;
        }
        const frontendCode = { ...extrasOf(saved.data).frontend, background: `/api/assets/${assetId}/file` };
        const next = mergeExtras(extrasOf(saved.data), { frontend: frontendCode });
        saved = (await cards.update(saved.id, { data: withExtras(saved.data, next), note: '导入卡背景' })) ?? saved;
        backgroundReport = { ok: true, mime: grabbed.mime, bytes: grabbed.bytes, assetId };
      } catch (err) {
        backgroundReport = { ok: false, error: String(err?.message ?? err) };
      }
    }

    // 顺手把"这段代码会踩哪些规则"告诉他，省得点开才发现不让跑
    const described = frontend.describeCardFrontend({
      source: saved.source,
      code: extrasOf(saved.data).frontend,
      trust: frontend.trustOf(saved.id),
    });
    return ctx.json(201, {
      card: { id: saved.id, name: saved.name, source: saved.source, tags: saved.tags },
      cover: coverReport,
      background: backgroundReport,
      report: {
        ...mapped.report,
        frontendCheck: {
          ok: described.validation.ok,
          errors: described.validation.errors,
          issues: described.validation.issues.map((issue) => ({ rule: issue.rule, severity: issue.severity, message: issue.message })),
          needsTrust: !described.policy.trusted,
        },
      },
    });
  }, { bodyLimit: CARD_BODY_LIMIT });

  router.get('/api/characters/:id', async (ctx) => {
    const card = await cards.get(ctx.params.id);
    if (!card) return ctx.fail(404, 'NOT_FOUND', `没有这张角色卡：${ctx.params.id}`);
    return ctx.json(200, card);
  });

  router.put('/api/characters/:id', async (ctx) => {
    const payload = decodeAvatar(await ctx.body());
    // 一致性锁定：被钉死的字段不许改（不管从界面、Agent 还是 MCP 来）。
    const existing = await cards.get(ctx.params.id);
    if (!existing) return ctx.fail(404, 'NOT_FOUND', `没有这张角色卡：${ctx.params.id}`);
    const violated = checkLocks(extrasOf(existing.data), payload ?? {}, existing.data ?? {});
    if (violated.length) {
      return ctx.fail(409, 'CARD_LOCKED', `这些字段被一致性锁定钉住了，改之前先解锁：${violated.join('、')}`);
    }
    const updated = await cards.update(ctx.params.id, payload ?? {});
    if (!updated) return ctx.fail(404, 'NOT_FOUND', `没有这张角色卡：${ctx.params.id}`);
    return ctx.json(200, updated);
  }, { bodyLimit: CARD_BODY_LIMIT });

  // ---- 加分项（1.10）：剧本大纲 / 卡内 BGM / 关系图 / 一致性锁定 ----
  router.get('/api/characters/:id/extras', async (ctx) => {
    const card = await cards.get(ctx.params.id);
    if (!card) return ctx.fail(404, 'NOT_FOUND', `没有这张角色卡：${ctx.params.id}`);
    return ctx.json(200, { extras: extrasOf(card.data), lockableFields: LOCKABLE_FIELDS });
  });

  router.put('/api/characters/:id/extras', async (ctx) => {
    const card = await cards.get(ctx.params.id);
    if (!card) return ctx.fail(404, 'NOT_FOUND', `没有这张角色卡：${ctx.params.id}`);
    const patch = (await ctx.body()) ?? {};
    const next = mergeExtras(extrasOf(card.data), patch);
    const updated = await cards.update(ctx.params.id, { data: withExtras(card.data, next), note: '保存卡内加分项' });
    return ctx.json(200, { extras: extrasOf(updated.data), lockableFields: LOCKABLE_FIELDS });
  }, { bodyLimit: CARD_BODY_LIMIT });

  // ---- 卡内界面（卡自带 HTML / CSS / JS）：代码存在卡数据里，跟着导出走 ----

  /**
   * 一次拿全：卡里的代码、代码哈希、按"卡从哪来 + 你信不信这段代码"算出的策略、渲染结果。
   * 对话页与写卡区都调这一个 —— 信任判定只在服务端做，前端说了不算。
   */
  router.get('/api/characters/:id/frontend', async (ctx) => {
    const card = await cards.get(ctx.params.id);
    if (!card) return ctx.fail(404, 'NOT_FOUND', `没有这张角色卡：${ctx.params.id}`);
    const described = frontend.describeCardFrontend({
      source: card.source,
      code: extrasOf(card.data).frontend,
      trust: frontend.trustOf(card.id),
    });
    return ctx.json(200, { cardId: card.id, name: card.name, source: card.source, ...described });
  });

  /**
   * 存卡内界面代码。**门槛按卡的档走**：自己的卡随便写；别人的卡要先过沙箱静态检查。
   *
   * 注意这里看的是 tier 而不是"信不信任"：信任解决的是"要不要跳过检查直接跑"，
   * 不是"我有权改别人的代码"。想随心所欲地改，就把它变成自己的卡（另存一张）。
   */
  router.post('/api/characters/:id/frontend', async (ctx) => {
    const card = await cards.get(ctx.params.id);
    if (!card) return ctx.fail(404, 'NOT_FOUND', `没有这张角色卡：${ctx.params.id}`);
    const body = (await ctx.body()) ?? {};
    // 只传一部分 = 只改那一部分（界面总是三段一起传）
    const current = extrasOf(card.data).frontend;
    const code = {
      html: body.html ?? current.html,
      css: body.css ?? current.css,
      js: body.js ?? current.js,
      capabilities: body.capabilities ?? current.capabilities,
      // 导入时搬过来的横幅别因为"改一次代码"就丢了
      background: body.background ?? current.background,
    };
    const described = frontend.describeCardFrontend({ source: card.source, code, trust: frontend.trustOf(card.id) });
    if (!described.validation.ok && described.policy.tier !== 'own') {
      return ctx.fail(400, 'FRONTEND_INVALID', described.blocked ?? '卡内前端有违反沙箱边界的写法，先改掉再存');
    }
    const next = mergeExtras(extrasOf(card.data), { frontend: described.code });
    const updated = await cards.update(card.id, { data: withExtras(card.data, next), note: '保存卡内界面' });
    const saved = frontend.describeCardFrontend({
      source: updated.source,
      code: extrasOf(updated.data).frontend,
      trust: frontend.trustOf(updated.id),
    });
    return ctx.json(200, { cardId: updated.id, name: updated.name, source: updated.source, ...saved });
  }, { bodyLimit: CARD_BODY_LIMIT });

  /** 信任这张卡的当前这段代码（哈希存信任表；代码一改就又回到未信任）。 */
  router.post('/api/characters/:id/frontend/trust', async (ctx) => {
    const card = await cards.get(ctx.params.id);
    if (!card) return ctx.fail(404, 'NOT_FOUND', `没有这张角色卡：${ctx.params.id}`);
    const code = extrasOf(card.data).frontend;
    const { codeHash } = frontend.describeCardFrontend({ source: card.source, code, trust: null });
    frontend.trustCardFrontend(card.id, codeHash);
    const described = frontend.describeCardFrontend({ source: card.source, code, trust: frontend.trustOf(card.id) });
    return ctx.json(200, { cardId: card.id, name: card.name, source: card.source, ...described });
  });

  router.delete('/api/characters/:id/frontend/trust', async (ctx) => {
    const card = await cards.get(ctx.params.id);
    if (!card) return ctx.fail(404, 'NOT_FOUND', `没有这张角色卡：${ctx.params.id}`);
    frontend.untrustCardFrontend(card.id);
    const code = extrasOf(card.data).frontend;
    const described = frontend.describeCardFrontend({ source: card.source, code, trust: null });
    return ctx.json(200, { cardId: card.id, name: card.name, source: card.source, ...described });
  });

  /**
   * 资源本地化：把卡内前端里的外链资源抓下来存进素材库，再把代码里的 URL 换成我们的地址。
   *
   * 为什么走 SSE：那张卡实测有 98 条外链、单张 1 MB、还有一张 15 秒才超时，
   * 全程可能一两分钟。用一个长 POST 干等，界面没法告诉用户"现在到第几张了"。
   */
  router.post('/api/characters/:id/frontend/localise', async (ctx) => {
    if (!assets) return ctx.fail(501, 'NOT_IMPLEMENTED', '这一版没有启用素材库');
    const card = await cards.get(ctx.params.id);
    if (!card) return ctx.fail(404, 'NOT_FOUND', `没有这张角色卡：${ctx.params.id}`);

    const code = extrasOf(card.data).frontend ?? { html: '', css: '', js: '', capabilities: [] };
    const allUrls = findExternalUrls(code.css, code.html, code.js);
    const urls = allUrls.slice(0, LOCALISE_LIMITS.maxFiles);
    const truncated = allUrls.length > urls.length;

    const sse = openSse(ctx);
    let downloaded = 0;
    let bytes = 0;
    const mapping = {};
    const failed = [];
    let finished = 0;

    try {
      sse.send('start', { total: urls.length, truncated, limits: LOCALISE_LIMITS });
      if (!urls.length) {
        sse.send('done', { total: 0, downloaded: 0, bytes: 0, failed: [], mapping: {}, saved: false, note: '这段代码里没有外链' });
        return;
      }

      await mapWithConcurrency(urls, LOCALISE_LIMITS.concurrency, async (url) => {
        try {
          if (bytes >= LOCALISE_LIMITS.maxTotalBytes) throw new Error('已经到总容量上限，后面的不抓了');
          let referer = '';
          try { referer = `${new URL(url).origin}/`; } catch { /* 不是标准 URL 就算了 */ }
          const response = await httpFetch(url, {
            signal: AbortSignal.timeout(LOCALISE_LIMITS.timeoutMs),
            redirect: 'follow',
            headers: {
              'User-Agent': 'SilverTavern/0.5 (+local card asset fetch)',
              ...(referer ? { Referer: referer } : {}),
            },
          });
          if (!response.ok) throw new Error(`对方返回 ${response.status}`);
          const buffer = Buffer.from(await response.arrayBuffer());
          if (!buffer.length) throw new Error('抓回来是空的');
          if (buffer.length > LOCALISE_LIMITS.maxFileBytes) {
            throw new Error(`${(buffer.length / 1048576).toFixed(1)}MB，超过单文件上限`);
          }
          if (bytes + buffer.length > LOCALISE_LIMITS.maxTotalBytes) throw new Error('加上这张就超过总容量上限');

          const mime = sniffMime({ buffer, url, contentType: response.headers.get('content-type') ?? '' });
          const asset = assets.save({
            buffer,
            kind: kindFromMime(mime),
            name: nameFromUrl(url),
            mime,
            meta: { sourceUrl: url, from: 'card-frontend-localise' },
          });
          mapping[url] = `/api/assets/${asset.id}/file`;
          downloaded++;
          bytes += buffer.length;
          sse.send('item', {
            url,
            ok: true,
            done: ++finished,
            total: urls.length,
            bytes: buffer.length,
            mime,
            assetId: asset.id,
          });
        } catch (err) {
          const reason = err?.message ?? String(err);
          failed.push({ url, reason });
          sse.send('item', { url, ok: false, reason, done: ++finished, total: urls.length });
        }
      });

      // 改代码 + 存回卡
      const next = {
        html: rewriteExternalUrls(code.html, mapping),
        css: rewriteExternalUrls(code.css, mapping),
        js: rewriteExternalUrls(code.js, mapping),
        capabilities: code.capabilities ?? [],
      };
      const described = frontend.describeCardFrontend({
        source: card.source,
        code: next,
        trust: frontend.trustOf(card.id),
      });
      // 导入的卡改完之后仍然过不了检查的话就不落库，免得把它存成一张打不开的卡
      const canSave = described.validation.ok || described.policy.tier === 'own';
      if (canSave) {
        const merged = mergeExtras(extrasOf(card.data), { frontend: described.code });
        await cards.update(card.id, { data: withExtras(card.data, merged), note: '把卡内前端的资源抓到本地' });
      }

      sse.send('done', {
        total: urls.length,
        downloaded,
        bytes,
        failed,
        mapping,
        saved: canSave,
        // 改了代码 = 信任的指纹对不上了。这是"信任绑代码"的设计使然，得让用户知道要再点一次。
        trustInvalidated: Boolean(frontend.trustOf(card.id)),
        note: canSave ? null : '抓完了，但改完的代码过不了静态检查，没有写回卡里',
      });
    } catch (err) {
      logger?.warn?.(`[frontend] 资源本地化失败：${err?.message ?? err}`);
      sse.send('error', { message: String(err?.message ?? err) });
    } finally {
      sse.close();
    }
  }, { bodyLimit: 1024 * 1024 });

  router.delete('/api/characters/:id', async (ctx) => {
    const card = await cards.get(ctx.params.id);
    if (!card) return ctx.fail(404, 'NOT_FOUND', `没有这张角色卡：${ctx.params.id}`);
    await cards.remove(ctx.params.id);
    return ctx.noContent();
  });

  // ---- 版本 ----
  router.get('/api/characters/:id/versions', async (ctx) => {
    if (!(await cards.get(ctx.params.id))) return ctx.fail(404, 'NOT_FOUND', `没有这张角色卡：${ctx.params.id}`);
    return ctx.json(200, await cards.listVersions(ctx.params.id));
  });

  router.post('/api/characters/:id/versions/:versionId/restore', async (ctx) => {
    const restored = await cards.restoreVersion(ctx.params.id, ctx.params.versionId);
    if (!restored) return ctx.fail(404, 'NOT_FOUND', `没有这张角色卡或版本：${ctx.params.id}`);
    return ctx.json(200, restored);
  });

  // ---- 头像 ----
  router.get('/api/characters/:id/avatar', async (ctx) => {
    const buffer = await cards.avatar(ctx.params.id);
    if (!buffer) return ctx.fail(404, 'NOT_FOUND', '这张卡没有头像');
    return ctx.text(200, buffer, 'image/png');
  });

  // ---- 导出（原始字节，前端用 fetch 直接存成文件）----
  router.get('/api/characters/:id/export', async (ctx) => {
    const format = ctx.query.format === 'png' ? 'png' : 'json';
    const spec = ctx.query.spec ?? null;
    const out = await cards.write(ctx.params.id, { format, spec });
    if (!out) return ctx.fail(404, 'NOT_FOUND', `没有这张角色卡：${ctx.params.id}`);
    ctx.res.writeHead(200, {
      'Content-Type': out.mime,
      'Content-Length': out.buffer.length,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(out.filename)}`,
    });
    ctx.res.end(out.buffer);
    return true;
  }, { bodyLimit: CARD_BODY_LIMIT });
}
