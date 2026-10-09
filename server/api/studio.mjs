/**
 * 工坊接口：写卡质检 / 建卡向导 / 世界书一行语法与递归地图 /
 * 模块化 Markdown 卡 / 临场指令三层 / 采样器顺序 / 套装 / 分支图 /
 * 反向代理预设 / 连接档案 / 提供方能力位。
 *
 * 这一层刻意做得很薄：真正的判断都在 core/ 里（可单测），这里只做
 * "取数据 → 调 core → 落库 / 出参"。
 */

import { ValidationError, NotFoundError } from '../../core/errors.mjs';
import { lintCard, cardBody, AI_FLAVOR_RULES, OPENING_CHECKS, CARD_DIMENSIONS, ORIENTATION_AXES } from '../../core/writing/quality.mjs';
import { OPENING_PARADIGMS, CREATOR_NOTES_TEMPLATE, planCard, buildCardDraft } from '../../core/writing/wizard.mjs';
import {
  parseNotationBlock,
  toNotationBlock,
  buildRecursionMap,
  lintEntries,
  GENERATION_TRIGGERS,
} from '../../core/worldbook/notation.mjs';
import { cardFromMarkdown, markdownFromCard } from '../../core/cards/markdown.mjs';
import { resolveNote, describeNote, NOTE_POSITIONS, NOTE_ROLES, shouldInject } from '../../core/prompts/note.mjs';
import {
  SAMPLER_CATALOG,
  BACKEND_DEFAULT_ORDER,
  BACKEND_LABELS,
  createSamplerProfile,
  resetOrder,
  neutralize,
  describeDiff,
  supportedBackends,
  normaliseOrder,
} from '../../core/play/samplers.mjs';
import { LOADOUT_PARTS, createLoadout, applyLoadout, describeLoadout } from '../../core/play/loadout.mjs';
import { buildBranchTree, layoutBranchTree, branchStats } from '../../core/play/branches.mjs';
import { PROVIDER_FLAGS, flagsFor, visibleParams, describeFlags, ADAPTER_FLAGS } from '../../core/providers-flags.mjs';
import { ADAPTERS } from '../providers/catalog.mjs';
import { listProviders } from '../db/providers.mjs';
import { httpFetch } from '../providers/http.mjs';
import {
  CAPTION_TEMPLATE_DEFAULT,
  MAX_IMAGE_BYTES,
  SUPPORTED_IMAGE_MIMES,
  decideImageMode,
  normaliseImageMeta,
  renderCaption,
} from '../../core/media/vision.mjs';
import { STEP_TYPES, normaliseActionSet, describeActionSet, expandActionText } from '../../core/play/actions.mjs';
import { TRANSLATE_TARGETS, buildTranslatePrompt, parseTranslateResult, shouldAutoTranslate } from '../../core/play/translation.mjs';
import { BOOKMARK_COLORS, normaliseBookmark } from '../../core/play/bookmarks.mjs';
import { splitReasoning } from '../../core/play/reasoning.mjs';
import { normaliseUrl, htmlToText, chunkText, buildExtractPrompt } from '../../core/studio/source.mjs';
import { chatToHtml, chatToMarkdown } from '../../core/studio/export-html.mjs';
import { BUILTIN_LOGIT_PRESETS, BIAS_RANGE, normalisePreset, mergeBias, describeBias } from '../../core/studio/logit-presets.mjs';
import { memoriesToEntries } from '../../core/memory/to-worldbook.mjs';
import {
  createNoteStore,
  createSamplerStore,
  createLoadoutStore,
  createProxyStore,
  createProfileStore,
  createBookmarkStore,
  createActionStore,
  createLogitStore,
} from '../db/studio.mjs';

/** 仓储只建一次（按 repo 缓存），免得每个请求都 new 一遍。 */
const CACHE = new WeakMap();

function storesFor(deps) {
  const repo = deps?.repo;
  if (!repo) throw new ValidationError('这个接口需要数据库');
  if (!CACHE.has(repo)) {
    CACHE.set(repo, {
      notes: createNoteStore({ repo }),
      samplers: createSamplerStore({ repo }),
      loadouts: createLoadoutStore({ repo }),
      proxies: createProxyStore({ repo }),
      profiles: createProfileStore({ repo }),
      bookmarks: createBookmarkStore({ repo }),
      actions: createActionStore({ repo }),
      logit: createLogitStore({ repo }),
    });
  }
  return CACHE.get(repo);
}

async function loadCard(deps, id) {
  const cards = deps?.engine?.services?.cards;
  if (!cards || typeof cards.get !== 'function') throw new ValidationError('卡库服务不可用');
  const card = await cards.get(id);
  if (!card) throw new NotFoundError(`角色卡 ${id}`);
  return card;
}

export function register(router, deps) {
  const store = () => storesFor(deps);
  /** ctx.body 是异步方法；统一在这里读一次并兜住空体。 */
  const readBody = async (ctx) => (await ctx.body()) ?? {};

  // ------------------------------------------------------------ 写卡质检

  router.get('/api/studio/quality/meta', (ctx) => ctx.json(200, {
    // 全八条都吐出来（其中「零闲笔」是反着检测的，没有 pattern，但界面要知道它存在）
    rules: AI_FLAVOR_RULES.map((rule) => ({ id: rule.id, title: rule.title, quota: rule.quota, advice: rule.advice })),
    openingChecks: OPENING_CHECKS,
    dimensions: CARD_DIMENSIONS,
  }));

  /** 直接体检一份卡数据（不必先入库）。 */
  router.post('/api/studio/quality', async (ctx) => {
    const body = await readBody(ctx);
    const payload = body.card ?? body;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).length === 0) {
      throw new ValidationError('需要一个 card 对象（至少要有 name）');
    }
    return ctx.json(200, lintCard(payload));
  });

  /** 体检库里的某张卡。 */
  router.get('/api/studio/quality/:cardId', async (ctx) => {
    const card = await loadCard(deps, ctx.params.cardId);
    return ctx.json(200, lintCard(cardBody(card)));
  });

  /** 把体检做成"交付前闸门"：不阻断，只给弱项清单。 */
  router.get('/api/studio/quality/:cardId/gate', async (ctx) => {
    const card = await loadCard(deps, ctx.params.cardId);
    const report = lintCard(cardBody(card));
    const threshold = Number(ctx.query?.threshold ?? 75);
    return ctx.json(200, {
      total: report.total,
      grade: report.grade,
      threshold,
      pass: report.total >= threshold,
      blockers: report.issues.filter((issue) => issue.level === 'error'),
      weak: report.issues.filter((issue) => issue.level !== 'error'),
    });
  });

  // ------------------------------------------------------------ 建卡向导

  router.get('/api/studio/wizard/options', (ctx) => ctx.json(200, {
    axes: ORIENTATION_AXES,
    paradigms: OPENING_PARADIGMS.map((item) => ({ id: item.id, title: item.title, fit: item.fit })),
    creatorNotesTemplate: CREATOR_NOTES_TEMPLATE,
  }));

  router.post('/api/studio/wizard/plan', async (ctx) => ctx.json(200, planCard(await readBody(ctx))));

  router.post('/api/studio/wizard/draft', async (ctx) => ctx.json(200, buildCardDraft(await readBody(ctx))));

  // ------------------------------------------------------------ 世界书一行语法

  router.post('/api/studio/worldbook/notation/parse', async (ctx) => {
    const body = await readBody(ctx);
    const text = String(body.text ?? '');
    if (!text.trim()) throw new ValidationError('要解析的文本是空的');
    const { entries, errors } = parseNotationBlock(text);
    return ctx.json(200, { entries, errors, lint: lintEntries(entries), triggers: GENERATION_TRIGGERS });
  });

  router.post('/api/studio/worldbook/notation/format', async (ctx) => {
    const body = await readBody(ctx);
    const entries = body.entries;
    if (!Array.isArray(entries)) throw new ValidationError('需要 entries 数组');
    return ctx.json(200, { text: toNotationBlock(entries) });
  });

  /** 批量导入：解析一行语法，逐条写进指定世界书。 */
  router.post('/api/studio/worldbook/:bookId/notation', async (ctx) => {
    const body = await readBody(ctx);
    const text = String(body.text ?? '');
    const { entries, errors } = parseNotationBlock(text);
    if (entries.length === 0) return ctx.json(200, { imported: 0, errors });
    const worldbook = deps.engine?.services?.worldbook;
    if (!worldbook?.saveEntry) throw new ValidationError('世界书服务不可用');
    const saved = [];
    for (const entry of entries) {
      try {
        const record = await worldbook.saveEntry(ctx.params.bookId, entry);
        saved.push({ comment: entry.comment, uid: record?.uid ?? record?.id ?? null });
      } catch (err) {
        errors.push({ line: 0, message: `${entry.comment}：${err?.message ?? err}` });
      }
    }
    return ctx.json(200, { imported: saved.length, entries: saved, errors });
  });

  /** 递归地图：谁触发谁、有没有环、有没有孤儿。 */
  router.get('/api/studio/worldbook/:bookId/map', async (ctx) => {
    const worldbook = deps.engine?.services?.worldbook;
    if (!worldbook?.entries) throw new ValidationError('世界书服务不可用');
    const entries = await worldbook.entries(ctx.params.bookId);
    const list = Array.isArray(entries) ? entries : entries?.items ?? [];
    return ctx.json(200, { ...buildRecursionMap(list), lint: lintEntries(list) });
  });

  // ------------------------------------------------------------ 模块化 Markdown 卡

  router.post('/api/studio/cards/markdown/parse', async (ctx) => {
    const body = await readBody(ctx);
    const text = String(body.markdown ?? body.text ?? '');
    const parsed = cardFromMarkdown(text);
    return ctx.json(200, { ...parsed, lint: lintCard(parsed.card) });
  });

  router.post('/api/studio/cards/markdown/export', async (ctx) => {
    const body = await readBody(ctx);
    const card = body.card ?? {};
    return ctx.json(200, { markdown: markdownFromCard(card, { lorebook: body.lorebook ?? null }) });
  });

  router.get('/api/studio/cards/:cardId/markdown', async (ctx) => {
    const card = await loadCard(deps, ctx.params.cardId);
    return ctx.json(200, { markdown: markdownFromCard(cardBody(card)) });
  });

  // ------------------------------------------------------------ 临场指令（三层）

  router.get('/api/studio/notes', (ctx) => {
    const characterId = ctx.query?.characterId ?? null;
    const chatId = ctx.query?.chatId ?? null;
    const layers = store().notes.layers({ characterId, chatId });
    const resolved = resolveNote({ defaultNote: layers.default, characterNote: layers.character, chatNote: layers.chat });
    return ctx.json(200, {
      layers,
      resolved: resolved.note ? { ...resolved.note, from: resolved.from } : null,
      summary: describeNote(resolved.note, resolved.from),
      positions: NOTE_POSITIONS,
      roles: NOTE_ROLES,
    });
  });

  router.put('/api/studio/notes/:scope/:scopeId', async (ctx) => {
    const body = await readBody(ctx);
    const saved = store().notes.set(ctx.params.scope, ctx.params.scopeId === '-' ? '' : ctx.params.scopeId, body);
    return ctx.json(200, saved);
  });

  router.delete('/api/studio/notes/:scope/:scopeId', (ctx) => {
    const removed = store().notes.remove(ctx.params.scope, ctx.params.scopeId === '-' ? '' : ctx.params.scopeId);
    return ctx.json(200, { removed });
  });

  /** 预览：给一个用户轮数，看这一轮到底插不插。 */
  router.post('/api/studio/notes/preview', async (ctx) => {
    const body = await readBody(ctx);
    const layers = body.layers ?? {};
    const resolved = resolveNote({ defaultNote: layers.default, characterNote: layers.character, chatNote: layers.chat });
    const turns = Number(body.userTurnCount ?? 1);
    return ctx.json(200, {
      note: resolved.note,
      from: resolved.from,
      inject: shouldInject(resolved.note, turns),
      summary: describeNote(resolved.note, resolved.from),
    });
  });

  // ------------------------------------------------------------ 采样器

  router.get('/api/studio/samplers/meta', (ctx) => ctx.json(200, {
    catalog: SAMPLER_CATALOG,
    backends: supportedBackends().map((id) => ({ id, title: BACKEND_LABELS[id] ?? id, defaultOrder: BACKEND_DEFAULT_ORDER[id] })),
  }));

  router.get('/api/studio/samplers', (ctx) => {
    const backend = ctx.query?.backend ?? null;
    const items = store().samplers.list({ backend });
    return ctx.json(200, { items: items.map((item) => ({ ...item, diff: describeDiff(item) })), total: items.length });
  });

  router.post('/api/studio/samplers', async (ctx) => {
    const body = await readBody(ctx);
    const profile = createSamplerProfile({
      backend: body.backend,
      order: body.order,
      enabled: body.enabled,
      params: body.params,
    });
    const saved = store().samplers.save({
      id: body.id ?? null,
      name: body.name,
      backend: profile.backend,
      payload: { order: profile.order, enabled: profile.enabled, params: profile.params },
    });
    return ctx.json(200, { ...saved, diff: describeDiff(saved) });
  });

  router.post('/api/studio/samplers/:id/action', async (ctx) => {
    const existing = store().samplers.get(ctx.params.id);
    if (!existing) throw new NotFoundError(`采样器档案 ${ctx.params.id}`);
    const body = await readBody(ctx);
    const action = String(body.action ?? '');
    const next = action === 'reset'
      ? resetOrder(existing)
      : action === 'neutralize'
        ? neutralize(existing)
        : action === 'reorder'
          ? createSamplerProfile({ ...existing, order: body.order ?? existing.order, enabled: body.enabled ?? existing.enabled })
          : null;
    if (!next) throw new ValidationError('action 只认 reset / neutralize / reorder');
    const saved = store().samplers.save({
      id: existing.id,
      name: existing.name,
      backend: next.backend,
      payload: { order: next.order, enabled: next.enabled, params: next.params },
    });
    return ctx.json(200, { ...saved, diff: describeDiff(saved) });
  });

  router.delete('/api/studio/samplers/:id', (ctx) => ctx.json(200, { removed: store().samplers.remove(ctx.params.id) }));

  /** 不落库，只算一份：前端拖完顺序想看结果时用。 */
  router.post('/api/studio/samplers/preview', async (ctx) => {
    const body = await readBody(ctx);
    const profile = createSamplerProfile({ backend: body.backend, order: body.order, enabled: body.enabled, params: body.params });
    return ctx.json(200, { ...profile, diff: describeDiff(profile), normalised: normaliseOrder(profile.order, profile.backend) });
  });

  // ------------------------------------------------------------ 套装

  router.get('/api/studio/loadouts/meta', (ctx) => ctx.json(200, { parts: LOADOUT_PARTS }));

  router.get('/api/studio/loadouts', (ctx) => {
    const items = store().loadouts.list();
    return ctx.json(200, { items: items.map((item) => ({ ...item, summary: describeLoadout(item) })), total: items.length });
  });

  router.post('/api/studio/loadouts', async (ctx) => {
    const body = await readBody(ctx);
    const draft = createLoadout(body.state ?? {}, { name: body.name, parts: body.parts, id: body.id, favorite: body.favorite });
    const saved = store().loadouts.save({
      id: body.id ?? null,
      name: draft.name,
      favorite: draft.favorite,
      payload: { parts: draft.parts, data: draft.payload },
    });
    return ctx.json(200, { ...saved, summary: describeLoadout(saved) });
  });

  /** 选择性应用：只应用 apply 里列出的那几部分。 */
  router.post('/api/studio/loadouts/:id/apply', async (ctx) => {
    const loadout = store().loadouts.get(ctx.params.id);
    if (!loadout) throw new NotFoundError(`套装 ${ctx.params.id}`);
    const body = await readBody(ctx);
    const result = applyLoadout(loadout, body.current ?? {}, body.apply ?? null);
    store().loadouts.touch(loadout.id);
    return ctx.json(200, { ...result, summary: describeLoadout(loadout) });
  });

  router.delete('/api/studio/loadouts/:id', (ctx) => ctx.json(200, { removed: store().loadouts.remove(ctx.params.id) }));

  // ------------------------------------------------------------ 分支图

  router.get('/api/studio/branches', async (ctx) => {
    const chatStore = deps.chatStore;
    if (!chatStore?.listChats) throw new ValidationError('对话存储不可用');
    const characterId = ctx.query?.characterId ?? null;
    const chats = await Promise.resolve(chatStore.listChats({ characterId }));
    const list = Array.isArray(chats) ? chats : chats?.items ?? [];
    const detailed = [];
    for (const chat of list.slice(0, Number(ctx.query?.limit ?? 200))) {
      const messages = chatStore.listMessages ? await Promise.resolve(chatStore.listMessages(chat.id)) : [];
      detailed.push({
        id: chat.id,
        title: chat.title ?? chat.name ?? '',
        firstMessage: chat.firstMessage ?? chat.first_mes ?? '',
        messages: (messages ?? []).map((message) => ({ role: message.role, content: message.content })),
      });
    }
    const tree = buildBranchTree(detailed);
    return ctx.json(200, { ...tree, layout: layoutBranchTree(tree), stats: branchStats(tree) });
  });

  // ------------------------------------------------------------ 反向代理预设

  router.get('/api/studio/proxies', (ctx) => {
    const items = store().proxies.list({ providerKind: ctx.query?.providerKind ?? null });
    return ctx.json(200, { items, total: items.length });
  });

  router.post('/api/studio/proxies', async (ctx) => ctx.json(200, store().proxies.save(await readBody(ctx))));
  router.delete('/api/studio/proxies/:id', (ctx) => ctx.json(200, { removed: store().proxies.remove(ctx.params.id) }));

  // ------------------------------------------------------------ 连接档案（排除法）

  router.get('/api/studio/profiles', (ctx) => {
    const items = store().profiles.list();
    return ctx.json(200, { items, total: items.length });
  });

  /**
   * 排除法：客户端把"当前全部连接相关设置"传进来，服务端只保存
   * 没有被 exclude 勾掉的那些键。
   */
  router.post('/api/studio/profiles', async (ctx) => {
    const body = await readBody(ctx);
    const settings = body.settings && typeof body.settings === 'object' ? body.settings : {};
    const exclude = new Set(Array.isArray(body.exclude) ? body.exclude.map(String) : []);
    const included = {};
    const omitted = [];
    for (const [key, value] of Object.entries(settings)) {
      if (exclude.has(key)) omitted.push(key);
      else included[key] = value;
    }
    const saved = store().profiles.save({ id: body.id ?? null, name: body.name, payload: { settings: included, omitted } });
    return ctx.json(200, saved);
  });

  router.delete('/api/studio/profiles/:id', (ctx) => ctx.json(200, { removed: store().profiles.remove(ctx.params.id) }));

  // ------------------------------------------------------------ 提供方能力位

  router.get('/api/studio/providers/capabilities', (ctx) => {
    const adapterId = ctx.query?.adapter ?? null;
    const presetId = ctx.query?.preset ?? null;
    if (adapterId) {
      const flags = flagsFor(adapterId, presetId);
      return ctx.json(200, {
        adapter: adapterId,
        preset: presetId,
        flags,
        detail: describeFlags(flags),
        params: visibleParams(flags),
      });
    }
    return ctx.json(200, {
      vocabulary: PROVIDER_FLAGS,
      adapters: ADAPTERS.map((adapter) => ({
        id: adapter.id,
        title: adapter.title,
        flags: ADAPTER_FLAGS[adapter.id] ?? [],
        detail: describeFlags(ADAPTER_FLAGS[adapter.id] ?? []),
      })),
    });
  });

  // ------------------------------------------------------------ 视觉（看图 / 转文字）

  function settings() {
    return deps.engine?.settings ?? {};
  }

  /** 挑一个聊天提供方：显式给的优先，其次默认的，最后第一个能用的。 */
  function pickChatProvider(explicit = null, { needVision = false } = {}) {
    if (explicit) return explicit;
    const providers = listProviders(deps.repo) ?? [];
    const usable = providers.filter((item) => item.kind === 'chat' && item.enabled);
    const pool = needVision ? usable.filter((item) => (flagsFor(item.adapter, item.preset ?? null)).includes('vision')) : usable;
    return (pool.find((item) => item.isDefault) ?? pool[0])?.id ?? null;
  }

  router.get('/api/studio/vision/meta', (ctx) =>
    ctx.json(200, {
      template: settings()['vision.captionTemplate'] ?? CAPTION_TEMPLATE_DEFAULT,
      captionProviderId: settings()['vision.captionProviderId'] ?? '',
      autoCaption: settings()['vision.autoCaption'] !== false,
      maxBytes: MAX_IMAGE_BYTES,
      mimes: SUPPORTED_IMAGE_MIMES,
    }));

  /** 这一轮该直接发图，还是先转文字。 */
  router.post('/api/studio/vision/mode', async (ctx) => {
    const body = await readBody(ctx);
    const providerId = pickChatProvider(body.providerId ?? null);
    const provider = providerId ? (listProviders(deps.repo) ?? []).find((item) => item.id === providerId) : null;
    const flags = provider ? flagsFor(provider.adapter, provider.preset ?? null) : [];
    const decide = decideImageMode({
      hasImages: true,
      providerSupportsVision: flags.includes('vision'),
      captionModelAvailable: Boolean(settings()['vision.captionProviderId']) && settings()['vision.autoCaption'] !== false,
    });
    return ctx.json(200, { ...decide, providerId, vision: flags.includes('vision') });
  });

  /** 把一张图转成文字（给不能看图的模型用）。 */
  router.post('/api/studio/vision/caption', async (ctx) => {
    const body = await readBody(ctx);
    const base64 = String(body.base64 ?? '');
    if (!base64) throw new ValidationError('需要 base64 图片数据');
    const image = normaliseImageMeta({
      mime: body.mime,
      bytes: Number(body.bytes ?? Math.ceil((base64.length * 3) / 4)),
      base64,
      name: body.name,
    });
    const providerId = body.providerId || settings()['vision.captionProviderId'] || pickChatProvider(null, { needVision: true });
    if (!providerId) throw new ValidationError('没有可用的看图模型：去「模型接入」加一个支持视觉的提供方，或把 vision.captionProviderId 填上');
    if (!deps.models?.complete) throw new ValidationError('模型网关不可用');

    const prompt = String(body.prompt ?? '用中文客观描述这张图片的内容：画面里有什么、人物在做什么、环境与氛围。只输出描述本身，不要客套话。');
    const result = await deps.models.complete(providerId, {
      messages: [{ role: 'user', content: prompt, images: [image] }],
      params: { max_tokens: Number(body.maxTokens ?? 320) },
    });
    const caption = String(result.text ?? '').trim();
    const template = settings()['vision.captionTemplate'] ?? CAPTION_TEMPLATE_DEFAULT;
    return ctx.json(200, {
      caption,
      text: renderCaption(template, { caption, user: body.user ?? 'User', char: body.char ?? '角色' }),
      providerId,
      usage: result.usage ?? null,
    });
  });

  // ------------------------------------------------------------ 聊天翻译

  router.get('/api/studio/translate/meta', (ctx) =>
    ctx.json(200, {
      targets: TRANSLATE_TARGETS,
      target: settings()['translate.target'] ?? 'zh-CN',
      auto: Boolean(settings()['translate.auto']),
      onlyForeign: settings()['translate.onlyForeign'] !== false,
      intoContext: Boolean(settings()['translate.intoContext']),
    }));

  /** 翻一段文本；promptOnly=true 时只回提示词（方便前端自己调模型）。 */
  router.post('/api/studio/translate', async (ctx) => {
    const body = await readBody(ctx);
    const text = String(body.text ?? '').trim();
    if (!text) throw new ValidationError('要翻译的内容是空的');
    const target = String(body.target ?? settings()['translate.target'] ?? 'zh-CN');
    const prompt = buildTranslatePrompt({ text, target, keep: Array.isArray(body.keep) ? body.keep.map(String) : [] });
    if (body.promptOnly) return ctx.json(200, { prompt, target });

    const providerId = pickChatProvider(body.providerId ?? null);
    if (!providerId) throw new ValidationError('没有可用的聊天模型');
    const result = await deps.models.complete(providerId, {
      messages: [{ role: 'user', content: prompt }],
      params: { max_tokens: Math.min(4096, Math.max(256, Math.ceil(text.length * 2))) },
    });
    return ctx.json(200, {
      translation: parseTranslateResult(result.text),
      raw: String(result.text ?? ''),
      target,
      providerId,
      usage: result.usage ?? null,
    });
  });

  /** 自动翻译该不该触发（前端每条回复生成后问一次）。 */
  router.post('/api/studio/translate/should', async (ctx) => {
    const body = await readBody(ctx);
    return ctx.json(200, {
      translate: shouldAutoTranslate(body.text, {
        enabled: body.enabled ?? Boolean(settings()['translate.auto']),
        target: body.target ?? settings()['translate.target'] ?? 'zh-CN',
        onlyForeign: body.onlyForeign ?? settings()['translate.onlyForeign'] !== false,
      }),
    });
  });

  // ------------------------------------------------------------ 书签

  router.get('/api/studio/bookmarks', (ctx) =>
    ctx.json(200, {
      items: store().bookmarks.list({ chatId: ctx.query.chatId ?? null, characterId: ctx.query.characterId ?? null }),
      colors: BOOKMARK_COLORS,
    }));

  router.post('/api/studio/bookmarks', async (ctx) => {
    const body = await readBody(ctx);
    const bookmark = normaliseBookmark(body);
    return ctx.json(200, store().bookmarks.save({ ...bookmark, id: body.id ?? null }));
  });

  router.delete('/api/studio/bookmarks/:id', (ctx) => ctx.json(200, { removed: store().bookmarks.remove(ctx.params.id) }));

  router.delete('/api/studio/bookmarks/by-message', (ctx) =>
    ctx.json(200, { removed: store().bookmarks.removeByMessage(String(ctx.query.chatId ?? ''), String(ctx.query.messageId ?? '')) }));

  // ------------------------------------------------------------ 动作序列

  router.get('/api/studio/actions/meta', (ctx) => ctx.json(200, { stepTypes: STEP_TYPES }));

  router.get('/api/studio/actions', (ctx) => {
    const items = store().actions.list();
    return ctx.json(200, { items: items.map((item) => ({ ...item, description: describeActionSet(item) })), total: items.length });
  });

  router.post('/api/studio/actions', async (ctx) => {
    const body = await readBody(ctx);
    const set = normaliseActionSet(body);
    const saved = store().actions.save(body.id ?? null, set);
    return ctx.json(200, { ...saved, description: describeActionSet(saved) });
  });

  /** 展开变量，返回真正要跑的步骤。 */
  router.post('/api/studio/actions/:id/expand', async (ctx) => {
    const existing = store().actions.get(ctx.params.id);
    if (!existing) throw new NotFoundError(`动作组 ${ctx.params.id}`);
    const body = await readBody(ctx);
    const variables = { ...existing.variables, ...(body.variables ?? {}) };
    const steps = existing.steps.map((step) => {
      const out = { ...step };
      for (const key of ['text', 'value', 'label']) {
        if (typeof out[key] === 'string') out[key] = expandActionText(out[key], variables);
      }
      return out;
    });
    return ctx.json(200, { steps, variables });
  });

  router.delete('/api/studio/actions/:id', (ctx) => ctx.json(200, { removed: store().actions.remove(ctx.params.id) }));

  // ------------------------------------------------------------ Logit Bias 预设

  router.get('/api/studio/logit', (ctx) => {
    const items = store().logit.list();
    return ctx.json(200, {
      builtin: BUILTIN_LOGIT_PRESETS.map((preset) => ({ ...preset, description: describeBias(preset.bias) })),
      items: items.map((item) => ({ ...item, description: describeBias(item.bias) })),
      range: BIAS_RANGE,
    });
  });

  router.post('/api/studio/logit', async (ctx) => {
    const body = await readBody(ctx);
    const preset = normalisePreset(body);
    const saved = store().logit.save(body.id ?? null, preset);
    return ctx.json(200, { ...saved, description: describeBias(saved.bias) });
  });

  router.delete('/api/studio/logit/:id', (ctx) => ctx.json(200, { removed: store().logit.remove(ctx.params.id) }));

  /** 合并几套预设（含内置），得到最终要发给模型的 bias 表。 */
  router.post('/api/studio/logit/merge', async (ctx) => {
    const body = await readBody(ctx);
    const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
    const chosen = ids.map((id) =>
      BUILTIN_LOGIT_PRESETS.find((preset) => preset.id === id) ?? store().logit.get(id));
    const bias = mergeBias(...chosen.filter(Boolean));
    return ctx.json(200, { bias, description: describeBias(bias) });
  });

  // ------------------------------------------------------------ 导出 / 抓料

  router.post('/api/studio/export/html', async (ctx) => {
    const body = await readBody(ctx);
    const chatId = body.chatId ? String(body.chatId) : null;
    let messages = Array.isArray(body.messages) ? body.messages : null;
    let card = body.card ?? {};
    if (chatId && deps.chatStore?.listMessages) {
      messages = messages ?? (await Promise.resolve(deps.chatStore.listMessages(chatId))) ?? [];
      if (!body.card && deps.chatStore.getChat) {
        const chat = await Promise.resolve(deps.chatStore.getChat(chatId));
        card = chat?.card ?? card;
      }
    }
    if (!messages) throw new ValidationError('需要 chatId 或 messages');
    const title = String(body.title ?? card.name ?? '对话');
    const html = chatToHtml({ title, card, messages, meta: { exportedAt: new Date().toISOString().slice(0, 16).replace('T', ' ') } });
    if (body.format === 'markdown') return ctx.json(200, { markdown: chatToMarkdown({ title, card, messages }) });
    return ctx.json(200, { html, title, count: messages.length });
  });

  /** 抓网页 → 干净文本（只抓，不生成；生成交给写卡助手）。 */
  router.post('/api/studio/source/fetch', async (ctx) => {
    const body = await readBody(ctx);
    const url = normaliseUrl(body.url, { allowPrivate: Boolean(body.allowPrivate) });
    const response = await httpFetch(url.href, {
      headers: { 'User-Agent': 'SilverTavern/0.5 (+local roleplay tool)', Accept: 'text/html,application/xhtml+xml' },
      signal: AbortSignal.timeout(Number(body.timeoutMs ?? 15000)),
    });
    if (!response.ok) throw new ValidationError(`抓取失败：HTTP ${response.status}`);
    const contentType = response.headers.get('content-type') ?? '';
    if (!/text\/|html|json|xml/.test(contentType)) throw new ValidationError(`这个地址返回的不是网页（${contentType || '未知类型'}）`);
    const raw = await response.text();
    const { title, text } = htmlToText(raw);
    const limit = Number(body.limit ?? 20000);
    const trimmed = text.slice(0, limit);
    return ctx.json(200, {
      url: url.href,
      title: title || url.hostname,
      text: trimmed,
      truncated: text.length > trimmed.length,
      chunks: chunkText(trimmed, { size: Number(body.chunkSize ?? 1600) }),
      prompt: buildExtractPrompt({ title: title || url.hostname, url: url.href, text: trimmed, want: body.want ?? 'both' }),
    });
  });

  // ------------------------------------------------------------ 记忆 → 世界书

  router.post('/api/studio/worldbook/:bookId/from-memory', async (ctx) => {
    const body = await readBody(ctx);
    const memory = deps.engine?.services?.memory;
    const worldbook = deps.engine?.services?.worldbook;
    if (!memory?.list) throw new ValidationError('记忆服务不可用');
    if (!worldbook?.saveEntry) throw new ValidationError('世界书服务不可用');
    const list = await Promise.resolve(memory.list({ limit: body.limit ?? 200 }));
    const items = Array.isArray(list) ? list : list?.items ?? [];
    const wanted = Array.isArray(body.memoryIds) && body.memoryIds.length
      ? items.filter((item) => body.memoryIds.map(String).includes(String(item.id)))
      : items;
    const { entries, skipped } = memoriesToEntries(wanted, {
      constant: Boolean(body.constant),
      order: Number(body.order ?? 120),
    });
    const saved = [];
    for (const entry of entries) {
      try {
        const record = await worldbook.saveEntry(ctx.params.bookId, entry);
        saved.push({ comment: entry.comment, keys: entry.keys, uid: record?.uid ?? record?.id ?? null });
      } catch (err) {
        skipped.push({ id: entry.extensions?.memoryId ?? null, reason: err?.message ?? String(err) });
      }
    }
    return ctx.json(200, { imported: saved.length, entries: saved, skipped });
  });

  // ------------------------------------------------------------ 思维链拆分

  router.post('/api/studio/reasoning/split', async (ctx) => {
    const body = await readBody(ctx);
    return ctx.json(200, splitReasoning(String(body.text ?? '')));
  });
}
