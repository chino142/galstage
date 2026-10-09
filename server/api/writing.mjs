/**
 * 写卡区其余模块的接口：世界书（已实现）、提示词 / X 光 / 记忆 / 向量 / 卡内前端 / 写卡工具。
 *
 * 已经实现的服务直接接上去；还没实现的用 stubs() 批量登记成 501。
 * 注册顺序注意：静态路径（/import、/meta、/convert）要排在 :id 之前。
 *
 * @param {import('../http/router.mjs').createRouter} router
 */

import { ValidationError } from '../../core/errors.mjs';
import { safeAutoBackup, stubs } from './_helpers.mjs';
import { listXray, getXray, removeXray, previousXray } from '../db/xray.mjs';
import { diffSnapshots } from '../../core/prompts/xray-diff.mjs';
import { MODULE_POSITIONS } from '../../core/prompts/module-css.mjs';

const WORLD_BODY_LIMIT = 16 * 1024 * 1024;

/** 世界书导入：原始 JSON 文本，或 JSON 里的 { files: [{name, text|dataBase64}] }。 */
async function readWorldbookFiles(ctx) {
  const raw = await ctx.readRawBody();
  const type = String(ctx.req.headers['content-type'] ?? '');
  const asText = (buffer) => buffer.toString('utf8').replace(/^\uFEFF/, '');
  if (type.includes('json')) {
    let payload;
    try {
      payload = JSON.parse(asText(raw));
    } catch {
      throw new ValidationError('请求体不是合法 JSON');
    }
    const incoming = Array.isArray(payload?.files)
      ? payload.files
      : payload?.text || payload?.dataBase64 || payload?.document
        ? [payload]
        : [];
    if (!incoming.length) {
      // 也可能整份 JSON 就是一份世界书文档
      if (payload?.entries) return [{ name: ctx.query.name ?? '未命名世界书', text: asText(raw) }];
      throw new ValidationError('没有收到任何世界书文件');
    }
    return incoming.map((file) => ({
      name: file.name ?? '未命名世界书',
      text: file.text ?? file.document ?? (file.dataBase64 ? Buffer.from(file.dataBase64, 'base64').toString('utf8') : null),
    }));
  }
  if (!raw.length) throw new ValidationError('请求体是空的');
  return [{ name: ctx.query.name ?? '未命名世界书', text: asText(raw) }];
}

/** 挑出"最老的、还没被总结过的"那一段消息。 */
function pickUncovered(messages = [], latestResult = { items: [] }, size = 20) {
  const latest = latestResult.items?.[0];
  let start = 0;
  if (latest?.coversTo) {
    const index = messages.findIndex((message) => message.id === latest.coversTo);
    if (index >= 0) start = index + 1;
  }
  return messages.slice(start, start + Math.max(1, size));
}

/** 给向量索引准备来源：世界书条目 / 记忆条目 / 历史对话。参考资料由调用方传入。 */
async function collectVectorSources(repo, engine, collection = null) {
  const wanted = (id) => !collection || collection === id;
  const out = [];
  if (wanted('worldbook')) {
    const books = await engine.services.worldbook.list({});
    for (const book of books.items) {
      const entries = await engine.services.worldbook.entries(book.id);
      for (const entry of entries.items) {
        const content = `${entry.comment ? `${entry.comment}\n` : ''}${entry.content ?? ''}`.trim();
        if (content) out.push({ collection: 'worldbook', sourceId: `${book.id}:${entry.uid}`, content, meta: { title: entry.comment || book.name || '世界书', timestamp: entry.updatedAt ?? book.updatedAt ?? null } });
      }
    }
  }
  if (wanted('memory')) {
    for (const row of repo.all('SELECT id, title, content FROM memories')) {
      const content = `${row.title ? `${row.title}\n` : ''}${row.content ?? ''}`.trim();
      if (content) out.push({ collection: 'memory', sourceId: row.id, content, meta: { title: row.title ?? '记忆', timestamp: row.updated_at ?? row.created_at ?? null } });
    }
  }
  if (wanted('databank')) {
    // 参考资料：原文在 reference_docs，向量只是它的衍生物，所以这里能完整重建。
    for (const row of repo.all('SELECT id, title, content, updated_at FROM reference_docs ORDER BY updated_at DESC')) {
      if (row.content) out.push({ collection: 'databank', sourceId: row.id, content: row.content, meta: { title: row.title ?? '参考资料', timestamp: row.updated_at ?? null } });
    }
  }
  if (wanted('history')) {
    for (const row of repo.all("SELECT id, content FROM chat_messages WHERE content != '' ORDER BY created_at DESC LIMIT 2000")) {
      if (row.content) out.push({ collection: 'history', sourceId: row.id, content: row.content, meta: { timestamp: row.created_at ?? null, title: '历史对话' } });
    }
  }
  return out;
}

export function register(router, { engine, repo, chatStore, logger, referenceStore }) {
  const { worldbook, prompts, memory, vectors, frontend } = engine.services;

  // ---- 世界书：元数据与导入转换（静态路径在先）----
  router.get('/api/worldbooks/meta', (ctx) =>
    ctx.json(200, {
      positions: worldbook.positions(),
      logics: worldbook.logics(),
      matchSources: worldbook.matchSources(),
      shapes: worldbook.shapes(),
    }),
  );

  router.post('/api/worldbooks/import', async (ctx) => {
    const files = await readWorldbookFiles(ctx);
    const characterId = ctx.query.characterId ?? null;
    if (files.length > 1) safeAutoBackup({ engine, logger, reason: '批量导入世界书前', kind: 'pre-import' });
    return ctx.json(201, await worldbook.importFiles(files, { characterId, source: ctx.query.source ?? 'imported' }));
  }, { bodyLimit: WORLD_BODY_LIMIT });

  router.post('/api/worldbooks/convert', async (ctx) => {
    const payload = (await ctx.body()) ?? {};
    const shape = payload.shape ?? 'tavern';
    const doc = payload.document ?? payload.data ?? payload;
    return ctx.json(200, await worldbook.convertShape(doc, shape));
  }, { bodyLimit: WORLD_BODY_LIMIT });

  // ---- 世界书：本体 ----
  router.get('/api/worldbooks', async (ctx) =>
    ctx.json(200, await worldbook.list({ q: ctx.query.q ?? '', characterId: ctx.query.characterId ?? undefined })),
  );
  router.post('/api/worldbooks', async (ctx) => ctx.json(201, await worldbook.save((await ctx.body()) ?? {})), { bodyLimit: WORLD_BODY_LIMIT });

  router.get('/api/worldbooks/:id', async (ctx) => {
    const book = await worldbook.get(ctx.params.id);
    if (!book) return ctx.fail(404, 'NOT_FOUND', `没有这个世界书：${ctx.params.id}`);
    return ctx.json(200, book);
  });
  router.put('/api/worldbooks/:id', async (ctx) => {
    const saved = await worldbook.save({ ...((await ctx.body()) ?? {}), id: ctx.params.id });
    if (!saved) return ctx.fail(404, 'NOT_FOUND', `没有这个世界书：${ctx.params.id}`);
    return ctx.json(200, saved);
  }, { bodyLimit: WORLD_BODY_LIMIT });
  router.delete('/api/worldbooks/:id', async (ctx) => {
    if (!(await worldbook.get(ctx.params.id))) return ctx.fail(404, 'NOT_FOUND', `没有这个世界书：${ctx.params.id}`);
    await worldbook.remove(ctx.params.id);
    return ctx.noContent();
  });

  // ---- 世界书：条目 ----
  router.get('/api/worldbooks/:id/entries', async (ctx) => {
    if (!(await worldbook.get(ctx.params.id))) return ctx.fail(404, 'NOT_FOUND', `没有这个世界书：${ctx.params.id}`);
    return ctx.json(200, await worldbook.entries(ctx.params.id));
  });
  router.post('/api/worldbooks/:id/entries', async (ctx) => {
    const entry = await worldbook.saveEntry(ctx.params.id, (await ctx.body()) ?? {});
    return ctx.json(201, entry);
  }, { bodyLimit: WORLD_BODY_LIMIT });
  router.put('/api/worldbooks/:id/entries/:entryId', async (ctx) => {
    const body = (await ctx.body()) ?? {};
    const entry = await worldbook.saveEntry(ctx.params.id, { ...body, uid: body.uid ?? ctx.params.entryId });
    if (!entry) return ctx.fail(404, 'NOT_FOUND', `没有这个条目：${ctx.params.entryId}`);
    return ctx.json(200, entry);
  }, { bodyLimit: WORLD_BODY_LIMIT });
  router.delete('/api/worldbooks/:id/entries/:entryId', async (ctx) => {
    await worldbook.removeEntry(ctx.params.id, ctx.params.entryId);
    return ctx.noContent();
  });

  // ---- 世界书：触发 ----
  router.post('/api/worldbooks/:id/test-trigger', async (ctx) =>
    ctx.json(200, await worldbook.testTrigger(ctx.params.id, (await ctx.body()) ?? {})),
  );

  router.get('/api/worldbooks/:id/export', async (ctx) => {
    const out = await worldbook.exportFile(ctx.params.id, { shape: ctx.query.shape ?? null });
    if (!out) return ctx.fail(404, 'NOT_FOUND', `没有这个世界书：${ctx.params.id}`);
    ctx.res.writeHead(200, {
      'Content-Type': out.mime,
      'Content-Length': out.buffer.length,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(out.filename)}`,
    });
    ctx.res.end(out.buffer);
    return true;
  });

  router.post('/api/worldbooks/:id/convert', async (ctx) => {
    const payload = (await ctx.body()) ?? {};
    const shape = payload.shape ?? 'card';
    const source = payload.document ?? payload.data ?? null;
    if (source) return ctx.json(200, await worldbook.convertShape(source, shape));
    const book = await worldbook.get(ctx.params.id);
    if (!book) return ctx.fail(404, 'NOT_FOUND', `没有这个世界书：${ctx.params.id}`);
    const out = await worldbook.exportFile(ctx.params.id, { shape });
    return ctx.json(200, { shape, sourceShape: book.spec, document: JSON.parse(out.buffer.toString('utf8')) });
  }, { bodyLimit: WORLD_BODY_LIMIT });

  // ---- 提示词 ----
  router.get('/api/prompts/stages', (ctx) => ctx.json(200, { items: prompts.stages() }));
  router.get('/api/prompts/meta', (ctx) =>
    ctx.json(200, { stages: prompts.stages(), placements: prompts.placements(), substituteModes: prompts.substituteModes() }),
  );
  router.post('/api/prompts/render', async (ctx) => ctx.json(200, await prompts.render((await ctx.body()) ?? {})));
  router.post('/api/prompts/preview', async (ctx) => ctx.json(200, await prompts.preview((await ctx.body()) ?? {})));

  // 预设
  router.get('/api/prompts/presets', async (ctx) => ctx.json(200, await prompts.listPresets(ctx.query)));
  router.post('/api/prompts/presets', async (ctx) => ctx.json(201, await prompts.savePreset((await ctx.body()) ?? {})));
  router.post('/api/prompts/presets/import', async (ctx) => {
    const payload = (await ctx.body()) ?? {};
    const doc = payload.document ?? payload.data ?? payload;
    return ctx.json(201, await prompts.importPreset(doc, { name: payload.name ?? null, source: payload.source ?? 'imported' }));
  }, { bodyLimit: 16 * 1024 * 1024 });
  router.get('/api/prompts/presets/:id', async (ctx) => {
    const preset = await prompts.getPreset(ctx.params.id);
    if (!preset) return ctx.fail(404, 'NOT_FOUND', `没有这个预设：${ctx.params.id}`);
    return ctx.json(200, preset);
  });
  router.put('/api/prompts/presets/:id', async (ctx) => {
    const saved = await prompts.savePreset({ ...((await ctx.body()) ?? {}), id: ctx.params.id });
    if (!saved) return ctx.fail(404, 'NOT_FOUND', `没有这个预设：${ctx.params.id}`);
    return ctx.json(200, saved);
  });
  router.delete('/api/prompts/presets/:id', async (ctx) => {
    if (!(await prompts.getPreset(ctx.params.id))) return ctx.fail(404, 'NOT_FOUND', `没有这个预设：${ctx.params.id}`);
    await prompts.removePreset(ctx.params.id);
    return ctx.noContent();
  });
  router.get('/api/prompts/presets/:id/export', async (ctx) => {
    const out = await prompts.exportPreset(ctx.params.id);
    if (!out) return ctx.fail(404, 'NOT_FOUND', `没有这个预设：${ctx.params.id}`);
    ctx.res.writeHead(200, {
      'Content-Type': out.mime,
      'Content-Length': out.buffer.length,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(out.filename)}`,
    });
    ctx.res.end(out.buffer);
    return true;
  });

  // 宏
  router.get('/api/prompts/macros', async (ctx) => {
    const macros = await prompts.listMacros();
    return ctx.json(200, { macros, items: Object.entries(macros).map(([name, value]) => ({ name, value })) });
  });
  router.post('/api/prompts/macros', async (ctx) => {
    const payload = (await ctx.body()) ?? {};
    return ctx.json(200, await prompts.saveMacro(payload.name, payload.value));
  });
  router.delete('/api/prompts/macros/:name', async (ctx) => {
    await prompts.removeMacro(ctx.params.name);
    return ctx.noContent();
  });

  // 正则脚本
  router.get('/api/prompts/regex', async (ctx) => ctx.json(200, await prompts.listRegex(ctx.query)));
  router.post('/api/prompts/regex', async (ctx) => ctx.json(201, await prompts.saveRegex((await ctx.body()) ?? {})));
  router.put('/api/prompts/regex/:id', async (ctx) => ctx.json(200, await prompts.saveRegex({ ...((await ctx.body()) ?? {}), id: ctx.params.id })));
  router.delete('/api/prompts/regex/:id', async (ctx) => {
    await prompts.removeRegex(ctx.params.id);
    return ctx.noContent();
  });

  // 模块（Mod）：说明 + 提示词 + 可选 CSS / HTML / JS。
  // 老路径保留（/prompts/snippets），名字换成"模块"是为了对齐那套玩法的叫法。
  router.get('/api/prompts/snippets', async (ctx) => ctx.json(200, await prompts.listModules(ctx.query)));
  router.get('/api/prompts/module-positions', (ctx) => ctx.json(200, { items: MODULE_POSITIONS }));
  router.post('/api/prompts/snippets', async (ctx) => ctx.json(201, await prompts.saveModule((await ctx.body()) ?? {})));
  router.put('/api/prompts/snippets/:id', async (ctx) =>
    ctx.json(200, await prompts.saveModule({ ...((await ctx.body()) ?? {}), id: ctx.params.id })),
  );
  router.post('/api/prompts/snippets/:id/trust', async (ctx) => ctx.json(200, await prompts.trustModule(ctx.params.id)));
  router.delete('/api/prompts/snippets/:id/trust', async (ctx) => ctx.json(200, await prompts.untrustModule(ctx.params.id)));
  router.get('/api/prompts/snippets/:id', async (ctx) => {
    const found = await prompts.getModule(ctx.params.id);
    if (!found) return ctx.fail(404, 'NOT_FOUND', `没有这个模块：${ctx.params.id}`);
    return ctx.json(200, found);
  });
  // 导出：一个自包含的 JSON（七样零件都在），别人拿去「导入模块」就能用
  router.get('/api/prompts/snippets/:id/export', async (ctx) => {
    const doc = await prompts.exportModule(ctx.params.id);
    ctx.res.setHeader('Content-Disposition', `attachment; filename="module.json"`);
    return ctx.json(200, doc);
  });
  // 导入：默认按"别人的模块"存（样式收进消息区、脚本要信任才跑、正则不跑）
  router.post('/api/prompts/snippets/import', async (ctx) => {
    const body = (await ctx.body()) ?? {};
    const doc = body.document ?? body;
    return ctx.json(201, await prompts.importModule(doc, { source: ctx.query.source === 'original' ? 'original' : 'imported' }));
  });
  // 「存为模块」：把当前对话的对话级配置（提示词 / 前置词 / 后置词）存成一个能挂到别处的模块
  router.post('/api/prompts/snippets/from-chat', async (ctx) => {
    const body = (await ctx.body()) ?? {};
    const chatId = String(body.chatId ?? '');
    if (!chatId) throw new ValidationError('要指定是哪个对话（chatId）');
    const chatRow = await engine.services.chat.get(chatId);
    if (!chatRow) return ctx.fail(404, 'NOT_FOUND', `没有这个对话：${chatId}`);
    const settings = chatRow.settings ?? {};
    return ctx.json(201, await prompts.moduleFromText({
      title: body.title ?? `${chatRow.title} 的配置`,
      description: body.description ?? '',
      systemPrompt: settings.cardSystemPrompt ?? '',
      prefix: settings.prefixText ?? '',
      suffix: settings.suffixText ?? '',
      source: 'original',
    }));
  });
  router.delete('/api/prompts/snippets/:id', async (ctx) => {
    await prompts.removeModule(ctx.params.id);
    return ctx.noContent();
  });

  // ---- 提示词 X 光机：玩卡区每轮生成时写入，这里读 ----
  router.get('/api/xray', (ctx) =>
    ctx.json(200, {
      items: listXray(repo, {
        chatId: ctx.query.chatId ?? null,
        limit: ctx.query.limit ?? 50,
        includeText: ctx.query.text === 'true',
      }),
    }),
  );
  router.get('/api/xray/:id', (ctx) => {
    const snapshot = getXray(repo, ctx.params.id);
    if (!snapshot) return ctx.fail(404, 'NOT_FOUND', `没有这份提示词快照：${ctx.params.id}`);
    return ctx.json(200, snapshot);
  });
  /** 跟上一轮比：出问题时定位"从第几轮开始跑偏"。 */
  router.get('/api/xray/:id/diff', (ctx) => {
    const snapshot = getXray(repo, ctx.params.id);
    if (!snapshot) return ctx.fail(404, 'NOT_FOUND', `没有这份提示词快照：${ctx.params.id}`);
    const previous = previousXray(repo, snapshot);
    if (!previous) return ctx.json(200, { previous: null, diff: null, note: '这是这个对话的第一份快照，没有可比的上一轮' });
    return ctx.json(200, { previous: { id: previous.id, createdAt: previous.createdAt }, diff: diffSnapshots(previous, snapshot) });
  });
  router.delete('/api/xray/:id', (ctx) => {
    removeXray(repo, ctx.params.id);
    return ctx.noContent();
  });

  // ---- 记忆 ----
  router.get('/api/memory/layers', (ctx) => ctx.json(200, { items: memory.layers() }));
  router.get('/api/memory', async (ctx) => ctx.json(200, await memory.list(ctx.query)));
  router.get('/api/memory/timeline', async (ctx) => ctx.json(200, await memory.timeline(ctx.query)));
  router.get('/api/memory/profiles', async (ctx) => ctx.json(200, await memory.listProfiles(ctx.query)));

  router.post('/api/memory/summarize/small', async (ctx) => {
    const payload = (await ctx.body()) ?? {};
    let messages = payload.messages ?? null;
    if (!messages) {
      if (!payload.chatId || !chatStore) throw new ValidationError('要么给 chatId，要么直接把要总结的 messages 传进来');
      messages = pickUncovered(chatStore.listMessages(payload.chatId), await memory.list({ chatId: payload.chatId, layer: 'small', limit: 1 }), Number(payload.size) || 20);
    }
    return ctx.json(201, await memory.summarizeSmall({ ...payload, messages }));
  });
  router.post('/api/memory/summarize/large', async (ctx) => ctx.json(201, await memory.summarizeLarge((await ctx.body()) ?? {})));
  router.post('/api/memory/rebuild', async (ctx) => ctx.json(200, await memory.rebuild((await ctx.body()) ?? {})));
  router.put('/api/memory/:id', async (ctx) => {
    const updated = await memory.update(ctx.params.id, (await ctx.body()) ?? {});
    if (!updated) return ctx.fail(404, 'NOT_FOUND', `没有这条记忆：${ctx.params.id}`);
    return ctx.json(200, updated);
  });
  router.delete('/api/memory/:id', async (ctx) => {
    await memory.remove(ctx.params.id);
    return ctx.noContent();
  });

  // ---- 向量 ----
  router.get('/api/vectors/collections', (ctx) => ctx.json(200, { items: vectors.collections() }));
  router.get('/api/vectors/stats', async (ctx) => ctx.json(200, await vectors.stats()));
  router.post('/api/vectors/search', async (ctx) => ctx.json(200, { items: await vectors.search((await ctx.body()) ?? {}) }));
  router.post('/api/vectors/index-source', async (ctx) => ctx.json(201, await vectors.indexSource((await ctx.body()) ?? {})), { bodyLimit: 16 * 1024 * 1024 });
  router.post('/api/vectors/reindex', async (ctx) => {
    const payload = (await ctx.body()) ?? {};
    const sources = [
      ...(await collectVectorSources(repo, engine, payload.collection ?? null)),
      ...(Array.isArray(payload.sources) ? payload.sources : []),
    ];
    return ctx.json(200, await vectors.reindex({ ...payload, sources }));
  }, { bodyLimit: 16 * 1024 * 1024 });
  router.delete('/api/vectors/source/:sourceId', async (ctx) => {
    const collection = ctx.query.collection ?? 'databank';
    const removed = await vectors.removeBySource(collection, ctx.params.sourceId);
    return ctx.json(200, { removed });
  });
  router.post('/api/vectors/clear', async (ctx) => {
    safeAutoBackup({ engine, logger, reason: '清空向量索引前', kind: 'pre-delete' });
    return ctx.json(200, await vectors.clear((await ctx.body()) ?? {}));
  });
  router.post('/api/vectors/test-embedding', async (ctx) => ctx.json(200, await vectors.testEmbedding((await ctx.body()) ?? {})));

  // ---- 参考资料：原文入库 + 自动切片建索引 ----
  // 以前 databank 只是个"向量集合"，片段只活在向量表里，等于没有源：重建就把资料清没了。
  // 现在原文进 reference_docs，向量是衍生物，随时能重建。
  const DATABANK_BODY_LIMIT = 8 * 1024 * 1024;

  async function indexDoc(doc) {
    return vectors.indexSource({
      collection: 'databank',
      sourceId: doc.id,
      content: doc.content,
      meta: { title: doc.title, timestamp: doc.updatedAt ?? null },
    });
  }

  router.get('/api/databank', (ctx) => {
    return ctx.json(200, referenceStore.list({ limit: Number(ctx.query.limit) || 200 }));
  });

  router.get('/api/databank/:id', (ctx) => {
    const doc = referenceStore.get(ctx.params.id);
    if (!doc) return ctx.fail(404, 'NOT_FOUND', `没有这份参考资料：${ctx.params.id}`);
    return ctx.json(200, doc);
  });

  router.post(
    '/api/databank',
    async (ctx) => {
      const payload = (await ctx.body()) ?? {};
      const doc = referenceStore.insert({
        title: payload.title,
        source: payload.source ?? 'pasted',
        content: payload.content,
        tags: payload.tags,
      });
      let index = null;
      let indexError = null;
      try {
        index = await indexDoc(doc);
      } catch (err) {
        indexError = err?.message ?? String(err);
      }
      return ctx.json(201, { doc: { ...doc, content: undefined }, index, indexError });
    },
    { bodyLimit: DATABANK_BODY_LIMIT },
  );

  router.put(
    '/api/databank/:id',
    async (ctx) => {
      const payload = (await ctx.body()) ?? {};
      const doc = referenceStore.update(ctx.params.id, payload);
      let index = null;
      let indexError = null;
      if (payload.content !== undefined || payload.title !== undefined) {
        try {
          index = await indexDoc(doc);
        } catch (err) {
          indexError = err?.message ?? String(err);
        }
      }
      return ctx.json(200, { doc: { ...doc, content: undefined }, index, indexError });
    },
    { bodyLimit: DATABANK_BODY_LIMIT },
  );

  router.post('/api/databank/:id/reindex', async (ctx) => {
    const doc = referenceStore.get(ctx.params.id);
    if (!doc) return ctx.fail(404, 'NOT_FOUND', `没有这份参考资料：${ctx.params.id}`);
    return ctx.json(200, await indexDoc(doc));
  });

  router.delete('/api/databank/:id', async (ctx) => {
    const doc = referenceStore.get(ctx.params.id);
    if (!doc) return ctx.fail(404, 'NOT_FOUND', `没有这份参考资料：${ctx.params.id}`);
    const removed = await vectors.removeBySource('databank', doc.id);
    referenceStore.remove(doc.id);
    return ctx.json(200, { removed });
  });

  // ---- 外部向量库（Qdrant）：看状态、手动同步一次 ----
  router.get('/api/vectors/backend', async (ctx) => ctx.json(200, await vectors.backendStatus()));
  router.post('/api/vectors/sync-backend', async (ctx) => ctx.json(200, await vectors.syncToBackend((await ctx.body()) ?? {})));

  // ---- 卡内前端与外观 ----
  router.get('/api/frontend/capabilities', (ctx) => ctx.json(200, { items: frontend.capabilities() }));
  router.get('/api/frontend/policy', (ctx) => ctx.json(200, frontend.policy()));
  router.post('/api/frontend/validate', async (ctx) => ctx.json(200, await frontend.validateSnippet((await ctx.body()) ?? {})));
  /**
   * 渲染沙箱。带 `characterId` 时按**那张卡的来源与信任记录**决定要不要跳过静态检查 ——
   * 也就是说"自己的卡能跑任何代码"这件事由服务端判定，前端自己说了不算。
   */
  router.post(
    '/api/frontend/render',
    async (ctx) => {
      const body = (await ctx.body()) ?? {};
      let policy = null;
      if (body.characterId) {
        const card = await engine.services.cards.get(body.characterId);
        if (!card) return ctx.fail(404, 'NOT_FOUND', `没有这张角色卡：${body.characterId}`);
        policy = frontend.describeCardFrontend({
          source: card.source,
          code: { html: body.html, css: body.css, js: body.js, capabilities: body.capabilities },
          trust: frontend.trustOf(card.id),
        }).policy;
      }
      return ctx.json(200, await frontend.renderSandbox(body, { policy }));
    },
    { bodyLimit: 2 * 1024 * 1024 },
  );
  router.get('/api/frontend/theme-tokens', (ctx) => ctx.json(200, { items: frontend.themeTokens() }));
  router.get('/api/frontend/themes', async (ctx) => ctx.json(200, await frontend.listThemes()));
  router.post('/api/frontend/themes', async (ctx) => ctx.json(201, await frontend.saveTheme((await ctx.body()) ?? {})));
  router.put('/api/frontend/themes/:id', async (ctx) => ctx.json(200, await frontend.saveTheme({ ...((await ctx.body()) ?? {}), id: ctx.params.id })));
  router.delete('/api/frontend/themes/:id', async (ctx) => {
    if (!(await frontend.removeTheme(ctx.params.id))) return ctx.fail(404, 'NOT_FOUND', `没有这个主题：${ctx.params.id}`);
    return ctx.noContent();
  });

  router.get('/api/frontend/snippets', async (ctx) => ctx.json(200, await frontend.listSnippets({ scope: ctx.query.scope ?? null })));
  router.post('/api/frontend/snippets', async (ctx) => ctx.json(201, await frontend.saveSnippet((await ctx.body()) ?? {})));
  router.put('/api/frontend/snippets/:id', async (ctx) => ctx.json(200, await frontend.saveSnippet({ ...((await ctx.body()) ?? {}), id: ctx.params.id })));
  router.delete('/api/frontend/snippets/:id', async (ctx) => {
    if (!(await frontend.removeSnippet(ctx.params.id))) return ctx.fail(404, 'NOT_FOUND', `没有这个片段：${ctx.params.id}`);
    return ctx.noContent();
  });

  stubs(router, [
    ['POST', '/api/frontend/preview', '渲染卡内前端沙箱'],
    ['POST', '/api/frontend/validate', '校验卡内前端代码'],
  ]);

  // ---- 写卡工具链 ----
  stubs(router, [
    ['POST', '/api/card-tools/generate', '用模型生成角色卡'],
    ['POST', '/api/card-tools/chat-edit', '对话式改卡'],
    ['POST', '/api/card-tools/inspect', '角色卡体检'],
    ['POST', '/api/card-tools/translate', '翻译角色卡与世界书'],
    ['POST', '/api/card-tools/scrape', '从网页抓料生成设定'],
  ]);
}
