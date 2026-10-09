/**
 * 玩卡区接口。
 *
 * 路由顺序有讲究：静态段必须排在 `:id` 之前（路由器是先注册先匹配），
 * 否则 `/api/group/strategies` 会被当成 chatId = "strategies"。
 *
 * 生成类接口走 SSE，事件名与 core/chat/service.mjs 的 STREAM_EVENT_TYPES 一致；
 * 其余是普通 JSON。演出层 / 语音 / 图片按需求只留接口（501），不硬做。
 */

import { openSse } from '../http/sse.mjs';
import { safeAutoBackup, stubs } from './_helpers.mjs';
import { ValidationError, NotFoundError } from '../../core/errors.mjs';

export function register(router, { engine, logger }) {
  const { chat, group, state, narration } = engine.services;

  /**
   * 允许界面只传 characterId（从卡库选一张卡开演），这里把卡数据补上。
   * 卡数据是**快照**，存进 chat_members.card；characterId 指向卡库，将来换卡不回改旧对话。
   */
  async function resolveCharacterCards(payload = {}) {
    const out = { ...(payload ?? {}) };
    const loadCard = async (id) => {
      const card = await engine.services.cards.get(id);
      if (!card) throw new NotFoundError(`角色卡 ${id}`);
      return card;
    };
    if (out.characterId && !out.character) {
      const card = await loadCard(out.characterId);
      out.character = card.data;
      out.title = out.title ?? `${card.name} 的对话`;
    }
    if (Array.isArray(out.members)) {
      out.members = await Promise.all(
        out.members.map(async (member) => {
          if (!member?.characterId || member.card) return member;
          const card = await loadCard(member.characterId);
          return { ...member, card: card.data, name: member.name ?? card.name };
        }),
      );
    }
    return out;
  }

  async function resolveMemberCard(payload = {}) {
    const out = { ...(payload ?? {}) };
    if (out.characterId && !out.card) {
      const card = await engine.services.cards.get(out.characterId);
      if (!card) throw new NotFoundError(`角色卡 ${out.characterId}`);
      out.card = card.data;
      out.name = out.name ?? card.name;
    }
    return out;
  }

  function streamTurn(ctx, run) {
    const sse = openSse(ctx);
    return (async () => {
      try {
        for await (const event of run()) {
          sse.send(event.type, event);
          if (event.type === 'error') break;
        }
      } catch (err) {
        sse.send('error', { code: err?.code ?? 'INTERNAL_ERROR', message: String(err?.message ?? err) });
      }
      sse.close();
      return true;
    })();
  }

  // ---------------------------------------------------------------- 对话
  router.get('/api/chats/stream-protocol', (ctx) => ctx.json(200, { items: chat.streamEventTypes() }));
  router.get('/api/chats', async (ctx) => ctx.json(200, await chat.list(ctx.query)));

  router.post('/api/chats', async (ctx) => ctx.json(201, await chat.create(await resolveCharacterCards((await ctx.body()) ?? {}))));

  // 导入支持两种送法：
  //   1) 直接把文件内容当请求体发过来（curl / 拖拽导入的原始字节路径）；
  //   2) JSON 包一层 `{ text, title }` —— 界面上的"导入 JSONL"就是这么发的。
  // 两种都得认，否则界面那条路径会把自己的 JSON 当成对话文件去解析。
  router.post('/api/chats/import', async (ctx) => {
    const contentType = String(ctx.req.headers['content-type'] ?? '');
    // 注意别用 includes('json')：application/x-ndjson 也含这三个字母，
    // 那样会把原始 JSONL 当 JSON 去解析（这正是这次修掉的那个 bug 的另一面）。
    const isJson = /application\/json|application\/[a-z0-9.+-]*\+json/i.test(contentType);
    if (isJson) {
      const body = (await ctx.body()) ?? {};
      if (typeof body.text !== 'string' || !body.text.trim()) {
        throw new ValidationError('导入需要 text 字段（对话文件的完整内容）');
      }
      safeAutoBackup({ engine, logger, reason: '导入对话存档前', kind: 'pre-import' });
      return ctx.json(201, await chat.importChat({ text: body.text, title: body.title }));
    }
    const raw = await ctx.readRawBody();
    const text = raw.toString('utf8');
    const body = ctx.query.title ? { text, title: ctx.query.title } : { text };
    safeAutoBackup({ engine, logger, reason: '导入对话存档前', kind: 'pre-import' });
    return ctx.json(201, await chat.importChat(body));
  }, { bodyLimit: 64 * 1024 * 1024 });

  router.get('/api/search', async (ctx) => ctx.json(200, await chat.search(ctx.query)));

  router.get('/api/chats/:id', async (ctx) => {
    const item = await chat.get(ctx.params.id);
    if (!item) return ctx.fail(404, 'NOT_FOUND', `没有这个对话：${ctx.params.id}`);
    return ctx.json(200, item);
  });

  router.put('/api/chats/:id', async (ctx) => ctx.json(200, await chat.update(ctx.params.id, (await ctx.body()) ?? {})));

  /**
   * 这个对话挂了哪些模块（Mod）。
   * 返回三样东西：挂着的清单、能挂的全部、以及**给前端直接用的样式与沙箱面板**。
   *
   * 样式分两档（见 core/prompts/module-css.mjs）：自己写的能改整个聊天页，
   * 别人的会被自动收进消息区并禁掉 @import / 外链 / position:fixed。
   * 带 HTML/JS 的模块不给样式，而是给一块沙箱 iframe 的 srcdoc——脚本永远不进主页面。
   */
  router.get('/api/chats/:id/modules', async (ctx) => {
    const chatRow = await chat.get(ctx.params.id);
    if (!chatRow) return ctx.fail(404, 'NOT_FOUND', `没有这个对话：${ctx.params.id}`);
    const attachedIds = Array.isArray(chatRow.settings?.modules) ? chatRow.settings.modules.map(String) : [];
    const all = (await engine.services.prompts.listModules({})).items;
    const plan = await engine.services.prompts.planFor(attachedIds);
    // renderSandbox 是 async 的，必须 await——不然 JSON 序列化出来的是个空对象
    const panels = await Promise.all(plan.panels.map(async (panel) => ({
      id: panel.id,
      title: panel.title,
      trusted: panel.tier.trusted,
      needsTrust: panel.tier.needsTrust,
      render: await engine.services.frontend.renderSandbox(
        { html: panel.html, css: panel.css, js: panel.js, capabilities: panel.capabilities },
        { policy: { skipLint: panel.tier.trusted, allowExternalAssets: panel.tier.trusted } },
      ),
    })));
    return ctx.json(200, {
      attachedIds,
      attached: plan.items,
      available: all.map((item) => ({
        id: item.id,
        title: item.title,
        description: item.description,
        position: item.position,
        source: item.source,
        hasPanel: Boolean(item.html || item.js),
      })),
      css: plan.pageCss,
      panels,
      // 背景图：挂在对话上的模块里带了就用最后那个（notice 在 notes 里说清楚了）
      background: plan.backgrounds?.at(-1)?.assetId ?? null,
      notes: plan.notes,
    });
  });

  router.put('/api/chats/:id/modules', async (ctx) => {
    const body = (await ctx.body()) ?? {};
    const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
    const chatRow = await chat.get(ctx.params.id);
    if (!chatRow) return ctx.fail(404, 'NOT_FOUND', `没有这个对话：${ctx.params.id}`);
    const existing = await engine.services.prompts.listModules({});
    const known = new Set(existing.items.map((item) => item.id));
    const unknown = ids.filter((id) => !known.has(id));
    if (unknown.length) throw new ValidationError(`这些模块不存在：${unknown.join('、')}`);
    await chat.update(ctx.params.id, { settings: { ...(chatRow.settings ?? {}), modules: ids } });
    return ctx.json(200, { attachedIds: ids });
  });

  router.delete('/api/chats/:id', async (ctx) => {
    // 删一个对话等于一次删掉它下面所有消息（外键级联），先留一份。
    safeAutoBackup({ engine, logger, reason: '删除对话前', kind: 'pre-delete' });
    await chat.remove(ctx.params.id);
    return ctx.noContent();
  });

  router.get('/api/chats/:id/messages', async (ctx) => ctx.json(200, await chat.messages(ctx.params.id, ctx.query)));
  router.post('/api/chats/:id/messages', async (ctx) => ctx.json(201, await chat.insertMessage(ctx.params.id, (await ctx.body()) ?? {})));
  router.put('/api/chats/:id/messages/:messageId', async (ctx) =>
    ctx.json(200, await chat.editMessage(ctx.params.id, ctx.params.messageId, (await ctx.body()) ?? {})),
  );
  router.delete('/api/chats/:id/messages/:messageId', async (ctx) => {
    await chat.deleteMessage(ctx.params.id, ctx.params.messageId);
    return ctx.noContent();
  });

  /**
   * 往消息上挂素材：`{ assetIds: [] }` 合并进这条消息的 `extra.images`（去重）。
   * ComfyUI 浏览器直连模式下，前端把图上传到自己的素材库后走这一条绑回消息；
   * 服务端 runner 走的是内部端口，两条路写的是同一个字段。
   */
  router.post('/api/chats/:id/messages/:messageId/attachments', async (ctx) => {
    const body = (await ctx.body()) ?? {};
    const assetIds = Array.isArray(body.assetIds) ? body.assetIds : body.assetId ? [body.assetId] : [];
    if (!assetIds.length) return ctx.fail(400, 'VALIDATION_ERROR', '要带上 assetIds（数组）');
    return ctx.json(200, await chat.attachAssets(ctx.params.id, ctx.params.messageId, assetIds));
  });

  router.get('/api/chats/:id/plan', async (ctx) => ctx.json(200, await chat.plan(ctx.params.id, ctx.query)));

  for (const [path, method] of [
    ['send', 'send'],
    ['regenerate', 'regenerate'],
    ['continue', 'continueTurn'],
    ['swipe', 'newSwipe'],
  ]) {
    router.post(`/api/chats/:id/${path}`, async (ctx) => {
      const exists = await chat.get(ctx.params.id);
      if (!exists) return ctx.fail(404, 'NOT_FOUND', `没有这个对话：${ctx.params.id}`);
      // 同一对话只允许一条生成在跑：两个标签页 / MCP 同时发，会把转录顺序搅乱。
      // 在开 SSE 之前挡下来，客户端才能拿到正常的 409，而不是 200 里塞个 error 事件。
      if (typeof chat.isGenerating === 'function' && chat.isGenerating(ctx.params.id)) {
        return ctx.fail(409, 'CONFLICT', '这个对话正在生成中：等这一轮结束，或者先停掉再试');
      }
      const body = (await ctx.body()) ?? {};
      return streamTurn(ctx, () => chat[method](ctx.params.id, body));
    });
  }

  /** 在候选回复（swipes）之间翻。body: { index } 或 { delta: 1/-1 }。 */
  router.put('/api/chats/:id/messages/:messageId/swipe', async (ctx) =>
    ctx.json(200, await chat.switchSwipe(ctx.params.id, ctx.params.messageId, (await ctx.body()) ?? {})),
  );

  router.post('/api/chats/:id/impersonate', async (ctx) => ctx.json(200, await chat.impersonate(ctx.params.id, (await ctx.body()) ?? {})));
  router.post('/api/chats/:id/branch', async (ctx) => ctx.json(201, await chat.branch(ctx.params.id, (await ctx.body()) ?? {})));

  router.get('/api/chats/:id/export', async (ctx) => {
    const out = await chat.exportChat(ctx.params.id, { format: ctx.query.format ?? 'jsonl' });
    ctx.res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(out.name)}`);
    return ctx.text(200, out.text, out.mime);
  });

  // ---------------------------------------------------------------- 群聊
  router.get('/api/group/strategies', (ctx) => ctx.json(200, { items: group.strategies(), modes: group.modes() }));
  router.get('/api/group', async (ctx) => ctx.json(200, await group.list()));
  router.put('/api/group/members/:memberId', async (ctx) => ctx.json(200, await group.updateMember(ctx.params.memberId, (await ctx.body()) ?? {})));
  router.delete('/api/group/members/:memberId', async (ctx) => {
    await group.removeMember(ctx.params.memberId);
    return ctx.noContent();
  });
  router.get('/api/group/:chatId', async (ctx) => ctx.json(200, await group.get(ctx.params.chatId)));
  router.post('/api/group/:chatId/members', async (ctx) => ctx.json(201, await group.addMember(ctx.params.chatId, await resolveMemberCard((await ctx.body()) ?? {}))));
  router.put('/api/group/:chatId/strategy', async (ctx) => ctx.json(200, await group.setStrategy(ctx.params.chatId, (await ctx.body()) ?? {})));
  router.get('/api/group/:chatId/next', async (ctx) => ctx.json(200, await chat.plan(ctx.params.chatId, ctx.query)));
  router.post('/api/group/:chatId/auto', async (ctx) => ctx.json(200, await group.auto(ctx.params.chatId, (await ctx.body()) ?? {})));

  // ---------------------------------------------------------------- 场景状态
  router.get('/api/state/panels', (ctx) => ctx.json(200, { items: state.panels() }));
  router.get('/api/state/:chatId', async (ctx) => ctx.json(200, await state.get(ctx.params.chatId)));
  router.put('/api/state/:chatId', async (ctx) => ctx.json(200, await state.put(ctx.params.chatId, (await ctx.body()) ?? {})));
  router.post('/api/state/:chatId/roll', async (ctx) => ctx.json(200, await state.roll(ctx.params.chatId, (await ctx.body()) ?? {})));
  router.get('/api/state/:chatId/snapshots', async (ctx) => ctx.json(200, await state.snapshots(ctx.params.chatId)));
  router.post('/api/state/:chatId/snapshots', async (ctx) => ctx.json(201, await state.snapshot(ctx.params.chatId, (await ctx.body()) ?? {})));
  router.post('/api/state/:chatId/snapshots/:snapshotId/restore', async (ctx) =>
    ctx.json(200, await state.restore(ctx.params.chatId, ctx.params.snapshotId)),
  );
  router.delete('/api/state/:chatId/snapshots/:snapshotId', async (ctx) => {
    await state.removeSnapshot(ctx.params.chatId, ctx.params.snapshotId);
    return ctx.noContent();
  });

  // ---------------------------------------------------------------- 叙事控制
  router.get('/api/narration/modes', (ctx) => ctx.json(200, { items: narration.modes() }));
  router.get('/api/narration/:chatId/options', async (ctx) => ctx.json(200, await narration.options(ctx.params.chatId, ctx.query)));
  router.post('/api/narration/:chatId/options', async (ctx) => ctx.json(200, await narration.options(ctx.params.chatId, (await ctx.body()) ?? {})));
  router.get('/api/narration/:chatId/latest', async (ctx) => ctx.json(200, await narration.latest(ctx.params.chatId)));
  router.post('/api/narration/:chatId/director', async (ctx) =>
    ctx.json(200, await narration.director(ctx.params.chatId, (await ctx.body()) ?? {})),
  );
  router.post('/api/narration/:chatId/branch', async (ctx) => ctx.json(201, await narration.branch(ctx.params.chatId, (await ctx.body()) ?? {})));

  // 加分项（2.4）：章节管理 / 结局收集 / 随机事件
  router.get('/api/narration/:chatId/chapters', async (ctx) => ctx.json(200, narration.chapters(ctx.params.chatId)));
  router.post('/api/narration/:chatId/chapters', async (ctx) => ctx.json(201, narration.saveChapter(ctx.params.chatId, (await ctx.body()) ?? {})));
  router.put('/api/narration/:chatId/chapters/:chapterId', async (ctx) =>
    ctx.json(200, narration.saveChapter(ctx.params.chatId, { ...((await ctx.body()) ?? {}), id: ctx.params.chapterId })),
  );
  router.delete('/api/narration/:chatId/chapters/:chapterId', async (ctx) => {
    narration.deleteChapter(ctx.params.chatId, ctx.params.chapterId);
    return ctx.noContent();
  });

  router.get('/api/narration/:chatId/endings', async (ctx) => ctx.json(200, narration.endings(ctx.params.chatId)));
  router.post('/api/narration/:chatId/endings', async (ctx) => ctx.json(201, narration.recordCollectedEnding(ctx.params.chatId, (await ctx.body()) ?? {})));

  router.get('/api/narration/:chatId/events', async (ctx) => ctx.json(200, narration.eventSettings(ctx.params.chatId)));
  router.put('/api/narration/:chatId/events', async (ctx) => ctx.json(200, narration.saveEventSettings(ctx.params.chatId, (await ctx.body()) ?? {})));
  router.post('/api/narration/:chatId/events/roll', async (ctx) => ctx.json(200, narration.rollEvent(ctx.params.chatId, (await ctx.body()) ?? {})));

  // ---------------------------------------------------------------- 只留接口的部分
  stubs(router, [
    ['GET', '/api/performance/:chatId', '演出层状态'],
    ['POST', '/api/performance/:chatId/export-renpy', '导出 Ren\'Py 工程'],
    ['POST', '/api/speech/speak', '朗读文本'],
    ['POST', '/api/speech/transcribe', '语音转文字'],
    ['GET', '/api/speech/voices', '音色列表'],
    ['POST', '/api/images/generate', '生成图片'],
    ['GET', '/api/images/:chatId/gallery', 'CG 相册'],
  ]);
}
