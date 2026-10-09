/**
 * 演出层接口（蓝图 2.5）。
 *
 * 图仍然是 ComfyUI（3.1）出的 —— 这里只挑图、拼舞台、导出 Ren'Py；
 * 要出新背景就调 comfy.run（和「工具箱 → ComfyUI」走的是同一条通道）。
 * 语音（2.6）不在这里：需要新的提供方适配器，这次不允许动模型接入层。
 */

import { createZip } from '../toolbox/zip.mjs';
import { buildRenpyProject, buildStage } from '../../core/staging/service.mjs';
import { buildTimeline } from '../../core/staging/script.mjs';
import {
  AUDIO_CHANNELS,
  buildGallery,
  dropSave,
  enterRoute,
  evaluateRoutes,
  mergeShowSettings,
  normaliseShowSettings,
  pickBgm,
  planTransition,
  recordEnding,
  routeKinds,
  transitions as transitionCatalog,
  unlockCg,
  unlockRoute,
  writeSave,
} from '../../core/staging/show.mjs';
import { ValidationError } from '../../core/errors.mjs';

export function register(router, { engine, chatStore, assets }) {
  const chat = engine.services.chat;
  const comfy = engine.services.comfy;
  const narration = engine.services.narration;

  async function stageFor(chatId) {
    const chatItem = chatStore.getChat(chatId);
    if (!chatItem) throw new ValidationError(`没有这个对话：${chatId}`);
    const messages = chatStore.listMessages(chatId);
    const runs = comfy ? comfy.runs({ chatId, limit: 200 }).items : [];
    // 卡内表情差分包：当前情绪有绑好的图，就当主立绘（对话里按情绪自动换）。
    let expressionPack = null;
    if (comfy?.expressionAssetFor) {
      const members = chatItem.members ?? [];
      const member = members.find((item) => !item.muted) ?? members[0] ?? null;
      const variables = {};
      for (const row of chatStore.listVariables(chatId, { scope: 'chat' })) variables[row.key] = row.value;
      const emotion = variables.emotion ?? chatItem.worldState?.emotion ?? null;
      const found = comfy.expressionAssetFor({ characterId: member?.characterId ?? null, emotion });
      if (found) expressionPack = { ...found, name: member?.name ?? chatItem.title ?? '角色' };
    }
    let options = [];
    try {
      options = (await narration.latest(chatId))?.items ?? [];
    } catch {
      options = [];
    }
    return { chat: chatItem, messages, runs, stage: buildStage({ chat: chatItem, messages, runs, options, expressionPack }) };
  }

  /** 演出设置存在 chat.settings.show 里（不进表、不加迁移）。 */
  function showOf(chatItem) {
    return normaliseShowSettings(chatItem?.settings?.show);
  }

  function saveShow(chatItem, nextShow) {
    const settings = { ...(chatItem.settings ?? {}), show: nextShow };
    chatStore.updateChat(chatItem.id, { settings });
    return nextShow;
  }

  /** 当前舞台：背景 / 立绘 / CG / 要演的台词 / 候选行动。 */
  router.get('/api/staging/:chatId', async (ctx) => {
    const { chat: chatItem, messages, runs, stage } = await stageFor(ctx.params.chatId);
    const show = showOf(chatItem);
    const gallery = buildGallery({ runs, messages, limit: 200 });
    // 演出时间线：把消息编译成"逐句的舞台"，剧本里的 [场景: …] / [CG: …] 等指示在这里生效。
    const timeline = buildTimeline({
      messages,
      cast: show.cast,
      transitionIds: transitionCatalog().map((item) => item.id),
    });
    // 转场由服务端判定（"上一帧场景"由前端带上来），前端不重写一份判断逻辑。
    const previousScene = ctx.query.prev === '1' ? { place: ctx.query.prevPlace ?? '', time: ctx.query.prevTime ?? '' } : null;
    return ctx.json(200, {
      ...stage,
      persona: chatItem.persona?.name ?? '我',
      members: (chatItem.members ?? []).map((member) => ({ id: member.id, name: member.name, muted: Boolean(member.muted) })),
      show,
      timeline,
      playback: show.playback,
      cast: show.cast,
      unlocks: show.unlocks,
      saves: show.saves,
      audio: { ...show.audio, resolved: pickBgm({ audio: show.audio, scene: stage.scene }) },
      transition: show.transition,
      transitionPlan: planTransition({ previousScene, scene: stage.scene, transition: show.transition }),
      routes: evaluateRoutes({ routes: show.routes, worldState: chatItem.worldState, endings: show.endings }),
      gallery,
      catalogs: { transitions: transitionCatalog(), routeKinds: routeKinds(), audioChannels: AUDIO_CHANNELS.map((item) => ({ ...item })) },
    });
  });

  /** 转场 / BGM / 路线设置：只合并传进来的字段。 */
  router.put('/api/staging/:chatId/show', async (ctx) => {
    const chatItem = chatStore.getChat(ctx.params.chatId);
    if (!chatItem) throw new ValidationError(`没有这个对话：${ctx.params.chatId}`);
    const patch = (await ctx.body()) ?? {};
    const next = mergeShowSettings(chatItem.settings?.show, patch);
    saveShow(chatItem, next);
    return ctx.json(200, { show: next });
  });

  /** CG 回廊：生成过 / 触发过的图。 */
  router.get('/api/staging/:chatId/gallery', async (ctx) => {
    const { messages, runs } = await stageFor(ctx.params.chatId);
    return ctx.json(200, buildGallery({ runs, messages, limit: Number(ctx.query.limit) || 200 }));
  });

  /**
   * 解锁一张 CG —— 必须是"演到那儿"才调这里。
   * 幂等：同一张再解一次只回 200，不新增记录。
   */
  router.post('/api/staging/:chatId/unlocks', async (ctx) => {
    const chatItem = chatStore.getChat(ctx.params.chatId);
    if (!chatItem) throw new ValidationError(`没有这个对话：${ctx.params.chatId}`);
    const body = (await ctx.body()) ?? {};
    const name = String(body.name ?? '').trim();
    if (!name) throw new ValidationError('要指定要解锁的 CG 名字');
    const show = showOf(chatItem);
    const unlocks = unlockCg(show.unlocks, { name, messageId: body.messageId ?? null });
    const added = unlocks.length !== show.unlocks.length;
    saveShow(chatItem, { ...show, unlocks });
    return ctx.json(added ? 201 : 200, { unlocks, added });
  });

  /** 写一个演出存档槽（同槽覆盖）。 */
  router.put('/api/staging/:chatId/saves', async (ctx) => {
    const chatItem = chatStore.getChat(ctx.params.chatId);
    if (!chatItem) throw new ValidationError(`没有这个对话：${ctx.params.chatId}`);
    const body = (await ctx.body()) ?? {};
    const slot = Math.round(Number(body.slot));
    if (!Number.isFinite(slot) || slot < 1 || slot > 99) throw new ValidationError('槽号要在 1-99 之间');
    const show = showOf(chatItem);
    const saves = writeSave(show.saves, {
      slot,
      label: body.label ?? '',
      lineIndex: body.lineIndex ?? 0,
      messageId: body.messageId ?? null,
      name: body.name ?? '',
      text: body.text ?? '',
      scene: body.scene ?? '',
      shotAssetId: body.shotAssetId ?? null,
    });
    saveShow(chatItem, { ...show, saves });
    return ctx.json(201, { saves, slot });
  });

  /** 删一个演出存档槽。 */
  router.delete('/api/staging/:chatId/saves/:slot', async (ctx) => {
    const chatItem = chatStore.getChat(ctx.params.chatId);
    if (!chatItem) throw new ValidationError(`没有这个对话：${ctx.params.chatId}`);
    const show = showOf(chatItem);
    const saves = dropSave(show.saves, ctx.params.slot);
    saveShow(chatItem, { ...show, saves });
    return ctx.json(200, { saves });
  });

  /** 记录一个已触发的结局（结局收集 / 多结局图鉴）。 */
  router.post('/api/staging/:chatId/endings', async (ctx) => {
    const chatItem = chatStore.getChat(ctx.params.chatId);
    if (!chatItem) throw new ValidationError(`没有这个对话：${ctx.params.chatId}`);
    const body = (await ctx.body()) ?? {};
    const show = showOf(chatItem);
    const route = show.routes.find((item) => item.id === body.routeId) ?? null;
    if (!route) throw new ValidationError(`没有这条路线：${body.routeId}`);
    const endings = recordEnding(show.endings, { routeId: route.id, title: body.title ?? route.title, ending: body.ending ?? route.ending });
    const next = saveShow(chatItem, { ...show, endings });
    return ctx.json(201, evaluateRoutes({ routes: next.routes, worldState: chatItem.worldState, endings: next.endings }));
  });

  /**
   * 进入一条路线：它自己解锁，其它线锁上（真 gal 的路线锁定）。
   * 剧本文里写 `[路线: 恋人线]` 就会走到这儿。
   */
  router.post('/api/staging/:chatId/routes/enter', async (ctx) => {
    const chatItem = chatStore.getChat(ctx.params.chatId);
    if (!chatItem) throw new ValidationError(`没有这个对话：${ctx.params.chatId}`);
    const body = (await ctx.body()) ?? {};
    const key = String(body.name ?? body.routeId ?? '').trim();
    if (!key) throw new ValidationError('要指定要进的路线');
    const show = showOf(chatItem);
    const hit = show.routes.find((route) => route.id === key || route.title === key) ?? null;
    if (!hit) throw new ValidationError(`没有这条路线：${key}`);
    const routes = enterRoute(show.routes, hit.id);
    const next = { ...show, routes };
    saveShow(chatItem, next);
    return ctx.json(200, evaluateRoutes({ routes, worldState: chatItem.worldState, endings: next.endings }));
  });

  /** 手动放出一条被锁住的线（想回去看别的线）。 */
  router.post('/api/staging/:chatId/routes/:routeId/unlock', async (ctx) => {
    const chatItem = chatStore.getChat(ctx.params.chatId);
    if (!chatItem) throw new ValidationError(`没有这个对话：${ctx.params.chatId}`);
    const show = showOf(chatItem);
    const routes = unlockRoute(show.routes, ctx.params.routeId);
    saveShow(chatItem, { ...show, routes });
    return ctx.json(200, evaluateRoutes({ routes, worldState: chatItem.worldState, endings: show.endings }));
  });

  /**
   * 给当前场景出一张背景：复用 3.1，不新造一套出图。
   * body.workflowId 不给就按 kind=background 挑一个启用的工作流。
   */
  router.post('/api/staging/:chatId/generate', async (ctx) => {
    const body = (await ctx.body()) ?? {};
    const chatItem = chatStore.getChat(ctx.params.chatId);
    if (!chatItem) throw new ValidationError(`没有这个对话：${ctx.params.chatId}`);
    const kind = body.kind ?? 'background';
    const workflow =
      (body.workflowId ? comfy.getWorkflow(body.workflowId) : null) ??
      comfy.listWorkflows({ kind }).items.find((item) => item.enabled !== false) ??
      comfy.listWorkflows({}).items.find((item) => item.enabled !== false);
    if (!workflow) throw new ValidationError('还没有可用的工作流：去「工具箱 → ComfyUI」一键添加一个示例');
    // 浏览器直连：演出层也只登记待办，由前端来领（主机不去连用户地址）。
    if (comfy.executionMode() === 'client') {
      const pending = comfy.enqueueClientRun({
        workflowId: workflow.id,
        chatId: chatItem.id,
        values: body.values ?? {},
        context: body.context ?? {},
        seed: body.seed ?? null,
        reason: 'staging',
      });
      return ctx.json(202, pending);
    }
    const run = await comfy.run({
      workflowId: workflow.id,
      chatId: chatItem.id,
      values: body.values ?? {},
      context: body.context ?? {},
      seed: body.seed ?? null,
      reason: 'staging',
    });
    return ctx.json(202, run);
  });

  /** 一键导出 Ren'Py 工程：script.rpy + 图片，打成一个 zip。 */
  router.get('/api/staging/:chatId/renpy', async (ctx) => {
    const { chat: chatItem, messages, stage } = await stageFor(ctx.params.chatId);
    let options = [];
    try {
      options = (await narration.latest(chatItem.id))?.items ?? [];
    } catch {
      options = [];
    }
    // BGM 配了的话一起带走：`play music "audio/bgm.xxx"` + 把音频字节打进 zip。
    const show = showOf(chatItem);
    const bgm = pickBgm({ audio: show.audio, scene: stage.scene });
    const bgmAsset = bgm.assetId ? assets?.get?.(bgm.assetId) ?? null : null;
    const extFor = (asset) => {
      const fromName = String(asset?.name ?? '').match(/\.([A-Za-z0-9]{2,5})$/)?.[1];
      if (fromName) return fromName.toLowerCase();
      const map = { 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/webm': 'webm' };
      return map[asset?.mime] ?? 'mp3';
    };
    const music = bgmAsset ? { file: `audio/bgm.${extFor(bgmAsset)}` } : null;
    const project = buildRenpyProject({ chat: chatItem, messages, stage, options, title: ctx.query.title ?? null, music });
    const entries = project.files.map((file) => ({ name: `game/${file.name}`, data: Buffer.from(file.text, 'utf8') }));
    for (const ref of project.assetRefs) {
      const found = assets?.buffer?.(ref.assetId) ?? null;
      if (!found) continue;
      entries.push({ name: `game/${ref.name}`, data: found.buffer });
    }
    if (music) {
      const found = assets?.buffer?.(bgm.assetId) ?? null;
      if (found) entries.push({ name: `game/${music.file}`, data: found.buffer });
    }
    const zip = createZip(entries);
    const filename = `${(project.title || 'silver-tavern').replace(/[^\w\u4e00-\u9fff-]+/g, '_')}.zip`;
    ctx.res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    });
    ctx.res.end(zip);
    return undefined;
  });
}
