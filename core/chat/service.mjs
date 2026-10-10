/**
 * 玩卡区服务：对话、群聊、场景状态、叙事控制。
 *
 * 纯逻辑层。数据库与模型网关都以**端口**的形式注入（见 createPlayingServices）：
 *   ports.chatStore       —— 存储。实现见 server/db/chat.mjs
 *   ports.models          —— 模型网关。实现见 server/providers/registry.mjs
 *   ports.resolveBinding  —— 按 群聊成员 > 角色 > 对话 > 全局 解析模型
 *   ports.providerParams  —— 取提供方的采样参数（含单价）
 *   ports.worldbook / ports.memory —— 世界书与记忆的取用（现在是空实现，接口已定）
 *   ports.saveXray        —— 每轮提示词快照
 *
 * 流式协议（与 streamEventTypes() 一致）：
 *   { type:'start', messageId, memberId, characterId, name, model, source }
 *   { type:'delta', text }
 *   { type:'usage', usage, cost }
 *   { type:'done',  messageId, text, usage, cost, message, stateDelta, options }
 *   { type:'error', code, message }
 * 群聊一轮里可能连续出现多组 start→delta→done（列表策略每个人都说一句）。
 */

import { emptyList } from '../contracts.mjs';
import { asyncNotImplemented, ConflictError, NotFoundError, ProviderError, ValidationError } from '../errors.mjs';
import { newId } from '../ids.mjs';
import { estimateTokens, computeCost } from './tokens.mjs';
import { activateMembers, strategyById, GROUP_STRATEGIES, GROUP_MODES, DEFAULT_GROUP_NUDGE } from './group.mjs';
import { assemblePrompt, DEFAULT_SYSTEM_PROMPT } from '../prompts/assemble.mjs';
import { presetSamplingParams } from '../prompts/preset-params.mjs';
import { presetOptions } from '../prompts/preset-options.mjs';
import { applyOutputMarker, presetToolPlan } from '../prompts/preset-tools.mjs';
import { modulePlan } from '../prompts/modules.mjs';
import { splitThinkingTags } from './thinking.mjs';
import { describeBond } from './bond.mjs';
import {
  applyStateDelta,
  emptyWorldState,
  parseStateDelta,
  rollDice,
  STATE_INSTRUCTION,
  STATE_PANELS,
} from './state.mjs';
import {
  buildDirectorMessage,
  branchTitle,
  DIRECTOR_MODES,
  fallbackOptions,
  OPTION_COUNT_DEFAULT,
  OPTIONS_INSTRUCTION,
  parseOptions,
} from './narration.mjs';
import { chatFileJsonl, chatFileRich, parseChatFile } from './chatfile.mjs';
import { buildChapters, chapterFor, newChapterId, normaliseChapters, removeChapter, upsertChapter } from './chapters.mjs';
import { DEFAULT_EVENTS, formatEventMessage, normaliseEventSettings, pickRandomEvent, shouldFire } from './events.mjs';
import { normaliseEndings, recordEnding } from '../staging/show.mjs';
import { collectScripts, getRegexedString, regex_placement } from '../prompts/regex.mjs';

export const STREAM_EVENT_TYPES = ['start', 'delta', 'thinking', 'tool_start', 'usage', 'done', 'error'];

const NEEDS_STORE = '玩卡区需要存储端口：请通过 createEngine({ ports }) 注入 server 的 chat store';

function clone(value) {
  return JSON.parse(JSON.stringify(value ?? {}));
}

/**
 * 组装四个服务，共享同一份依赖。
 * @param {{settings?:object, ports?:object}} options
 */
export function createPlayingServices({ settings = {}, ports = {} } = {}) {
  const ctx = {
    settings,
    store: ports.chatStore ?? null,
    models: ports.models ?? null,
    resolveBinding: ports.resolveBinding ?? null,
    providerParams: ports.providerParams ?? (() => ({})),
    // 预设里搬来的采样参数：按提供方的适配器过滤（预设是给别的后端写的，
    // 有些字段发过去会被拒）。端口没接就原样用。
    presetParams: ports.presetParams ?? ((_providerId, params) => params ?? {}),
    worldbook: ports.worldbook ?? null,
    memory: ports.memory ?? null,
    // 每轮的 databank 召回（参考资料 / 历史 / 记忆片段）。注意这里是白名单：
    // 端口不加进来，collectRecall 会直接静默返回空 —— 上一版就是这样"接口都在、线没接"。
    databank: ports.databank ?? null,
    saveXray: ports.saveXray ?? null,
    // 出图触发（ComfyUI）：消息落库后问一句"这一轮要不要出图"。
    // 是可选端口，没接工具箱时聊天照常。
    imageTrigger: ports.imageTrigger ?? null,
    outfitTrigger: ports.outfitTrigger ?? null,
    // 用量记账：每轮的真实 token 与花费单独落一条，统计不再依赖消息还在不在。
    recordUsage: ports.recordUsage ?? null,
    // 对话上挂的提示词预设（chat.settings.presetId）。没接上就退回内置的默认组装。
    getPreset: ports.getPreset ?? null,
    // 对话上挂的模块（Mod，chat.settings.modules）。同样是白名单：不加进来，
    // 模块的提示词就静默插不进去，而接口那边看起来一切正常。
    getModule: ports.getModule ?? null,
    moduleTrust: ports.moduleTrust ?? null,
    // 存下来、启用的正则脚本（发送前改用户输入 / 收到后改 AI 输出）。来源：提示词服务。
    regexScripts: ports.getRegexScripts ?? null,
    // 抽签（随机事件 / 骰子）。测试里能给一个确定性的实现。
    random: ports.random ?? Math.random,
    logger: ports.logger ?? console,
  };
  const services = {
    chat: createChatService(ctx),
    group: createGroupService(ctx),
    state: createStateService(ctx),
    narration: createNarrationService(ctx),
  };
  // 服务之间互相调用（群聊的自动模式要用 chat.plan，叙事的分支要用 chat.branch）。
  Object.assign(ctx, services);
  return services;
}

function requireStore(ctx) {
  if (!ctx.store) throw new ProviderError(NEEDS_STORE);
  return ctx.store;
}

function chatSettings(chat) {
  return { userName: 'User', ...(chat?.settings ?? {}) };
}

function personaOf(chat) {
  const persona = chat?.persona ?? {};
  return { name: persona.name || 'User', description: persona.description ?? '' };
}

function primaryMember(chat) {
  const members = chat?.members ?? [];
  return members.find((member) => !member.muted) ?? members[0] ?? null;
}

function buildSpeakerInfo(member, resolved) {
  return {
    memberId: member?.id ?? null,
    characterId: member?.characterId ?? null,
    name: member?.name ?? '角色',
    model: resolved?.model ?? null,
    providerId: resolved?.providerId ?? null,
    source: resolved?.source ?? 'none',
    sourceTitle: resolved?.sourceTitle ?? '未绑定',
  };
}

async function collectWorldbook(ctx, { chatId, text, history, member, variables, scanSources, extraBooks = [] }) {
  if (!ctx.worldbook?.activate) return [];
  try {
    const result = await ctx.worldbook.activate({
      chatId,
      text,
      messages: history,
      characterId: member?.characterId ?? null,
      variables,
      scanSources,
      // 卡内嵌的世界书（data.character_book）跟着这张卡一起扫描；
      // 模块自带的世界书条目也一起（模块挂在这个对话上，就等于这本小世界书也在场）
      embedBooks: [...(member?.card?.character_book ? [member.card.character_book] : []), ...extraBooks],
    });
    return Array.isArray(result?.entries) ? result.entries : [];
  } catch (err) {
    ctx.logger?.debug?.(`世界书激活失败：${err?.message ?? err}`);
    return [];
  }
}

function numberSetting(ctx, key, fallback) {
  const value = Number(ctx.settings?.[key]);
  return Number.isFinite(value) ? value : fallback;
}

function smallLimitOf(ctx) {
  return Math.max(0, Math.min(50, numberSetting(ctx, 'recall.memorySmall', 3)));
}

function recallTopOf(ctx) {
  return Math.max(0, Math.min(10, numberSetting(ctx, 'recall.memoryTop', 2)));
}

async function collectMemory(ctx, { chatId, member, query = '' }) {
  if (!ctx.memory?.selectForPrompt) return [];
  try {
    const result = await ctx.memory.selectForPrompt({
      chatId,
      characterId: member?.characterId ?? null,
      query,
      recallTop: recallTopOf(ctx),
      includeProfile: ctx.settings?.['recall.includeProfile'] !== false,
      smallLimit: smallLimitOf(ctx),
    });
    return Array.isArray(result?.entries) ? result.entries : [];
  } catch (err) {
    ctx.logger?.debug?.(`记忆取用失败：${err?.message ?? err}`);
    return [];
  }
}

function variableMap(ctx, chatId, member) {
  const rows = ctx.store.listVariables(chatId);
  const map = {};
  for (const row of rows) {
    if (row.scope === 'chat') map[row.key] = row.value;
    else if (row.scope === 'character' && row.characterId && row.characterId === (member?.characterId ?? '')) map[row.key] = row.value;
  }
  return map;
}

function resolveForMember(ctx, { chat, member, input = {} }) {
  if (input.providerId) {
    return { providerId: input.providerId, model: input.model ?? null, params: {}, source: 'explicit', sourceTitle: '指定提供方' };
  }
  if (!ctx.resolveBinding) return { providerId: null, model: null, params: {}, source: 'none', sourceTitle: '未绑定' };
  return ctx.resolveBinding({
    characterId: member?.characterId ?? chat.characterId ?? null,
    chatId: chat.id,
    memberId: member?.id ?? null,
    kind: 'chat',
  });
}

function lastAssistantContent(history) {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === 'assistant') return history[i].content;
  }
  return '';
}

/**
 * 事件驱动的自动总结：每轮写完之后**顺手**看一眼"还有多少条没被总结过"。
 *
 * 为什么不按时间调度：这是个"用时才开"的桌面程序，定时任务在没开的时候根本跑不了，
 * 补跑也常常是空跑。事件驱动没有"错过"这回事 —— 不玩就没新消息、不需要总结；
 * 玩的时候进程一定开着。代价只是每轮多一次判断，真要总结时那次模型调用本来也要花。
 *
 * 水位线取"最近一条小总结盖到哪条消息"（记忆里存的是 messageId，翻回 seq 再算积压）。
 * 「工具箱 → 定时任务 → 定时总结」保留，当"防止积压太久"的兜底。
 */
async function maybeAutoSummarize(ctx, chat) {
  try {
    if (!ctx.memory?.summarizeSmall || !ctx.memory?.list) return;
    const settings = chat.settings ?? {};
    if (settings.autoSummary === false) return;
    if (ctx.settings?.['chat.autoSummary'] === false && settings.autoSummary === undefined) return;
    const every = Math.max(4, Math.min(200, Number(settings.autoSummaryEvery) || numberSetting(ctx, 'chat.autoSummaryEvery', 20)));
    const latest = ctx.memory.list({ chatId: chat.id, layer: 'small', limit: 1 })?.items?.[0] ?? null;
    let afterSeq = 0;
    if (latest?.coversTo && ctx.store?.getMessage) {
      afterSeq = Number(ctx.store.getMessage(latest.coversTo)?.seq ?? 0) || 0;
    }
    const backlog = ctx.store.listMessages(chat.id, { afterSeq });
    if (backlog.length < every) return;
    const slice = backlog.slice(-every);
    const result = await ctx.memory.summarizeSmall({
      chatId: chat.id,
      characterId: chat.characterId ?? null,
      messages: slice,
      title: `${chat.title} · 自动总结`,
    });
    ctx.logger?.debug?.(`[自动总结] ${slice.length} 条消息 → ${result?.memory?.id ?? ''}`);
  } catch (err) {
    // 总结失败绝不能让这一轮对话跟着报错
    ctx.logger?.debug?.(`[自动总结] 失败（不影响这一轮）：${err?.message ?? err}`);
  }
}

/** 一轮召回要用的设置（都在「设置 → 召回」里）。 */
function recallConfig(ctx) {
  const ids = ['worldbook', 'databank', 'history', 'memory'];
  return {
    enabled: ctx.settings?.['recall.enabled'] !== false,
    topK: Math.max(1, Math.min(50, numberSetting(ctx, 'recall.topK', 8))),
    historyWindow: Math.max(0, Math.min(20, numberSetting(ctx, 'recall.historyWindow', 4))),
    minScore: Math.max(0, Math.min(1, numberSetting(ctx, 'recall.minScore', 0.1))),
    maxChars: Math.max(200, Math.min(20000, numberSetting(ctx, 'recall.maxChars', 1500))),
    keywordWeight: Math.max(0, Math.min(1, numberSetting(ctx, 'recall.keywordWeight', 0.5))),
    perCollection: Math.max(0, Math.min(20, numberSetting(ctx, 'recall.perCollection', 0))),
    maxScan: Math.max(500, Math.min(50000, numberSetting(ctx, 'recall.maxScan', 20000))),
    rewrite: ctx.settings?.['recall.rewrite'] === true,
    diversify: ctx.settings?.['recall.diversify'] !== false,
    decay: ctx.settings?.['recall.decay'] !== false,
    // 世界书默认不在这里召回：它自己有语义触发（写卡区 → 世界书），
    // 两边都开会让同一段内容在一轮里进两次，白占上下文。
    collections: ids.filter((id) => (id === 'worldbook' ? ctx.settings?.[`recall.${id}`] === true : ctx.settings?.[`recall.${id}`] !== false)),
    weights: {
      worldbook: numberSetting(ctx, 'recall.weight.worldbook', 1),
      databank: numberSetting(ctx, 'recall.weight.databank', 1),
      history: numberSetting(ctx, 'recall.weight.history', 0.9),
      memory: numberSetting(ctx, 'recall.weight.memory', 1.1),
    },
  };
}

/** 查询文本：当前输入 + 最近几条消息（拼成一段，和当前话题一起当检索词）。 */
export function buildRecallQueries({ text = '', history = [], window = 4 } = {}) {
  const queries = [];
  const current = String(text ?? '').trim();
  if (current) queries.push(current);
  const recent = history
    .slice(-Math.max(0, window))
    .map((message) => String(message?.content ?? '').trim())
    .filter(Boolean);
  if (recent.length) queries.push(recent.join('\n'));
  return queries;
}

/**
 * 可选的查询改写：借同一个聊天模型把查询扩成几条检索词。
 *
 * 默认**关**（每轮多一次模型调用，是要花时间和钱的），在「设置 → 召回」里打开。
 * 失败一律原样返回 —— 改写只是加分项，不能让一轮对话因为改写失败而崩。
 */
async function rewriteQueries(ctx, { queries = [], resolved = null } = {}) {
  if (!ctx.models?.chat || !resolved?.providerId || !queries.length) return queries;
  const prompt = [
    '下面是一段角色扮演对话的要点，帮我提炼 3 条用于检索资料库的短查询。',
    '每行一条，只写查询本身，不要编号、不要解释、不要超过 20 个字。',
    '',
    queries.join('\n'),
  ].join('\n');
  let out = '';
  try {
    for await (const chunk of ctx.models.chat(resolved.providerId, {
      model: resolved.model ?? null,
      system: '你是检索助手，只输出查询词。',
      messages: [{ role: 'user', content: prompt }],
      params: {},
    })) {
      if (chunk.type === 'text') out += chunk.text;
      if (out.length > 600) break;
    }
  } catch (err) {
    ctx.logger?.debug?.(`查询改写失败，用原查询：${err?.message ?? err}`);
    return queries;
  }
  const extra = out
    .split('\n')
    .map((line) => line.replace(/^[\s\-*\d.、)）]+/, '').trim())
    .filter((line) => line && line.length <= 40)
    .slice(0, 3);
  return [...queries, ...extra];
}

/**
 * 把"和眼前这段话相关"的片段交给提示词的 databank 段。
 *
 * 这是以前缺的那根线：assemblePrompt 支持 databankEntries，但没有任何调用方传过它，
 * 所以"参考资料"这一段在真实对话里永远是空的 —— 索引建了，没人用。
 */
async function collectRecall(ctx, { text = '', history = [], resolved = null } = {}) {
  const config = recallConfig(ctx);
  if (!config.enabled || !ctx.databank?.recall) return { entries: [], stats: null, queries: [] };
  let queries = buildRecallQueries({ text, history, window: config.historyWindow });
  if (!queries.length) return { entries: [], stats: null, queries: [] };
  if (config.rewrite) queries = await rewriteQueries(ctx, { queries, resolved });
  // 最近这几条消息本来就在上下文窗口里，别再作为"历史"召回来一份
  const excludeSourceIds = history.slice(-Math.max(0, config.historyWindow)).map((message) => message?.id).filter(Boolean);
  try {
    const result = await ctx.databank.recall({
      queries,
      collections: config.collections,
      collectionWeights: config.weights,
      topK: config.topK,
      minScore: config.minScore,
      maxChars: config.maxChars,
      keywordWeight: config.keywordWeight,
      perCollection: config.perCollection,
      diversify: config.diversify,
      decay: config.decay,
      maxScan: config.maxScan,
      excludeSourceIds,
    });
    return { entries: result?.entries ?? [], stats: result?.stats ?? null, queries };
  } catch (err) {
    ctx.logger?.debug?.(`召回失败：${err?.message ?? err}`);
    return { entries: [], stats: null, queries };
  }
}

/** 一轮生成的公共部分。群聊的每个人、单聊的回复都走它。 */
async function* generateTurn(ctx, { chat, member, kind = 'reply', input = {} }) {
  const resolved = resolveForMember(ctx, { chat, member, input });
  if (!resolved.providerId) {
    throw new ProviderError('还没有可用的模型：去「模型接入」加一个，并把它设为默认，或绑到这个角色 / 群聊成员上');
  }
  if (!ctx.models?.chat) throw new ProviderError('模型网关没有注入');

  const settings = chatSettings(chat);
  const history = ctx.store.listMessages(chat.id);
  const variables = variableMap(ctx, chat.id, member);
  const text = input.text ?? '';

  // 模块（Mod）：挂在对话上的零件。提示词按位置插进提示词、样式与沙箱面板走接口那边，
  // 世界书条目 / 正则脚本 / 背景图这三样并进这一轮（下面分别接）。
  const attachedModules = (Array.isArray(chat.settings?.modules) ? chat.settings.modules : [])
    .map((id) => {
      try {
        return ctx.getModule?.(id) ?? null;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const modulePlanResult = attachedModules.length
    ? modulePlan(attachedModules, { trustOf: (id) => ctx.moduleTrust?.(id) ?? null })
    : null;

  const worldbookEntries = await collectWorldbook(ctx, {
    chatId: chat.id,
    text,
    history: history.map((message) => ({ role: message.role, content: message.content, name: message.name ?? null })),
    member,
    variables,
    // 模块带的世界书条目：当成"随模块挂上来的卡内世界书"，走同一套关键词 / 触发规则
    extraBooks: modulePlanResult?.embedBooks ?? [],
    scanSources: {
      personaDescription: personaOf(chat).description,
      characterDescription: member?.card?.description ?? '',
      characterPersonality: member?.card?.personality ?? '',
      scenario: member?.card?.scenario ?? '',
      creatorNotes: member?.card?.creator_notes ?? '',
    },
  });
  // 记忆：基线（最近/钉住/最新大总结）+ 按当前输入相关性补充的旧总结与结构化档案
  const memories = await collectMemory(ctx, { chatId: chat.id, member, query: text });
  // 召回：世界书之外的参考资料 / 历史 / 记忆，喂给提示词的 databank 段（以前这段永远是空的）
  const recall = await collectRecall(ctx, { text, history, resolved });
  if (recall.entries.length) {
    ctx.logger?.debug?.(
      `召回 ${recall.entries.length} 段（扫 ${recall.stats?.scanned ?? 0} 条，后端 ${recall.stats?.backend ?? 'builtin'}，占 ${recall.stats?.chars ?? 0} 字）`,
    );
  }

  // 对话可以挂一个提示词预设（酒馆预设）：挂了就走 preset 队列，没挂就用内置组装。
  const presetId = chat.settings?.presetId ?? null;
  let preset = null;
  if (presetId && ctx.getPreset) {
    try {
      preset = ctx.getPreset(presetId);
    } catch (err) {
      ctx.logger?.debug?.(`读取提示词预设失败：${err?.message ?? err}`);
    }
  }
  // 预设顶层那些"流程 / 形状"字段（继续提示词、扮演提示词、格式模板、系统提示词开关…）。
  // 我们界面上显式设过的东西优先 —— 预设只当兜底，不会把你手填的覆盖掉。
  const presetOpts = preset ? presetOptions(preset) : {};

  const injections = [];
  if (settings.stateEnabled !== false && kind !== 'impersonate') injections.push(STATE_INSTRUCTION);
  if (chat.settings?.directorInjection) injections.push(`【导演指令】${chat.settings.directorInjection}`);
  if (kind === 'options') injections.push(OPTIONS_INSTRUCTION);
  if (kind === 'continue') {
    injections.push(settings.continueNudge ?? presetOpts.continueNudge ?? '[接着上一条继续写，不要重复已经写过的内容。]');
  }
  if (kind === 'impersonate') {
    injections.push(settings.impersonateNudge ?? presetOpts.impersonateNudge ?? '[替我写一句我会说的话，只写一句话，不要加引号。]');
  }
  if (input.injection) injections.push(input.injection);

  // 羁绊：让角色知道"你们认识多久了、上次见面是什么时候"，而不是每次都像第一次见面。
  // 可关（设置 → 对话 → 羁绊提示）；没历史、算不出来就跳过，绝不影响这一轮。
  const bondKey = member?.characterId ?? member?.id ?? null;
  if (kind !== 'impersonate' && ctx.settings?.['chat.bondContext'] !== false && bondKey && ctx.store?.bondStats) {
    try {
      const stats = ctx.store.bondStats(bondKey);
      const line = describeBond({ ...(stats ?? {}), name: member?.card?.name ?? member?.name, now: new Date() });
      if (line) injections.push(line);
    } catch {
      // 统计失败就当没有这段，不打断生成
    }
  }

  // 继续：预设 continue_prefill 说"带上最后一条"，continue_postfix 是后缀（默认一个空格）
  const continueBase = presetOpts.continuePrefill === false ? '' : lastAssistantContent(history);
  const prefill =
    kind === 'continue'
      ? `${continueBase}${presetOpts.continuePostfix ?? ''}`
      : String(settings.prefill ?? presetOpts.prefill ?? '');
  // 完整正则链：全局（存储里启用的）→ 角色卡 → 预设，外加对话级的设置。
  // 同一条链既用于"发送前改用户输入"，也用于"收到后改 AI 输出"（见下面的后处理）。
  const regexScripts = collectScripts({
    // 模块带来的正则也并进这条链（挂在这个对话上就该生效；别人的模块要信任过，见 core/prompts/modules.mjs）
    global: [
      ...(ctx.regexScripts?.() ?? []),
      ...(modulePlanResult?.regexScripts ?? []),
      ...(Array.isArray(settings.regexScripts) ? settings.regexScripts : []),
    ],
    character: member?.card ?? null,
    preset,
  });
  const assembled = assemblePrompt({
    card: member?.card ?? {},
    preset,
    groupMembers: chat.isGroup ? chat.members : null,
    groupMode: chat.groupMode,
    persona: personaOf(chat),
    history,
    settings: {
      ...settings,
      // 历史窗口 / 上下文预算：对话里没显式设就跟「设置 → 对话」的全局值
      historyLimit: settings.historyLimit ?? numberSetting(ctx, 'chat.historyLimit', 60),
      contextBudget: settings.contextBudget ?? numberSetting(ctx, 'chat.contextBudget', 0),
      prefill,
      groupNudge: settings.groupNudge ?? presetOpts.groupNudge ?? DEFAULT_GROUP_NUDGE,
      regexScripts,
      // 预设的"形状"开关（对话里显式设过的优先）
      useSystemPrompt: settings.useSystemPrompt ?? presetOpts.useSystemPrompt,
      squashSystemMessages: settings.squashSystemMessages ?? presetOpts.squashSystemMessages,
      formatTemplates: settings.formatTemplates ?? presetOpts.formats,
      contextBudget: settings.contextBudget ?? presetOpts.contextBudget,
      // 模块（Mod）的提示词：按位置插（组装那边负责真插）
      modules: modulePlanResult?.promptByPosition ?? null,
    },
    worldState: chat.worldState,
    variables,
    worldbookEntries,
    memories,
    databankEntries: recall.entries,
    injection: injections.join('\n\n'),
  });

  // 预设自带的采样参数（sampling 那一堆）搬进来。它只当"底"：
  // 模型绑定 / 对话设置 / 单次请求里显式填的照样覆盖它。
  const presetParamMode = chat.settings?.presetParams ?? 'common';
  const presetParams = preset ? ctx.presetParams(resolved.providerId, presetSamplingParams(preset, presetParamMode)) : {};
  if (Object.keys(presetParams).length) {
    const detail = Object.entries(presetParams).map(([key, value]) => `${key}=${Array.isArray(value) ? value.join('/') : value}`).join('、');
    assembled.notes.push(`沿用预设的采样参数（${presetParamMode === 'all' ? '全部' : '常用'}）：${detail}`);
  }
  // 预设顶层的传输 / 推理设置（同样是"最底一层"，你手填的照样盖得住）
  // "参数：不用预设的"档位把预设带来的参数全关掉（采样 + 传输 + 回复上限），只留提示词那边的东西
  const presetConfig = {};
  if (presetParamMode !== 'off') {
    if (presetOpts.streamMode) presetConfig.streamMode = presetOpts.streamMode;
    if (presetOpts.reasoningEffort) presetConfig.reasoning_effort = presetOpts.reasoningEffort;
    if (presetOpts.verbosity) presetConfig.verbosity = presetOpts.verbosity;
    if (presetOpts.maxTokens) presetConfig.max_tokens = presetOpts.maxTokens;
  }
  if (Object.keys(presetConfig).length) {
    const detail = Object.entries(presetConfig).map(([key, value]) => `${key}=${value}`).join('、');
    assembled.notes.push(`沿用预设的顶层设置：${detail}`);
  }

  // ---- 函数调用（工具）预备 ------------------------------------------------
  // 预设写 function_calling: true 时，工具定义来自预设自己
  // （extensions.SPreset.ToolBindings）。为什么是这么绕的一条路，见
  // core/prompts/preset-tools.mjs 顶部的说明。
  const toolPlan = preset ? presetToolPlan(preset) : null;
  const toolKindsAllowed = !['impersonate', 'continue', 'options'].includes(kind);
  const toolsActive = Boolean(
    toolPlan?.enabled && toolPlan.tools.length && toolKindsAllowed && presetParamMode !== 'off',
  );
  if (toolPlan?.enabled) {
    if (toolsActive) {
      const names = toolPlan.tools.map((tool) => tool.name).join('、');
      assembled.notes.push(
        `函数调用：可用工具 ${names}${toolPlan.consumeToolCalls ? '（工具调用的参数直接作为正文，不再二次生成）' : '（工具结果回填后继续生成）'}`,
      );
    } else if (!toolKindsAllowed) {
      assembled.notes.push('函数调用：这一轮（续写 / 替写 / 选项）不带工具');
    } else if (presetParamMode === 'off') {
      assembled.notes.push('函数调用：参数档位选了「不用预设的」，工具一并关掉');
    } else {
      assembled.notes.push('函数调用：预设开了，但没解析出可用的工具定义，按普通回复处理');
    }
  }
  for (const note of toolPlan?.notes ?? []) assembled.notes.push(`函数调用：${note}`);

  const messageId = newId('msg');
  const info = buildSpeakerInfo(member, resolved);
  yield { type: 'start', messageId, kind, ...info };

  let raw = '';
  let reasoning = '';
  let usage = null;
  let finish = null;
  let imageTrigger = null;
  let outfitSwitch = null;
  // 工具结果回填用的临时记录：assistant 带 tool_calls，紧跟每个工具的结果。
  const transcript = [];
  const toolRounds = [];
  const maxRounds = toolsActive ? (toolPlan.consumeToolCalls ? 1 : toolPlan.recurseLimit + 1) : 1;
  try {
    for (let round = 0; round < maxRounds; round++) {
      let roundText = '';
      let calls = [];
      for await (const chunk of ctx.models.chat(resolved.providerId, {
        model: input.model ?? resolved.model ?? null,
        system: assembled.system,
        messages: transcript.length ? [...assembled.messages, ...transcript] : assembled.messages,
        // 优先级：预设 < 提供方默认（网关里合） < 模型绑定 < 对话设置 < 单次请求
        params: { ...presetConfig, ...(presetParams ?? {}), ...(resolved.params ?? {}), ...(settings.params ?? {}), ...(input.params ?? {}) },
        tools: toolsActive ? toolPlan.tools : null,
        toolChoice: toolsActive ? 'auto' : null,
        signal: input.signal,
      })) {
        if (chunk.type === 'text') {
          roundText += chunk.text;
          // 中间那几轮的文字不算数（模型往往只在说"我要调用工具"），只有最后一轮边收边显示。
          if (round === maxRounds - 1) yield { type: 'delta', text: chunk.text };
        } else if (chunk.type === 'thinking') {
          // 提供方单独给的思维链（DeepSeek-R1 的 reasoning_content、Anthropic 的 thinking…）
          reasoning += chunk.text;
          yield { type: 'thinking', text: chunk.text };
        } else if (chunk.type === 'usage') {
          usage = chunk.usage;
        } else if (chunk.type === 'finish') {
          finish = chunk.reason ?? null;
        } else if (chunk.type === 'tool_start') {
          yield { type: 'tool_start', name: chunk.name };
        } else if (chunk.type === 'tool_calls') {
          calls = chunk.calls ?? [];
        }
      }

      if (!toolsActive || !calls.length) {
        raw = roundText;
        break;
      }

      toolRounds.push({ round: round + 1, calls });
      if (toolPlan.consumeToolCalls) {
        // 工具调用的参数就是这一轮的正文；思维链会被包成 <think_nya~>，交给下面既有的摘取逻辑。
        const formatted = toolPlan.format(calls);
        for (const note of formatted.notes) assembled.notes.push(`函数调用：${note}`);
        raw = [formatted.text, roundText].filter(Boolean).join('\n\n');
        if (raw) yield { type: 'delta', text: raw };
        break;
      }

      if (round === maxRounds - 1) {
        assembled.notes.push('函数调用：已经到预设允许的工具轮数上限，这一轮的文字直接当回复');
        raw = roundText;
        break;
      }

      // 回填：我们的内部记录是 OpenAI 形状，Anthropic / Gemini 由适配器自己翻译。
      // 预设里的工具动作都是空操作（`return JSON.stringify({ ok: true })`），这里照做，
      // 不执行预设里的 JS——本项目全局不 eval 不可信代码。
      transcript.push({
        role: 'assistant',
        content: roundText || '',
        tool_calls: calls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
        })),
      });
      for (const call of calls) {
        transcript.push({
          role: 'tool',
          tool_call_id: call.id,
          name: call.name,
          content: JSON.stringify({ ok: true }),
        });
      }
    }
  } catch (err) {
    yield { type: 'error', code: err?.code ?? 'PROVIDER_ERROR', message: String(err?.message ?? err) };
    return;
  }

  // 预设的 OutputPreprocessing 只认标记之后的内容（作者用它挡掉模型开头那段碎碎念）。
  if (toolPlan?.outputMarker && raw) {
    const marked = applyOutputMarker(raw, toolPlan.outputMarker);
    if (marked.trimmed) {
      raw = marked.text;
      assembled.notes.push(`函数调用：按预设丢掉了 ${toolPlan.outputMarker} 之前的内容`);
    }
  }

  // 正文里带标签的思维链（酒馆预设爱用 <think_nya~> 这种）：先摘出来再走正则链，
  // 否则预设那条"把思维链折成 HTML"的正则会把一整页 HTML 留在正文里。
  const splitRaw = splitThinkingTags(raw);
  if (splitRaw.thinking) reasoning = [splitRaw.thinking, reasoning].filter(Boolean).join('\n\n');
  raw = splitRaw.text;

  // 收到后的正则链（AI_OUTPUT）先跑一道：会被存下来、也会进后续历史。
  const processedRaw = regexScripts.length
    ? getRegexedString(raw, regex_placement.AI_OUTPUT, { scripts: regexScripts, isPrompt: true, characterOverride: member?.name ?? null, depth: 0 })
    : raw;
  // 先摘 ```state，再摘 ```options，剩下的才是给人看的正文。
  const parsedState = parseStateDelta(processedRaw);
  const withoutState = parsedState.found ? parsedState.text : processedRaw;
  const parsedOptions = parseOptions(withoutState);
  const content = parsedOptions.text;
  // "只改显示"的脚本单独跑一遍，存进 extra.displayContent，前端渲染时优先用它。
  const displayContent = regexScripts.length
    ? getRegexedString(content, regex_placement.AI_OUTPUT, { scripts: regexScripts, isMarkdown: true, characterOverride: member?.name ?? null, depth: 0 })
    : content;
  const tokens = usage?.completionTokens ?? estimateTokens(content);
  const cost = computeCost(usage, ctx.providerParams(resolved.providerId, resolved.model ?? null));

  const message = ctx.store.appendMessage(chat.id, {
    id: messageId,
    role: kind === 'impersonate' ? 'user' : 'assistant',
    characterId: member?.characterId ?? null,
    memberId: member?.id ?? null,
    name: member?.name ?? '角色',
    content: kind === 'impersonate' ? processedRaw.trim() : content,
    swipes: [kind === 'impersonate' ? processedRaw.trim() : content],
    swipeId: 0,
    tokens,
    cost,
    model: resolved.model ?? null,
    providerId: resolved.providerId,
    extra: {
      usage,
      finish,
      // 思维链：单独存一份，界面默认折叠显示，不参与组装（不进上下文）
      reasoning: reasoning.trim() || undefined,
      stateDelta: parsedState.ok ? parsedState.delta : null,
      stateError: parsedState.error,
      source: resolved.source,
      promptTokens: assembled.tokens.total,
      promptNotes: assembled.notes,
      displayContent: displayContent !== content ? displayContent : undefined,
      // 工具调用记录：留给界面和 X 光机看"这轮到底调了什么"。consume 模式下正文本身就是
      // 工具调用，预设作者的本意是别让它在聊天里再占一块，所以带一个 hidden 标记。
      toolCalls: toolRounds.length ? toolRounds : undefined,
      toolCallsHidden: toolRounds.length && toolPlan?.consumeToolCalls ? true : undefined,
    },
  });

  if (kind !== 'impersonate' && parsedState.ok && parsedState.delta) {
    const nextState = applyStateDelta(chat.worldState, parsedState.delta);
    ctx.store.updateChat(chat.id, { worldState: nextState });
    for (const [key, value] of Object.entries(parsedState.delta.variables ?? {})) {
      ctx.store.setVariable(chat.id, { scope: 'chat', key, value });
    }
  }
  if (parsedOptions.options.length) {
    ctx.store.saveActions(chat.id, { messageId, options: parsedOptions.options });
  }
  if (chat.settings?.directorInjection) {
    // 导演指令只影响这一轮，用完就清掉
    const next = { ...chat.settings };
    delete next.directorInjection;
    ctx.store.updateChat(chat.id, { settings: next });
  }
  if (ctx.saveXray) {
    try {
      ctx.saveXray({
        chatId: chat.id,
        characterId: member?.characterId ?? null,
        sections: assembled.sections,
        text: [assembled.system, ...assembled.messages.map((item) => `${item.role}: ${item.content}`)].join('\n\n'),
        tokens: assembled.tokens,
        notes: assembled.notes,
        model: resolved.model ?? null,
      });
    } catch (err) {
      ctx.logger?.debug?.(`提示词快照写入失败：${err?.message ?? err}`);
    }
  }

  // 出图触发（蓝图 3.1 的"半自动 / 全自动"）：消息已经落库，这里问一句要不要出图。
  // 提交本身很快（ComfyUI 的 /prompt 立刻返回 prompt_id），但为了绝不影响聊天，
  // 失败一律吞掉只记日志。
  if (ctx.imageTrigger && kind !== 'impersonate' && kind !== 'options') {
    try {
      imageTrigger = await ctx.imageTrigger({
        chatId: chat.id,
        messageId,
        memberId: member?.id ?? null,
        characterId: member?.characterId ?? null,
        memberName: member?.name ?? null,
        content: message.content,
        stateDelta: parsedState.ok ? parsedState.delta : null,
        kind,
      });
    } catch (err) {
      ctx.logger?.debug?.(`出图触发失败：${err?.message ?? err}`);
    }
  }

  // 剧情换装（和出图触发同一个位置）：AI 写了 [换装: 套装名] 就把它身上那套换掉。
  if (ctx.outfitTrigger && kind !== 'impersonate' && kind !== 'options') {
    try {
      outfitSwitch = await ctx.outfitTrigger({
        chatId: chat.id,
        messageId,
        memberId: member?.id ?? null,
        characterId: member?.characterId ?? null,
        content: message.content,
        kind,
      });
    } catch (err) {
      ctx.logger?.debug?.(`换装标记处理失败：${err?.message ?? err}`);
    }
  }

  // 记账（蓝图 3.2）：真实用量 + 我们的估算一起记，才能做"预估 vs 实际"。
  // 提供方没报 usage 时，用估算值兜底，但标记 reported=false，界面上能区分开。
  if (ctx.recordUsage) {
    try {
      ctx.recordUsage({
        chatId: chat.id,
        characterId: member?.characterId ?? null,
        memberId: member?.id ?? null,
        providerId: resolved.providerId ?? null,
        model: resolved.model ?? null,
        kind,
        source: resolved.source ?? null,
        usage: usage ?? { promptTokens: assembled.tokens.total, completionTokens: tokens, totalTokens: assembled.tokens.total + tokens },
        reported: Boolean(usage),
        estPromptTokens: assembled.tokens.total,
        estCompletionTokens: estimateTokens(content),
      });
    } catch (err) {
      ctx.logger?.debug?.(`用量记账失败：${err?.message ?? err}`);
    }
  }

  yield {
    type: 'usage',
    usage: usage ?? { promptTokens: assembled.tokens.total, completionTokens: tokens, totalTokens: assembled.tokens.total + tokens },
    cost,
  };
  // 这一轮写完了：顺手看一眼积压够不够一条小总结（不 await，不挡流式输出）
  void maybeAutoSummarize(ctx, chat);
  yield {
    type: 'done',
    messageId,
    text: message.content,
    usage,
    cost,
    message,
    stateDelta: parsedState.ok ? parsedState.delta : null,
    options: parsedOptions.options,
    imageTrigger,
      outfitSwitch,
    ...info,
  };
}

// ---------------------------------------------------------------- 对话服务

function createChatService(ctx) {
  const store = () => requireStore(ctx);

  /**
   * 每个对话同一时刻只允许一条生成在跑。
   *
   * 界面自己会用 busy 标志挡住重复点击，但两个标签页 / API 直接调 / MCP 都能
   * 对同一个 chatId 同时发起生成；没有这道闸时两次生成的用户消息会先各落一条、
   * 两条回复再按完成顺序追加，转录变成「用户A、用户B、回复A、回复B」，顺序就错了。
   * 这一份 Set 在服务闭包里，所以是按租户隔离的。
   */
  const generating = new Set();

  async function* locked(id, producer) {
    if (generating.has(id)) {
      throw new ConflictError('这个对话正在生成中：等这一轮结束，或者先停掉再试');
    }
    generating.add(id);
    try {
      yield* producer();
    } finally {
      generating.delete(id);
    }
  }

  async function list(query = {}) {
    if (!ctx.store) return emptyList();
    const group = query.group === undefined ? null : query.group === 'true' || query.group === true;
    const characterId = query.characterId ? String(query.characterId) : null;
    const items = ctx.store.listChats({ group, search: query.search ?? '', characterId });
    return { items, total: items.length };
  }

  async function get(id) {
    if (!ctx.store) return null;
    return ctx.store.getChat(id);
  }

  function pickGreeting(card, rng = Math.random) {
    const options = [card?.first_mes, ...(Array.isArray(card?.alternate_greetings) ? card.alternate_greetings : [])].filter((item) => item && String(item).trim());
    if (!options.length) return '';
    return String(options[Math.floor(rng() * options.length)]);
  }

  async function create(input = {}) {
    const s = store();
    const settings = { systemPrompt: DEFAULT_SYSTEM_PROMPT, stateEnabled: true, ...(input.settings ?? {}) };
    const members = Array.isArray(input.members) && input.members.length
      ? input.members
      : input.character
        ? [{ card: input.character, name: input.character.name, characterId: input.characterId }]
        : [];
    const isGroup = Boolean(input.isGroup) || members.length > 1;
    // 允许先建一个空 / 单人群聊，之后去群聊页慢慢加成员（界面就是这么用的）；
    // 真正要凑一桌再开口，那是玩的时候的事，不该卡在建群这一步。

    const chat = s.createChat({
      title: input.title ?? (members[0]?.card?.name ? `${members[0].card.name} 的对话` : '新对话'),
      characterId: input.characterId ?? members[0]?.characterId ?? null,
      persona: input.persona ?? {},
      settings,
      worldState: input.worldState ?? emptyWorldState(),
      isGroup,
      groupStrategy: input.groupStrategy ?? 'natural',
      groupMode: input.groupMode ?? (isGroup ? 'append' : 'swap'),
      autoModeDelay: input.autoModeDelay ?? 5,
    });
    for (const member of members) s.addMember(chat.id, member);
    if (input.greetings !== false) {
      for (const member of s.listMembers(chat.id)) {
        const greeting = pickGreeting(member.card);
        if (greeting) {
          s.appendMessage(chat.id, {
            role: 'assistant',
            characterId: member.characterId,
            memberId: member.id,
            name: member.name,
            content: greeting,
            tokens: estimateTokens(greeting),
          });
        }
      }
    }
    return s.getChat(chat.id);
  }

  async function update(id, patch = {}) {
    const allowed = {};
    for (const key of ['title', 'persona', 'settings', 'groupStrategy', 'groupMode', 'autoModeDelay', 'worldState']) {
      if (patch[key] !== undefined) allowed[key] = patch[key];
    }
    return store().updateChat(id, allowed);
  }

  async function remove(id) {
    return store().deleteChat(id);
  }

  async function messages(id, query = {}) {
    const s = store();
    if (!s.getChat(id)) throw new NotFoundError(`对话 ${id}`);
    const all = s.listMessages(id);
    const limit = query.limit ? Number(query.limit) : null;
    return { items: limit ? all.slice(-limit) : all, total: all.length };
  }

  /** 这个对话里该谁说话 + 他用哪个模型（给界面预览与自动模式用）。 */
  async function plan(id, options = {}) {
    const s = store();
    const chat = s.getChat(id);
    if (!chat) throw new NotFoundError(`对话 ${id}`);
    const history = s.listMessages(id);
    const activated = chat.isGroup
      ? activateMembers({
          members: (chat.members ?? []).filter((member) => !member.muted),
          strategy: chat.groupStrategy,
          messages: history,
          input: options.text ?? '',
          isUserInput: true,
          allowSelfResponses: Boolean(chat.settings?.allowSelfResponses),
          forcedId: options.memberId ?? null,
        })
      : [primaryMember(chat)].filter(Boolean);
    const items = (chat.members ?? []).map((member) => ({
      ...buildSpeakerInfo(member, resolveForMember(ctx, { chat, member, input: {} })),
      muted: member.muted,
      talkativeness: member.talkativeness,
    }));
    return {
      chatId: id,
      strategy: chat.groupStrategy,
      mode: chat.groupMode,
      strategies: GROUP_STRATEGIES,
      modes: GROUP_MODES,
      order: activated.map((member) => member.id),
      items,
      multiModel: new Set(items.map((item) => item.providerId).filter(Boolean)).size > 1,
    };
  }

  async function* sendGroupRound(context, { chat, input }) {
    const s = context.store;
    const history = s.listMessages(chat.id);
    const members = (chat.members ?? []).filter((member) => !member.muted);
    if (!members.length) throw new ValidationError('群聊里没有可发言的成员（都被静音了？）');
    const activated = activateMembers({
      members,
      strategy: chat.groupStrategy,
      messages: history,
      input: input.text ?? '',
      isUserInput: Boolean(input.text),
      allowSelfResponses: Boolean(chat.settings?.allowSelfResponses),
      forcedId: input.memberId ?? null,
    });
    if (!activated.length) {
      yield { type: 'done', messageId: null, text: '', pending: true, note: '手动模式：请指定谁来说这句' };
      return;
    }
    for (const member of activated) {
      yield* generateTurn(context, { chat, member, kind: 'reply', input });
    }
  }

  async function* send(id, input = {}) {
    const s = store();
    const chat = s.getChat(id);
    if (!chat) throw new NotFoundError(`对话 ${id}`);
    let text = String(input.text ?? '').trim();
    // 预设写了 send_if_empty：空着按回车时，把这句话当用户输入发出去（酒馆里就是这个意思）
    if (!text && chat.settings?.presetId && ctx.getPreset) {
      try {
        const preset = ctx.getPreset(chat.settings.presetId);
        const sendIfEmpty = preset ? presetOptions(preset).sendIfEmpty : null;
        if (sendIfEmpty) text = sendIfEmpty;
      } catch (err) {
        ctx.logger?.debug?.(`读取预设的 send_if_empty 失败：${err?.message ?? err}`);
      }
    }
    if (text) {
      s.appendMessage(id, {
        role: 'user',
        name: chat.persona?.name || '我',
        content: text,
        tokens: estimateTokens(text),
        extra: input.extra ?? {},
      });
    }
    // 随机事件：用户发言之后按概率插一条旁白，跟着这一轮一起进上下文（默认关）。
    if (text) {
      try {
        ctx.narration?.maybeFireRandomEvent(id);
      } catch (err) {
        ctx.logger?.debug?.(`随机事件抽签失败：${err?.message ?? err}`);
      }
    }
    const fresh = s.getChat(id);
    if (fresh.isGroup) {
      yield* sendGroupRound(ctx, { chat: fresh, input: { ...input, text } });
      return;
    }
    const member = primaryMember(fresh);
    if (!member) throw new ValidationError('这个对话没有角色，先加一个成员');
    yield* generateTurn(ctx, { chat: fresh, member, kind: input.kind ?? 'reply', input: { ...input, text } });
  }

  async function* regenerate(id, input = {}) {
    const s = store();
    const chat = s.getChat(id);
    if (!chat) throw new NotFoundError(`对话 ${id}`);
    const all = s.listMessages(id);
    const target = input.messageId
      ? all.find((message) => message.id === input.messageId)
      : [...all].reverse().find((message) => message.role === 'assistant');
    if (!target) throw new ValidationError('没有可重新生成的消息');
    const member =
      (chat.members ?? []).find((item) => item.id === target.memberId) ??
      (chat.members ?? []).find((item) => item.characterId === target.characterId) ??
      primaryMember(chat);
    s.deleteMessagesFrom(id, target.id);
    yield* generateTurn(ctx, { chat: s.getChat(id), member, kind: 'reply', input });
  }

  async function* continueTurn(id, input = {}) {
    const s = store();
    const chat = s.getChat(id);
    if (!chat) throw new NotFoundError(`对话 ${id}`);
    const all = s.listMessages(id);
    const last = [...all].reverse().find((message) => message.role === 'assistant');
    if (!last) throw new ValidationError('还没有可以接着写的回复');
    const member = (chat.members ?? []).find((item) => item.id === last.memberId) ?? primaryMember(chat);
    yield* generateTurn(ctx, { chat, member, kind: 'continue', input: { ...input, text: '' } });
  }

  /**
   * 再来一版（swipes）：不删掉原来的回复，把新生成的一版追加成候选。
   *
   * 和酒馆对齐的一点：候选切换只改 content 与 swipe_id，历史里那条消息本身（id / seq）不变，
   * 所以挂在消息上的出图、token、花费统计都还在原处。
   */
  async function* newSwipe(id, input = {}) {
    const s = store();
    const chat = s.getChat(id);
    if (!chat) throw new NotFoundError(`对话 ${id}`);
    const all = s.listMessages(id);
    const target = input.messageId
      ? all.find((message) => message.id === input.messageId)
      : [...all].reverse().find((message) => message.role === 'assistant');
    if (!target) throw new ValidationError('没有可重新生成的消息');
    if (target.role !== 'assistant') throw new ValidationError('只有角色的回复才有候选版本');
    const index = all.findIndex((message) => message.id === target.id);
    const previousId = index > 0 ? all[index - 1].id : null;
    const member =
      (chat.members ?? []).find((item) => item.id === target.memberId) ??
      (chat.members ?? []).find((item) => item.characterId === target.characterId) ??
      primaryMember(chat);

    // 和重生成一样：这一条之后的都要重来（后面的话是基于旧回复写的）
    s.deleteMessagesFrom(id, target.id);

    let fresh = null;
    for await (const event of generateTurn(ctx, { chat: s.getChat(id), member, kind: 'reply', input })) {
      if (event.type === 'done') fresh = event;
      yield event;
    }
    if (!fresh) return;

    const swipes = [...(target.swipes ?? [])];
    if (!swipes.length) swipes.push(String(target.content ?? ''));
    swipes[target.swipeId ?? 0] = String(target.content ?? '');
    swipes.push(String(fresh.text ?? ''));
    const swipeId = swipes.length - 1;

    s.deleteMessage(id, fresh.messageId);
    const restored = s.insertMessageAfter(id, previousId, {
      id: target.id,
      role: 'assistant',
      memberId: target.memberId ?? null,
      characterId: target.characterId ?? null,
      name: target.name ?? '',
      content: swipes[swipeId],
      swipes,
      swipeId,
      tokens: fresh.usage?.completionTokens ?? estimateTokens(swipes[swipeId]),
      cost: fresh.cost ?? null,
      model: fresh.model ?? target.model ?? null,
      providerId: fresh.providerId ?? target.providerId ?? null,
      extra: { ...(target.extra ?? {}), ...(fresh.usage ? { usage: fresh.usage } : {}) },
    });
    yield { type: 'swipe', messageId: target.id, swipes, swipeId, message: restored };
  }

  /** 在已有候选之间来回翻。index 越界会自动绕回去（◀ ▶ 循环）。 */
  async function switchSwipe(id, messageId, input = {}) {
    const s = store();
    const message = s.getMessage(id, messageId);
    if (!message) throw new NotFoundError(`消息 ${messageId}`);
    const swipes = Array.isArray(message.swipes) && message.swipes.length ? message.swipes : [String(message.content ?? '')];
    let index = input.index;
    if (index === undefined || index === null) index = Number(message.swipeId ?? 0) + Number(input.delta ?? 1);
    index = Number(index);
    if (!Number.isFinite(index)) throw new ValidationError('index 要是数字');
    index = ((index % swipes.length) + swipes.length) % swipes.length;
    const content = String(swipes[index] ?? '');
    return s.updateMessage(id, messageId, { swipeId: index, content, swipes, tokens: estimateTokens(content) });
  }

  async function impersonate(id, input = {}) {
    const s = store();
    const chat = s.getChat(id);
    if (!chat) throw new NotFoundError(`对话 ${id}`);
    // 指定 messageId 时表示"这条我来演"：先删掉它，再让模型替我草拟一句。
    if (input.messageId) {
      const existing = s.getMessage(id, input.messageId);
      if (!existing) throw new NotFoundError(`消息 ${input.messageId}`);
      s.deleteMessage(id, input.messageId);
    }
    const member = primaryMember(chat);
    let text = '';
    let usage = null;
    for await (const event of generateTurn(ctx, { chat, member, kind: 'impersonate', input })) {
      if (event.type === 'done') {
        text = event.text;
        usage = event.usage;
      }
      if (event.type === 'error') throw new ProviderError(event.message);
    }
    return { text, usage };
  }

  async function editMessage(id, messageId, patch = {}) {
    const s = store();
    const existing = s.getMessage(id, messageId);
    if (!existing) throw new NotFoundError(`消息 ${messageId}`);
    const clean = { ...patch };
    if (patch.content !== undefined) {
      const swipes = [...(existing.swipes ?? [])];
      if (!swipes.length) swipes.push(String(patch.content));
      swipes[existing.swipeId ?? 0] = String(patch.content);
      clean.swipes = swipes;
      clean.tokens = estimateTokens(patch.content);
    }
    return s.updateMessage(id, messageId, clean);
  }

  async function deleteMessage(id, messageId) {
    return store().deleteMessage(id, messageId);
  }

  /**
   * 往一条消息上挂素材（ComfyUI 出的图 / 上传的参考图）。
   * 浏览器直连模式下由前端上传完素材再调它；服务端 runner 走的是内部 attachImages 端口，
   * 两条路都合并进 `extra.images`（去重），前端画缩略图只认这一个字段。
   */
  async function attachAssets(id, messageId, assetIds = []) {
    const s = store();
    const existing = s.getMessage(id, messageId);
    if (!existing) throw new NotFoundError(`消息 ${messageId}`);
    const list = (Array.isArray(assetIds) ? assetIds : [assetIds]).map((item) => String(item ?? '')).filter(Boolean);
    if (!list.length) throw new ValidationError('要带上至少一个 assetId');
    const current = Array.isArray(existing.extra?.images) ? existing.extra.images : [];
    const merged = [...current];
    for (const assetId of list) {
      const present = merged.some((item) => (typeof item === 'string' ? item : item?.assetId) === assetId);
      if (!present) merged.push(assetId);
    }
    return s.updateMessage(id, messageId, { extra: { ...existing.extra, images: merged } });
  }

  async function insertMessage(id, input = {}) {
    const s = store();
    const chat = s.getChat(id);
    if (!chat) throw new NotFoundError(`对话 ${id}`);
    const content = String(input.content ?? '');
    return s.insertMessageAfter(id, input.afterMessageId ?? null, {
      role: input.role ?? 'user',
      name: input.name ?? (input.role === 'assistant' ? '' : chat.persona?.name || '我'),
      content,
      tokens: estimateTokens(content),
      hidden: input.hidden,
      isSystem: input.isSystem,
      extra: input.extra ?? {},
    });
  }

  /** 从某条消息开分支：复制到这条为止，之后各自发展。 */
  async function branch(id, input = {}) {
    const s = store();
    const source = s.getChat(id);
    if (!source) throw new NotFoundError(`对话 ${id}`);
    const all = s.listMessages(id);
    const index = input.messageId ? all.findIndex((message) => message.id === input.messageId) : all.length - 1;
    if (input.messageId && index < 0) throw new NotFoundError(`消息 ${input.messageId}`);
    const kept = all.slice(0, index + 1);
    const created = s.createChat({
      title: branchTitle(source.title, input.label ?? ''),
      characterId: source.characterId,
      persona: source.persona,
      settings: clone(source.settings),
      worldState: clone(source.worldState),
      isGroup: source.isGroup,
      groupStrategy: source.groupStrategy,
      groupMode: source.groupMode,
      autoModeDelay: source.autoModeDelay,
      parentChatId: source.id,
      branchFromMessageId: input.messageId ?? kept[kept.length - 1]?.id ?? null,
      branchLabel: input.label ?? '',
    });
    for (const member of source.members ?? []) {
      s.addMember(created.id, {
        characterId: member.characterId,
        name: member.name,
        card: member.card,
        talkativeness: member.talkativeness,
        muted: member.muted,
        overrides: member.overrides,
      });
    }
    for (const message of kept) {
      s.appendMessage(created.id, {
        role: message.role,
        characterId: message.characterId,
        name: message.name,
        content: message.content,
        tokens: message.tokens,
        hidden: message.hidden,
        isSystem: message.isSystem,
        swipes: message.swipes,
        swipeId: message.swipeId,
        extra: message.extra,
        createdAt: message.createdAt,
      });
    }
    return s.getChat(created.id);
  }

  async function exportChat(id, { format = 'jsonl' } = {}) {
    const s = store();
    const chat = s.getChat(id);
    if (!chat) throw new NotFoundError(`对话 ${id}`);
    const all = s.listMessages(id);
    const characterName = chat.members?.[0]?.name ?? chat.title;
    const userName = chat.persona?.name || 'User';
    if (format === 'json') {
      return {
        name: `${chat.title}.json`,
        mime: 'application/json',
        text: JSON.stringify(
          chatFileRich({
            title: chat.title,
            settings: chat.settings,
            worldState: chat.worldState,
            character: chat.members?.[0]?.card ?? null,
            persona: chat.persona,
            messages: all,
          }),
          null,
          2,
        ),
      };
    }
    return {
      name: `${chat.title}.jsonl`,
      mime: 'application/x-ndjson',
      text: chatFileJsonl({ messages: all, userName, characterName, settings: chat.settings, createdAt: chat.createdAt }),
    };
  }

  async function importChat(input = {}) {
    const s = store();
    const text = String(input.text ?? '');
    if (!text.trim()) throw new ValidationError('导入需要对话文件的完整内容');
    // 文件本身不合法是"用户输入问题"，要报 400 让人看懂，不是 500。
    let parsed;
    try {
      parsed = parseChatFile(text);
    } catch (err) {
      throw new ValidationError(`导入失败：${err?.message ?? err}`);
    }
    const character = parsed.character ?? { name: parsed.characterName || '角色', first_mes: '' };
    const chat = await create({
      title: input.title || parsed.title || `${character.name} 的对话`,
      character,
      persona: parsed.persona ?? { name: parsed.userName || 'User' },
      settings: parsed.settings ?? {},
      worldState: parsed.worldState ?? emptyWorldState(),
      greetings: false,
    });
    for (const message of parsed.messages) {
      s.appendMessage(chat.id, {
        role: message.role,
        name: message.name,
        content: message.content,
        hidden: message.hidden,
        isSystem: message.role === 'system',
        swipes: message.swipes,
        swipeId: message.swipeId,
        tokens: estimateTokens(message.content),
        extra: message.extra,
        createdAt: message.createdAt,
      });
    }
    return s.getChat(chat.id);
  }

  async function search(query = {}) {
    if (!ctx.store) return emptyList();
    const items = ctx.store.searchMessages({ query: query.q ?? query.query ?? '', limit: query.limit ?? 50 });
    return { items, total: items.length };
  }

  return {
    list,
    get,
    create,
    update,
    remove,
    messages,
    plan,
    // 生成类入口统一套上"同一对话只跑一条"的锁（见上面的 locked）。
    send: (id, input) => locked(id, () => send(id, input)),
    regenerate: (id, input) => locked(id, () => regenerate(id, input)),
    continueTurn: (id, input) => locked(id, () => continueTurn(id, input)),
    newSwipe: (id, input) => locked(id, () => newSwipe(id, input)),
    isGenerating: (id) => generating.has(id),
    impersonate,
    editMessage,
    deleteMessage,
    insertMessage,
    attachAssets,
    branch,
    exportChat,
    importChat,
    search,
    streamEventTypes: () => STREAM_EVENT_TYPES,
    // 多标签"并行"是前端各开一个标签，各自持有 chatId，不需要额外后端接口。
    setSwipes: switchSwipe,
    switchSwipe,
  };
}

// ---------------------------------------------------------------- 群聊服务

function createGroupService(ctx) {
  const store = () => requireStore(ctx);

  function strategies() {
    return GROUP_STRATEGIES;
  }

  function modes() {
    return GROUP_MODES;
  }

  async function list() {
    if (!ctx.store) return emptyList();
    const items = ctx.store.listChats({ group: true });
    return { items, total: items.length };
  }

  async function get(chatId) {
    const chat = store().getChat(chatId);
    if (!chat) throw new NotFoundError(`对话 ${chatId}`);
    if (!chat.isGroup) throw new ValidationError('这不是群聊');
    return chat;
  }

  async function addMember(chatId, input = {}) {
    const s = store();
    if (!s.getChat(chatId)) throw new NotFoundError(`对话 ${chatId}`);
    const card = input.card ?? {};
    if (!input.characterId && !input.name && !card.name) throw new ValidationError('成员需要 characterId 或名字');
    return s.addMember(chatId, {
      characterId: input.characterId ?? null,
      name: input.name ?? card.name ?? '角色',
      card,
      talkativeness: input.talkativeness ?? 0.5,
      muted: Boolean(input.muted),
      overrides: input.overrides ?? {},
    });
  }

  async function updateMember(memberId, patch = {}) {
    const clean = {};
    for (const key of ['name', 'card', 'talkativeness', 'muted', 'orderIndex', 'overrides']) {
      if (patch[key] !== undefined) clean[key] = patch[key];
    }
    if (clean.talkativeness !== undefined) {
      clean.talkativeness = Math.min(1, Math.max(0, Number(clean.talkativeness)));
    }
    return store().updateMember(memberId, clean);
  }

  async function removeMember(memberId) {
    return store().removeMember(memberId);
  }

  async function setStrategy(chatId, input = {}) {
    const s = store();
    const chat = s.getChat(chatId);
    if (!chat) throw new NotFoundError(`对话 ${chatId}`);
    const settings = { ...(chat.settings ?? {}) };
    if (input.allowSelfResponses !== undefined) settings.allowSelfResponses = Boolean(input.allowSelfResponses);
    if (input.groupNudge !== undefined) settings.groupNudge = String(input.groupNudge);
    const patch = { settings };
    if (input.strategy !== undefined) {
      const strategy = strategyById(input.strategy);
      patch.groupStrategy = strategy.id;
    }
    if (input.mode !== undefined) patch.groupMode = input.mode;
    if (input.autoModeDelay !== undefined) patch.autoModeDelay = Math.max(1, Number(input.autoModeDelay) || 5);
    return s.updateChat(chatId, patch);
  }

  /** 自动模式：告诉我下一个该谁、隔多久，前端按这个循环调 send 就行。 */
  async function auto(chatId, input = {}) {
    const chat = await get(chatId);
    const plan = await ctx.chat.plan(chatId, { text: input.text ?? '', memberId: input.memberId ?? null });
    return {
      chatId,
      delay: chat.autoModeDelay ?? 5,
      order: plan.order,
      active: Boolean(input.active ?? true),
    };
  }

  return { strategies, modes, list, get, addMember, updateMember, removeMember, setStrategy, auto };
}

// ---------------------------------------------------------------- 场景状态

function createStateService(ctx) {
  const store = () => requireStore(ctx);

  function panels() {
    return STATE_PANELS;
  }

  async function get(chatId) {
    const s = store();
    const chat = s.getChat(chatId);
    if (!chat) throw new NotFoundError(`对话 ${chatId}`);
    return {
      chatId,
      worldState: chat.worldState ?? emptyWorldState(),
      variables: s.listVariables(chatId),
      panels: STATE_PANELS,
      snapshots: s.listSnapshots(chatId),
    };
  }

  async function put(chatId, input = {}) {
    const s = store();
    const chat = s.getChat(chatId);
    if (!chat) throw new NotFoundError(`对话 ${chatId}`);
    for (const op of input.variables ?? []) {
      s.setVariable(chatId, { scope: op.scope ?? 'chat', characterId: op.characterId ?? '', key: op.key, value: op.value, label: op.label ?? null });
    }
    for (const item of input.deleteVariables ?? []) {
      // 既接受 "key" 字符串，也接受 { key, scope, characterId } —— 角色变量得按角色删。
      const spec = typeof item === 'string' ? { key: item } : item ?? {};
      s.deleteVariable(chatId, { scope: spec.scope ?? 'chat', characterId: spec.characterId ?? '', key: spec.key });
    }
    if (input.worldState) s.updateChat(chatId, { worldState: input.worldState });
    if (input.delta) {
      const next = applyStateDelta(s.getChat(chatId).worldState, input.delta);
      s.updateChat(chatId, { worldState: next });
    }
    return get(chatId);
  }

  async function roll(chatId, input = {}) {
    const s = store();
    const chat = s.getChat(chatId);
    if (!chat) throw new NotFoundError(`对话 ${chatId}`);
    const result = rollDice(input.expr ?? '1d20', input.rng);
    if (input.append !== false) {
      s.appendMessage(chatId, {
        role: 'narrator',
        name: '骰子',
        content: result.detail,
        tokens: estimateTokens(result.detail),
        extra: { dice: result },
      });
    }
    if (input.variable) {
      s.setVariable(chatId, { scope: 'chat', key: input.variable, value: result.total });
    }
    return result;
  }

  async function snapshots(chatId) {
    const s = store();
    if (!s.getChat(chatId)) throw new NotFoundError(`对话 ${chatId}`);
    return { items: s.listSnapshots(chatId), total: s.listSnapshots(chatId).length };
  }

  async function snapshot(chatId, input = {}) {
    const s = store();
    const chat = s.getChat(chatId);
    if (!chat) throw new NotFoundError(`对话 ${chatId}`);
    return s.addSnapshot(chatId, {
      label: input.label ?? `快照 ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
      messageId: input.messageId ?? null,
      variables: s.listVariables(chatId),
      worldState: chat.worldState ?? {},
    });
  }

  async function restore(chatId, snapshotId) {
    const s = store();
    const snap = s.getSnapshot(snapshotId);
    if (!snap || snap.chatId !== chatId) throw new NotFoundError(`快照 ${snapshotId}`);
    s.updateChat(chatId, { worldState: snap.worldState });
    s.replaceVariables(chatId, snap.variables ?? []);
    return get(chatId);
  }

  async function removeSnapshot(chatId, snapshotId) {
    const s = store();
    const snap = s.getSnapshot(snapshotId);
    if (!snap || snap.chatId !== chatId) throw new NotFoundError(`快照 ${snapshotId}`);
    s.removeSnapshot(snapshotId);
    return true;
  }

  return { panels, get, put, roll, snapshots, snapshot, restore, removeSnapshot, applyDelta: (worldState, delta) => applyStateDelta(worldState, delta) };
}

// ---------------------------------------------------------------- 叙事控制

function createNarrationService(ctx) {
  const store = () => requireStore(ctx);

  function modes() {
    return DIRECTOR_MODES;
  }

  /** 每轮 3~4 个候选行动。优先让模型给，模型不可用就退回模板。 */
  async function options(chatId, input = {}) {
    const s = store();
    const chat = s.getChat(chatId);
    if (!chat) throw new NotFoundError(`对话 ${chatId}`);
    const count = Math.min(4, Math.max(3, Number(input.count) || OPTION_COUNT_DEFAULT));
    const member = (chat.members ?? []).find((item) => item.id === input.memberId) ?? primaryMember(chat);
    let items = [];
    let source = 'fallback';
    if (ctx.models?.complete) {
      const resolved = resolveForMember(ctx, { chat, member, input: {} });
      if (resolved.providerId) {
        try {
          const history = s.listMessages(chatId).filter((message) => !message.isSystem);
          const result = await ctx.models.complete(resolved.providerId, {
            model: resolved.model ?? null,
            system: `${OPTIONS_INSTRUCTION}\n只输出 ${count} 个候选行动。`,
            messages: history.slice(-12).map((message) => ({ role: message.role === 'narrator' ? 'system' : message.role, content: message.content })),
            params: { max_tokens: 300, ...(resolved.params ?? {}) },
          });
          const parsed = parseOptions(result.text ?? '');
          if (parsed.options.length) {
            items = parsed.options.slice(0, count);
            source = 'model';
          }
        } catch (err) {
          ctx.logger?.debug?.(`候选行动生成失败，用兜底模板：${err?.message ?? err}`);
        }
      }
    }
    if (!items.length) items = fallbackOptions({ worldState: chat.worldState, members: chat.members });
    if (input.save !== false) s.saveActions(chatId, { messageId: input.messageId ?? null, options: items });
    return { chatId, items, source, total: items.length };
  }

  async function latest(chatId) {
    const s = store();
    if (!s.getChat(chatId)) throw new NotFoundError(`对话 ${chatId}`);
    const action = s.latestActions(chatId);
    return action ?? { chatId, messageId: null, options: [] };
  }

  /**
   * 导演插话。narrator / ooc 直接落成一条消息；director 只注入下一轮。
   */
  async function director(chatId, input = {}) {
    const s = store();
    const chat = s.getChat(chatId);
    if (!chat) throw new NotFoundError(`对话 ${chatId}`);
    const built = buildDirectorMessage(input.text, { mode: input.mode ?? 'narrator', userName: chat.persona?.name || '我' });
    if (built.message) {
      const saved = s.appendMessage(chatId, {
        role: built.message.role,
        name: built.message.name,
        content: built.message.content,
        tokens: estimateTokens(built.message.content),
        extra: built.message.extra,
      });
      return { mode: input.mode ?? 'narrator', message: saved, injection: null };
    }
    const settings = { ...(chat.settings ?? {}), directorInjection: built.injection };
    s.updateChat(chatId, { settings });
    return { mode: 'director', message: null, injection: built.injection };
  }

  async function branch(chatId, input = {}) {
    return ctx.chat.branch(chatId, input);
  }

  // ---------------------------------------------------------------- 章节管理

  function chapters(chatId) {
    const s = store();
    const chat = s.getChat(chatId);
    if (!chat) throw new NotFoundError(`对话 ${chatId}`);
    const messages = s.listMessages(chatId);
    const items = buildChapters({ chapters: chat.settings?.chapters ?? [], messages });
    return { chatId, items, total: items.length, stored: normaliseChapters(chat.settings?.chapters ?? []) };
  }

  function saveChapter(chatId, input = {}) {
    const s = store();
    const chat = s.getChat(chatId);
    if (!chat) throw new NotFoundError(`对话 ${chatId}`);
    const stored = normaliseChapters(chat.settings?.chapters ?? []);
    const existing = input.id ? stored.find((chapter) => chapter.id === input.id) ?? null : null;
    const title = String(input.title ?? existing?.title ?? '').trim();
    if (!title) throw new ValidationError('章节要有标题');
    const messages = s.listMessages(chatId);
    // 改名时不动它原来的起始消息；新建时默认从最后一条开始。
    const messageId = input.messageId ?? existing?.messageId ?? messages[messages.length - 1]?.id ?? null;
    if (messageId && !messages.some((message) => message.id === messageId)) {
      throw new NotFoundError(`消息 ${messageId}`);
    }
    const entry = {
      id: input.id ?? newChapterId(Date.now() + stored.length),
      title,
      summary: input.summary ?? existing?.summary ?? '',
      messageId,
    };
    const next = upsertChapter(stored, entry);
    s.updateChat(chatId, { settings: { ...(chat.settings ?? {}), chapters: next } });
    return chapters(chatId);
  }

  function deleteChapter(chatId, chapterId) {
    const s = store();
    const chat = s.getChat(chatId);
    if (!chat) throw new NotFoundError(`对话 ${chatId}`);
    const next = removeChapter(chat.settings?.chapters ?? [], chapterId);
    s.updateChat(chatId, { settings: { ...(chat.settings ?? {}), chapters: next } });
    return chapters(chatId);
  }

  /** 这条消息落在哪一章（给界面画分割线用）。 */
  function chapterAt(chatId, messageId) {
    const s = store();
    const chat = s.getChat(chatId);
    if (!chat) throw new NotFoundError(`对话 ${chatId}`);
    return chapterFor({ chapters: chat.settings?.chapters ?? [], messages: s.listMessages(chatId), messageId });
  }

  // ---------------------------------------------------------------- 结局收集

  function endings(chatId) {
    const s = store();
    const chat = s.getChat(chatId);
    if (!chat) throw new NotFoundError(`对话 ${chatId}`);
    const items = normaliseEndings(chat.settings?.show?.endings ?? []);
    // 路线定义放在演出设置里（`settings.show.routes`）；这里顺带带上，界面才能"记下这个结局"。
    const routes = Array.isArray(chat.settings?.show?.routes) ? chat.settings.show.routes : [];
    return { chatId, items, total: items.length, routes };
  }

  function recordCollectedEnding(chatId, input = {}) {
    const s = store();
    const chat = s.getChat(chatId);
    if (!chat) throw new NotFoundError(`对话 ${chatId}`);
    const routeId = String(input.routeId ?? '').trim();
    if (!routeId) throw new ValidationError('要指定 routeId');
    const show = { ...(chat.settings?.show ?? {}) };
    const list = recordEnding(show.endings ?? [], { routeId, title: input.title ?? '', ending: input.ending ?? '' });
    s.updateChat(chatId, { settings: { ...(chat.settings ?? {}), show: { ...show, endings: list } } });
    return endings(chatId);
  }

  // ---------------------------------------------------------------- 随机事件

  function eventSettings(chatId) {
    const s = store();
    const chat = s.getChat(chatId);
    if (!chat) throw new NotFoundError(`对话 ${chatId}`);
    return { chatId, settings: normaliseEventSettings(chat.settings?.randomEvents), defaults: DEFAULT_EVENTS.map((item) => ({ ...item })) };
  }

  function saveEventSettings(chatId, patch = {}) {
    const s = store();
    const chat = s.getChat(chatId);
    if (!chat) throw new NotFoundError(`对话 ${chatId}`);
    const current = normaliseEventSettings(chat.settings?.randomEvents);
    const next = normaliseEventSettings({
      enabled: patch.enabled !== undefined ? patch.enabled : current.enabled,
      chance: patch.chance !== undefined ? patch.chance : current.chance,
      events: patch.events !== undefined ? patch.events : current.events,
    });
    s.updateChat(chatId, { settings: { ...(chat.settings ?? {}), randomEvents: next } });
    return { chatId, settings: next, defaults: DEFAULT_EVENTS.map((item) => ({ ...item })) };
  }

  /** 试抽一次（不落消息），界面上的"掷一次"用它。 */
  function rollEvent(chatId, input = {}) {
    const { settings } = eventSettings(chatId);
    const roll = input.roll !== undefined ? Number(input.roll) : ctx.random?.();
    const chance = input.chanceRoll !== undefined ? Number(input.chanceRoll) : ctx.random?.();
    const fired = shouldFire({ chance: input.chance ?? settings.chance, roll: chance });
    return { fired, event: fired ? pickRandomEvent({ events: settings.events, roll }) : null, chance: input.chance ?? settings.chance, roll: chance };
  }

  /**
   * 一轮用户发言之后问一句"要不要插个随机事件"。开着的对话才会抽；
   * 抽中了就落一条旁白系统消息，跟着这一轮的上下文一起发出去。
   */
  function maybeFireRandomEvent(chatId, input = {}) {
    const s = store();
    const chat = s.getChat(chatId);
    if (!chat) return { fired: false, reason: '对话不存在' };
    const conf = normaliseEventSettings(chat.settings?.randomEvents);
    if (!conf.enabled) return { fired: false, reason: '随机事件没开' };
    if (!conf.events.length) return { fired: false, reason: '没有可用事件' };
    const chanceRoll = input.chanceRoll !== undefined ? Number(input.chanceRoll) : ctx.random?.();
    if (!shouldFire({ chance: input.chance ?? conf.chance, roll: chanceRoll })) return { fired: false, reason: '这次没触发', chance: input.chance ?? conf.chance };
    const event = pickRandomEvent({ events: conf.events, roll: input.roll !== undefined ? Number(input.roll) : ctx.random?.() });
    if (!event) return { fired: false, reason: '没有抽到事件' };
    const content = formatEventMessage(event);
    const message = s.appendMessage(chatId, {
      role: 'system',
      name: '旁白',
      content,
      tokens: estimateTokens(content),
      extra: { randomEvent: { id: event.id, title: event.title } },
    });
    return { fired: true, event, message };
  }

  return { modes, options, latest, director, branch, chapters, saveChapter, deleteChapter, chapterAt, endings, recordCollectedEnding, eventSettings, saveEventSettings, rollEvent, maybeFireRandomEvent };
}
