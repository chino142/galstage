/**
 * 提示词组装：正式阶段管线。
 *
 * 阶段顺序就是 `core/prompts/stages.mjs` 里的 14 段，代码按那份清单一步一步来，
 * 每段产出的 section 都带 `stage` 字段，X 光机据此分组显示。
 *
 *   全局系统 → 角色系统 → 人设 → 预设队列 → 世界书 → 记忆 → 参考资料
 *   → 作者注 → 对话示例 → 对话历史 → 前置词 → 后置词 → 停止串 → 输出后处理
 *
 * 宏走 core/prompts/macros.mjs（完整宏引擎，含自定义宏与条件块），
 * 正则走 core/prompts/regex.mjs（发送前改用户输入、收到后改 AI 输出、只改显示）。
 *
 * 玩卡区每轮都调用 assemblePrompt，所以这里的新东西全部**可选**：
 * 不传 preset / regexScripts / suffix 时，行为与旧版一致。
 */

import { estimateTokens } from '../chat/tokens.mjs';
import { PROMPT_STAGES } from './stages.mjs';
import { evaluateMacros, createMacroContext, VarStore } from './macros.mjs';
import { getRegexedString, normalizeScript, regex_placement } from './regex.mjs';
import { resolveNote, shouldInject } from './note.mjs';
import { applyFormatTemplate } from './preset-options.mjs';

export const STAGE_IDS = PROMPT_STAGES.map((stage) => stage.id);

export const DEFAULT_SYSTEM_PROMPT =
  '你是一个角色扮演引擎。始终以角色的身份说话和行动，保持人设一致，不要跳出角色解释自己是 AI。' +
  '描写要有画面感但别啰嗦，推进剧情时给用户留出选择空间。';

// ---------------------------------------------------------------- 宏

/**
 * 展开宏。`writes` 收集 {{setvar}} 之类的赋值，调用方决定写不写回存储。
 * @returns {{text:string, writes:Array<{key:string,value:string}>}}
 */
export function expandMacros(input, ctx = {}) {
  const { char = '', user = 'User', persona = '', group = '', vars = {}, macros = {}, messages = [], now = new Date(), rng = Math.random } = ctx;
  const store = vars instanceof VarStore ? vars : new VarStore({ local: vars ?? {} });
  const before = store.snapshot().local;
  const writes = [];
  if (input === null || input === undefined) return { text: '', writes };

  const macroCtx = createMacroContext({
    charName: char,
    userName: user,
    group: group || null,
    persona: { description: persona },
    vars: store,
    customMacros: macros,
    messages,
    now,
    rng,
  });

  let text = evaluateMacros(String(input), macroCtx);
  text = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

  const after = store.snapshot().local;
  for (const [key, value] of Object.entries(after)) if (before[key] !== value) writes.push({ key, value });
  for (const key of Object.keys(before)) if (!(key in after)) writes.push({ key, value: '' });
  return { text, writes };
}

// ---------------------------------------------------------------- 小工具

function sectionOf(id, title, role, content, source, stage = null) {
  const text = String(content ?? '').trim();
  if (!text) return null;
  return { id, title, role, content: text, source, stage: stage ?? id, tokens: estimateTokens(text) };
}

function personaBlock(card = {}) {
  const parts = [];
  if (card.name) parts.push(`名字：${card.name}`);
  if (card.description) parts.push(`设定：${card.description}`);
  if (card.personality) parts.push(`性格：${card.personality}`);
  if (card.scenario) parts.push(`场景：${card.scenario}`);
  return parts.join('\n');
}

/** 预设里的字段格式模板（scenario_format / personality_format）。 */
function formatTemplates(settings = {}) {
  return settings.formatTemplates && typeof settings.formatTemplates === 'object' ? settings.formatTemplates : {};
}

const ROLE_BY_NUMBER = { 0: 'system', 1: 'user', 2: 'assistant' };

function presetPromptList(input) {
  if (Array.isArray(input.presetQueue)) return input.presetQueue;
  const prompts = input.preset?.prompts;
  if (Array.isArray(prompts)) return prompts;
  return [];
}

/**
 * 预设的位置标记 → 我们这边的"动态块"。
 * 标记本身没有内容，酒馆靠它决定"角色描述 / 世界书 / 历史"这些插在哪一段。
 */
const PRESET_MARKER_SLOTS = {
  worldinfobefore: 'worldbook-before',
  worldinfoafter: 'worldbook-after',
  chardescription: 'card-description',
  charpersonality: 'card-personality',
  scenario: 'card-scenario',
  personadescription: 'persona-description',
  dialogueexamples: 'examples',
  chatexamples: 'examples',
  chathistory: 'history',
};

const PRESET_SLOT_TITLES = {
  'worldbook-before': '世界书（角色之前）',
  'worldbook-after': '世界书（角色之后）',
  'card-description': '角色描述',
  'card-personality': '角色性格',
  'card-scenario': '场景',
  'persona-description': '我的人设',
  examples: '对话示例',
  history: '对话历史',
};

/**
 * 酒馆预设真正走哪条顺序，看的是 `prompt_order`（按角色分组），`prompts` 只是定义表。
 * 取那个非空的分组；酒馆自己也是优先 100000（全局默认），没有就用第一个有内容的。
 */
function presetOrderEntries(preset) {
  const groups = preset?.prompt_order;
  if (!Array.isArray(groups)) return null;
  const filled = groups.filter((group) => Array.isArray(group?.order) && group.order.length);
  if (!filled.length) return null;
  const preferred = filled.find((group) => Number(group?.character_id) === 100000) ?? filled[0];
  return preferred.order;
}

/**
 * 定义表 + 顺序表 → 真正要走的清单（[{prompt, enabled}]）。
 * 没有顺序表就按定义顺序；顺序表里漏掉的条目按定义顺序补在后面（老预设可能缺）。
 */
function buildPresetPlan(prompts, order) {
  const list = Array.isArray(prompts) ? prompts.filter(Boolean) : [];
  const on = (prompt, enabledFromOrder = true) =>
    enabledFromOrder && prompt.enabled !== false && !prompt.disabled;
  if (!Array.isArray(order) || !order.length) return list.map((prompt) => ({ prompt, enabled: on(prompt) }));

  const byIdentifier = new Map(list.map((prompt) => [String(prompt.identifier ?? ''), prompt]));
  const seen = new Set();
  const plan = [];
  for (const item of order) {
    const identifier = String(item?.identifier ?? '');
    const prompt = byIdentifier.get(identifier);
    if (!prompt || seen.has(identifier)) continue;
    seen.add(identifier);
    plan.push({ prompt, enabled: on(prompt, item?.enabled !== false) });
  }
  for (const prompt of list) {
    if (seen.has(String(prompt.identifier ?? ''))) continue;
    plan.push({ prompt, enabled: on(prompt) });
  }
  return plan;
}

function normalizePresetRole(prompt) {
  if (typeof prompt.role === 'string') return ROLE_BY_NUMBER[prompt.role] ?? prompt.role;
  return ROLE_BY_NUMBER[Number(prompt.role)] ?? 'system';
}

function trimHistory(messages, { budget, keepLast, strategy = 'keepLast' }) {
  const original = messages;
  let list = messages;
  const limit = Number(keepLast) || 0;

  if (strategy === 'keepFirst') {
    if (limit && list.length > limit) list = list.slice(0, limit);
  } else if (strategy === 'dropMiddle') {
    if (limit && list.length > limit) {
      const keepHead = Math.max(1, Math.floor(limit / 3));
      const keepTail = Math.max(1, limit - keepHead);
      list = [...list.slice(0, keepHead), ...list.slice(-keepTail)];
    }
  } else if (limit && list.length > limit) {
    list = list.slice(-limit);
  }

  let dropped = original.length - list.length;
  if (!budget) return { list, dropped, overBudget: false, strategy };
  let total = list.reduce((sum, message) => sum + estimateTokens(message.content ?? ''), 0);

  if (strategy === 'keepFirst') {
    while (list.length > 2 && total > budget) {
      total -= estimateTokens(list[list.length - 1].content ?? '');
      list = list.slice(0, -1);
      dropped += 1;
    }
  } else if (strategy === 'dropMiddle') {
    while (list.length > 2 && total > budget) {
      // 从正中间开始丢，保住最近的和最老的。
      const index = Math.max(1, Math.floor(list.length / 2));
      total -= estimateTokens(list[index].content ?? '');
      list = [...list.slice(0, index), ...list.slice(index + 1)];
      dropped += 1;
    }
  } else {
    while (list.length > 2 && total > budget) {
      total -= estimateTokens(list[0].content ?? '');
      list = list.slice(1);
      dropped += 1;
    }
  }
  return { list, dropped, overBudget: total > budget, strategy };
}

// ---------------------------------------------------------------- 组装

/**
 * 覆盖类字段里的 `{{original}}`：把系统默认提示词嵌回你指定的位置。
 *
 * 没有它，角色卡一旦写了 system_prompt 就只能"全自己写"——没法在保留
 * 默认提示词的前提下加两句。有它就能写成「{两句要求}\n{{original}}」。
 */
export function substituteOriginal(text, original) {
  const source = String(text ?? '');
  if (!source.includes('{{original}}')) return source;
  return source.split('{{original}}').join(String(original ?? '').trim());
}

/**
 * 组装一轮提示词。
 *
 * @param {object} input
 * @param {object} [input.card]            正在说话角色的卡
 * @param {Array}  [input.groupMembers]
 * @param {string} [input.groupMode]
 * @param {object} [input.persona]         { name, description }
 * @param {Array}  [input.history]         role/content/hidden/isSystem/name
 * @param {object} [input.settings]        对话级设置（systemPrompt/contextBudget/authorNote/prefill/suffix/historyLimit/trimStrategy/regexScripts…）
 *                                         其中 cardSystemPrompt / prefixText / suffixText 是对**卡片级**那三样的对话级覆盖：
 *                                         键在 = 覆盖（空串表示这一样整段不要），键不在 = 跟随卡片。
 * @param {object} [input.preset]          酒馆预设（{prompts:[…]}）或 presetQueue 数组
 * @param {object} [input.worldState]
 * @param {object} [input.variables]
 * @param {Array}  [input.worldbookEntries]
 * @param {Array}  [input.memories]
 * @param {Array}  [input.databankEntries] 参考资料片段
 * @param {string} [input.injection]       本轮额外系统注入（导演指令等）
 * @param {Array}  [input.extraSections]
 * @param {string[]}[input.dropSections]   X 光机"手动踢掉一段"
 * @param {object} [input.macros]          自定义宏
 * @returns {{system:string, messages:Array, sections:Array, tokens:object, notes:string[], params:object}}
 */
export function assemblePrompt(input = {}) {
  const {
    card = {},
    groupMembers = null,
    groupMode = 'swap',
    persona = {},
    history = [],
    settings = {},
    worldState = {},
    variables = {},
    worldbookEntries = [],
    memories = [],
    databankEntries = [],
    injection = '',
    extraSections = [],
    dropSections = [],
    macros = {},
    now = new Date(),
    rng = Math.random,
  } = input;

  const charName = String(card.name ?? persona.charName ?? '角色');
  const userName = String(persona.name ?? settings.userName ?? 'User');
  const isGroup = Array.isArray(groupMembers) && groupMembers.length > 0;
  const merged = isGroup && groupMode !== 'swap' ? mergeGroupCards(groupMembers, card, groupMode) : null;

  const notes = [];
  const sections = [];
  const add = (stage, id, title, role, content, source) => {
    const section = sectionOf(id, title, role, content, source, stage);
    if (section) sections.push(section);
    return section;
  };

  const macroCtx = {
    char: charName,
    user: userName,
    persona: String(persona.description ?? ''),
    vars: variables ?? {},
    macros,
    messages: history.map((message) => ({ role: message.role, content: message.content })),
    now,
    rng,
  };
  const expand = (text) => expandMacros(text, macroCtx).text;

  // ---- 1. 全局系统提示 ----
  // 预设写 use_sysprompt: false 时，它不想要这条默认系统提示（酒馆里就是这个意思）
  if (settings.useSystemPrompt !== false) {
    add('global-system', 'global-system', '全局系统提示', 'system', expand(settings.systemPrompt ?? DEFAULT_SYSTEM_PROMPT), 'settings');
  } else {
    notes.push('预设写了 use_sysprompt: false，这一轮不加默认系统提示');
  }

  // ---- 2. 角色系统提示（支持 {{original}} 把默认系统提示词嵌回来）----
  // 对话级可以盖住它（界面：对话页 → ⚙ 对话配置 → 提示词）。
  // 「键在不在」就是"覆不覆盖"：键在 = 用对话里那份（空串 = 这一轮干脆不带角色系统提示），
  // 键不在 = 跟着卡片走。用 hasOwnProperty 而不是判断真值，才能表达"我就是要它空着"。
  const globalSystemPrompt = settings.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  const systemOverridden = Object.prototype.hasOwnProperty.call(settings, 'cardSystemPrompt');
  const cardSystemText = systemOverridden ? String(settings.cardSystemPrompt ?? '') : card.system_prompt;
  add(
    'character-system',
    'character-system',
    `${charName}的系统提示${systemOverridden ? '（这个对话覆盖的）' : ''}`,
    'system',
    expand(substituteOriginal(cardSystemText, globalSystemPrompt)),
    systemOverridden ? 'settings' : 'card',
  );
  if (systemOverridden) {
    notes.push(cardSystemText.trim() ? '系统提示用的是这个对话覆盖的那份（不是卡片级）' : '系统提示被这个对话覆盖成空的：这一轮不带角色系统提示');
  }

  // ---- 3. 人设注入（角色 + 我的人设 + 群聊身份）----
  // 预设带位置标记时，角色描述 / 性格 / 场景拆成独立段，等走到标记处再插；
  // 没有标记就照旧合成一段（老行为不变）。没被标记点到的东西也会照常插，不会丢。
  const presetPlan = buildPresetPlan(presetPromptList(input), presetOrderEntries(input.preset));
  const markerSlots = new Set();
  const unsupportedMarkers = [];
  for (const item of presetPlan) {
    const prompt = item.prompt;
    if (!prompt?.marker) continue;
    const slot = PRESET_MARKER_SLOTS[String(prompt.identifier ?? '').toLowerCase()];
    if (slot) markerSlots.add(slot);
    else unsupportedMarkers.push(String(prompt.name ?? prompt.identifier ?? '未命名'));
  }
  const cardMarkerUsed = ['card-description', 'card-personality', 'card-scenario'].some((slot) => markerSlots.has(slot));
  const templates = formatTemplates(settings);
  // 没有位置标记时（老写法）合成一段，但性格 / 场景仍然按预设的模板包一下
  const mergedPersonaText =
    merged?.description ??
    [
      card.name ? `名字：${card.name}` : '',
      card.description ? `设定：${card.description}` : '',
      applyFormatTemplate(templates.personality, 'personality', card.personality ? `性格：${card.personality}` : ''),
      applyFormatTemplate(templates.scenario, 'scenario', card.scenario ? `场景：${card.scenario}` : ''),
    ]
      .filter(Boolean)
      .join('\n');
  const cardDescriptionText = merged
    ? mergedPersonaText
    : [card.name ? `名字：${card.name}` : '', card.description ? `设定：${card.description}` : ''].filter(Boolean).join('\n');
  const cardPersonalityText = merged ? '' : applyFormatTemplate(templates.personality, 'personality', card.personality ? `性格：${card.personality}` : '');
  const cardScenarioText = merged ? '' : applyFormatTemplate(templates.scenario, 'scenario', card.scenario ? `场景：${card.scenario}` : '');
  if (!cardMarkerUsed) {
    add('persona', 'persona', '人设注入', 'system', expand(mergedPersonaText), isGroup && merged ? 'group' : 'card');
  } else {
    if (!markerSlots.has('card-description')) add('persona', 'persona', '人设注入（描述）', 'system', expand(cardDescriptionText), 'card');
    if (!markerSlots.has('card-personality')) add('persona', 'persona-personality', `${charName}的性格`, 'system', expand(cardPersonalityText), 'card');
    if (!markerSlots.has('card-scenario')) add('persona', 'persona-scenario', '场景', 'system', expand(cardScenarioText), 'card');
  }
  const personaText = expand(persona.description ? `我（${userName}）的设定：${persona.description}` : '');
  if (!markerSlots.has('persona-description')) add('persona', 'user-persona', '我的人设', 'system', personaText, 'persona');
  if (isGroup) {
    add('persona', 'group-roster', '群聊名单', 'system', `群聊成员：${groupMembers.map((member) => member.name).join('、')}。现在由 ${charName} 说话。`, 'group');
    if (groupMode !== 'swap') add('persona', 'group-nudge', '群聊提醒', 'system', expand(settings.groupNudge ?? '[Write the next reply only as {{char}}.]'), 'group');
  }

  // ---- 4. 预设队列（含位置标记）----
  const presetMessages = [];
  const postHistoryPreset = [];
  const depthInjections = [];
  let historySplit = null; // 历史要插在预设消息的第几条之后（没标记就是最后）
  let afterHistory = false;

  // ---- 5. 世界书注入（有标记就按标记分前后，没有就照旧合成一段）----
  const worldbookBuckets = { before: [], after: [], other: [] };
  for (const entry of worldbookEntries) {
    const position = Number(entry?.position);
    if (position === 1) worldbookBuckets.after.push(entry);
    else if (position === 0 || !Number.isFinite(position)) worldbookBuckets.before.push(entry);
    else worldbookBuckets.other.push(entry);
  }
  // 预设的 wi_format（世界书条目模板）：{0} / {{worldInfo}} 是占位，默认写法保持原样
  const worldbookLineOf = (entry) => {
    const body = String(entry.content ?? '').trim();
    if (!body) return '';
    const tpl = templates.worldbook;
    if (!tpl || tpl === '{0}' || tpl === '{{worldInfo}}' || tpl === '{{world_info}}') return body;
    return tpl.replace(/\{0\}/g, body).replace(/\{\{worldInfo\}\}/gi, body);
  };
  const worldbookTextOf = (list) => list.map(worldbookLineOf).filter(Boolean).join('\n\n');
  let worldbookEmitted = false;

  /** 走到某个位置标记：把对应的动态内容插在这儿。 */
  const emitMarkerSlot = (slot) => {
    const at = `（预设标记位）`;
    if (slot === 'worldbook-before' || slot === 'worldbook-after') {
      worldbookEmitted = true;
      const after = slot === 'worldbook-after';
      add('preset-queue', after ? 'worldbook-after' : 'worldbook-before', `${PRESET_SLOT_TITLES[slot]}${at}`, 'system', worldbookTextOf(after ? worldbookBuckets.after : worldbookBuckets.before), 'worldbook');
      return;
    }
    if (slot === 'card-description') {
      add('preset-queue', 'card-description', `角色描述${at}`, 'system', expand(cardDescriptionText), 'card');
      return;
    }
    if (slot === 'card-personality') {
      add('preset-queue', 'card-personality', `${charName}的性格${at}`, 'system', expand(cardPersonalityText), 'card');
      return;
    }
    if (slot === 'card-scenario') {
      add('preset-queue', 'card-scenario', `场景${at}`, 'system', expand(cardScenarioText), 'card');
      return;
    }
    if (slot === 'persona-description') {
      add('preset-queue', 'user-persona', `我的人设${at}`, 'system', personaText, 'persona');
      return;
    }
    if (slot === 'examples') {
      add('preset-queue', 'examples', `对话示例${at}`, 'system', expand(merged?.examples || String(card.mes_example ?? '')), 'card');
    }
  };

  presetPlan.forEach((item, index) => {
    const prompt = item.prompt;
    if (!prompt) return;
    if (prompt.marker) {
      const slot = PRESET_MARKER_SLOTS[String(prompt.identifier ?? '').toLowerCase()];
      if (!slot) return; // 不认识的标记：上面已经记了说明
      if (slot === 'history') {
        historySplit = presetMessages.length;
        afterHistory = true;
      } else emitMarkerSlot(slot);
      return;
    }
    if (!item.enabled) return;
    const content = expand(prompt.content ?? prompt.system_prompt ?? '');
    if (!content) return;
    const role = normalizePresetRole(prompt);
    // 注入位置 = 1（绝对）：酒馆是把这条按深度插进对话历史，不是顺着队列走。
    if (Number(prompt.injection_position) === 1) {
      depthInjections.push({ role, content, depth: Math.max(0, Number(prompt.injection_depth ?? 0)), name: String(prompt.name ?? prompt.identifier ?? '预设条目') });
      return;
    }
    const id = `preset:${prompt.identifier ?? prompt.id ?? index}`;
    // 排在 chatHistory 之后：酒馆是把它当成对话里的一条消息发给模型的（越狱预设靠这个"压轴"），
    // 所以这里也不塞进最前面的系统提示，而是挂在历史后面。
    if (afterHistory) {
      add('preset-inline', id, `${prompt.name ?? prompt.title ?? `预设 ${index + 1}`}（历史后）`, role, content, 'preset');
      postHistoryPreset.push({ role, content });
    } else {
      add('preset-queue', id, prompt.name ?? prompt.title ?? `预设 ${index + 1}`, role, content, 'preset');
      if (role !== 'system') presetMessages.push({ role, content });
    }
  });

  if (markerSlots.size) {
    notes.push(`预设的位置标记已生效：${[...markerSlots].map((slot) => PRESET_SLOT_TITLES[slot] ?? slot).join('、')}`);
  }
  for (const name of unsupportedMarkers) notes.push(`预设里的位置标记「${name}」暂不支持，已跳过`);
  if (historySplit !== null) notes.push('对话历史按预设指定的位置插入');
  if (postHistoryPreset.length) notes.push(`预设里有 ${postHistoryPreset.length} 条排在历史之后，按酒馆的规矩接在对话后面发`);
  if (depthInjections.length) notes.push(`预设里有 ${depthInjections.length} 条按深度注入的条目，已插进对话历史`);

  if (!worldbookEmitted) {
    const worldbookText = worldbookTextOf(worldbookEntries);
    if (worldbookText) add('worldbook', 'worldbook', '世界书注入', 'system', worldbookText, 'worldbook');
    else notes.push('这一轮没有世界书条目被激活');
  } else if (worldbookBuckets.other.length) {
    add('worldbook', 'worldbook-other', '世界书注入（其它位置）', 'system', worldbookTextOf(worldbookBuckets.other), 'worldbook');
  }

  // ---- 6. 记忆注入 + 场景状态 ----
  add('memory', 'scene-state', '场景状态', 'system', describeState(worldState), 'state');
  const memoryText = memories.map((memory) => String(memory.content ?? '').trim()).filter(Boolean).join('\n\n');
  if (memoryText) add('memory', 'memory', '记忆注入', 'system', memoryText, 'memory');

  // ---- 7. 参考资料（向量召回）----
  const databankText = databankEntries.map((entry) => String(entry.content ?? '').trim()).filter(Boolean).join('\n\n');
  if (databankText) add('databank', 'databank', '参考资料', 'system', databankText, 'databank');

  // ---- 8. 临场指令（作者注）：三层作用域 对话 > 角色 > 默认 ----
  // 老写法（settings.authorNote 字符串 + authorNotePosition/Depth/Role）继续可用。
  const noteLayers = settings.notes && typeof settings.notes === 'object' ? settings.notes : null;
  // 老写法：settings.authorNote 是字符串，位置/深度/角色在别的字段里。原样尊重。
  const legacyNote = settings.authorNote
    ? {
        prompt: settings.authorNote,
        position: settings.authorNotePosition ?? 'before',
        depth: settings.authorNoteDepth ?? 0,
        role: ROLE_BY_NUMBER[Number(settings.authorNoteRole ?? 0)] ?? 'system',
        interval: 1,
      }
    : null;
  const resolvedNote = noteLayers
    ? resolveNote({ defaultNote: noteLayers.default, characterNote: noteLayers.character, chatNote: noteLayers.chat })
    : resolveNote({ defaultNote: legacyNote });
  const noteActive = resolvedNote.note && shouldInject(resolvedNote.note, settings.userTurnCount ?? 1) ? resolvedNote.note : null;
  if (resolvedNote.note && !noteActive) {
    notes.push(`临场指令（${resolvedNote.from} 层）按频率跳过：每 ${resolvedNote.note.interval} 条用户输入才插一次`);
  }
  const authorNote = noteActive ? expand(noteActive.prompt) : '';
  const authorPosition = noteActive ? noteActive.position : (settings.authorNotePosition ?? 'before');
  const authorRole = noteActive ? noteActive.role : (ROLE_BY_NUMBER[Number(settings.authorNoteRole ?? 0)] ?? 'system');
  const authorDepth = noteActive ? noteActive.depth : Math.max(0, Number(settings.authorNoteDepth ?? 0));
  if (authorNote && authorPosition !== 'after' && authorPosition !== 'atDepth') {
    add('authors-note', 'authors-note', '作者注', authorRole, authorNote, 'settings');
  }

  // ---- 9. 对话示例 ----
  if (!markerSlots.has('examples')) add('examples', 'examples', '对话示例', 'system', expand(merged?.examples || String(card.mes_example ?? '')), 'card');

  // ---- 导演注入与额外片段（挂在历史前，归到参考资料的下一段）----
  add('databank', 'director', '导演注入', 'system', expand(injection), 'director');
  for (const extra of extraSections) {
    add(extra.stage ?? 'databank', extra.id ?? 'custom', extra.title ?? '自定义段', extra.role ?? 'system', expand(extra.content), extra.source ?? 'custom');
  }

  // ---- 10. 对话历史（含正则与裁剪策略）----
  const regexScripts = Array.isArray(settings.regexScripts) ? settings.regexScripts.map((script, index) => normalizeScript(script, index)) : [];
  const applyRegex = (text, placement, depth) =>
    getRegexedString(text, placement, {
      scripts: regexScripts,
      isPrompt: true,
      depth,
      substitute: (value) => expand(value),
      substituteExtended: (value) => expand(value),
    });

  const sendable = history.filter((message) => !message.isSystem && message.role !== 'meta');
  const prepared = sendable.map((message, index) => {
    const depth = sendable.length - 1 - index;
    const placement = message.role === 'user' ? regex_placement.USER_INPUT : regex_placement.AI_OUTPUT;
    const processed = applyRegex(String(message.content ?? ''), placement, depth);
    return { role: message.role === 'narrator' ? 'system' : message.role, content: expand(processed), name: message.name || undefined };
  });

  const budget = Number(settings.contextBudget) || 0;
  const trimStrategy = settings.trimStrategy ?? 'keepLast';
  const { list: kept, dropped, overBudget } = trimHistory(prepared, { budget, keepLast: settings.historyLimit ?? 60, strategy: trimStrategy });
  if (dropped) notes.push(`上下文裁剪（${trimStrategy}）：丢掉最早的 ${dropped} 条历史消息`);
  if (overBudget) notes.push('裁剪到底了仍超出预算，这一轮可能会被提供方截断');

  const historySection = sectionOf(
    'history',
    '对话历史',
    'mixed',
    kept.map((message) => `${message.role === 'user' ? userName : message.role === 'system' ? '（旁白）' : charName}：${message.content}`).join('\n'),
    'history',
    'history',
  );
  if (historySection) sections.push(historySection);

  // 预设里有 chatHistory 标记时，排在它后面的预设条目（例如"继续游戏"、预填充）
  // 要落在历史之后 —— 这正是很多越狱预设的用法，所以按标记切成两段。
  const messages = presetMessages.slice(0, historySplit ?? presetMessages.length).map((message) => ({ ...message }));
  const pushMessage = (message) => {
    const last = messages[messages.length - 1];
    // 预设写 squash_system_messages: false 时不合并相邻消息（酒馆里也是一条一条发）
    const canMerge = settings.squashSystemMessages !== false;
    if (canMerge && last && last.role === message.role && message.role !== 'assistant') last.content += `\n\n${message.content}`;
    else messages.push({ ...message });
  };
  for (const message of kept) pushMessage(message);
  for (const message of presetMessages.slice(historySplit ?? presetMessages.length)) pushMessage(message);
  for (const message of postHistoryPreset) pushMessage(message);

  // 预设里"绝对位置"的条目：按深度插进历史（0 = 紧贴最后一条）。
  for (const item of depthInjections) {
    add('preset-inline', `preset-depth:${item.name}`, `${item.name}（深度 ${item.depth} 注入）`, item.role, item.content, 'preset');
    const index = Math.max(0, messages.length - item.depth);
    messages.splice(index, 0, { role: item.role, content: item.content });
  }

  // 临场指令的 after / atDepth 两种位置：after 放历史之后，atDepth 插到指定深度。
  if (authorNote && authorPosition === 'after') {
    add('suffix', 'authors-note', '作者注（历史后）', authorRole, authorNote, 'settings');
    messages.push({ role: authorRole, content: authorNote });
  } else if (authorNote && authorPosition === 'atDepth') {
    add('suffix', 'authors-note', `作者注（深度 ${authorDepth}）`, authorRole, authorNote, 'settings');
    const index = Math.max(0, messages.length - authorDepth);
    messages.splice(index, 0, { role: authorRole, content: authorNote });
  }

  // 角色卡的历史后指令：位置本来就在历史之后，支持 {{original}}。
  const postHistory = expand(substituteOriginal(card.post_history_instructions, globalSystemPrompt));
  if (postHistory) {
    add('suffix', 'post-history', `${charName}的历史后指令`, 'system', postHistory, 'card');
    messages.push({ role: 'system', content: postHistory });
  }

  // ---- 11. 前置词 ----
  const prefill = String(settings.prefill ?? '').trim();
  if (prefill) {
    const expanded = expand(prefill);
    add('prefill', 'prefill', '前置词', 'assistant', expanded, 'settings');
    messages.push({ role: 'assistant', content: expanded });
  }

  // ---- 12. 后置词 ----
  const suffix = String(settings.suffix ?? '').trim();
  if (suffix) {
    const expanded = expand(suffix);
    add('suffix', 'suffix', '后置词', 'system', expanded, 'settings');
    // 后置词是最高优先级的收尾指令，真的放到最后一条消息里（不是只记进 system）。
    messages.push({ role: 'system', content: expanded });
  }

  // ---- 12.5 长度要求（对话页的"最少字数"）----
  // 为什么放在最后：模型很容易忽略埋在系统提示中间的长度要求（酒馆预设里的
  // 「要写够 1000 字」就在中间），但对话最末尾的一条它基本会照办。
  const minChars = Math.max(0, Number(settings.minChars) || 0);
  if (minChars) {
    const nudge =
      `【本轮长度要求】正文不少于 ${minChars} 字（不含思考过程、小总结、行动选项）。` +
      `写不到 ${minChars} 字就继续往下写，不要提前收尾。`;
    add('suffix', 'min-chars', `长度要求（不少于 ${minChars} 字）`, 'system', nudge, 'settings');
    messages.push({ role: 'system', content: nudge });
  }

  // ---- 12.6 思考语言（对话页的"思考用中文"）----
  // 预设里那条英文 SYSTEM INSTRUCTION 会让模型顺着用英文思考；这一条放在最末尾把它扳回来。
  if (settings.thinkingChinese) {
    const nudge = '【思考语言】思考过程（思维链 / <think> 里的内容）请用简体中文书写，不要用英文思考。';
    add('suffix', 'thinking-lang', '思考语言（中文）', 'system', nudge, 'settings');
    messages.push({ role: 'system', content: nudge });
  }

  // ---- 12.7 模块（Mod）的提示词 ----
  // 模块 = "卡是骨架、功能靠模块补"那套玩法里的零件，提示词可以插四个位置。
  // 这里只负责插；样式和沙箱面板由 chat 服务那边处理（见 core/prompts/modules.mjs）。
  const modulePrompts = settings.modules && typeof settings.modules === 'object' ? settings.modules : {};
  const moduleCount = { system: 0, 'before-user': 0, 'after-user': 0, 'after-history': 0 };
  const modulesAt = (id) => (Array.isArray(modulePrompts[id]) ? modulePrompts[id] : []);
  const moduleText = (id) =>
    modulesAt(id)
      .map((item) => ({ title: item?.title ?? '', body: expand(String(item?.body ?? '')).trim() }))
      .filter((item) => item.body);

  for (const item of moduleText('system')) {
    add('preset-queue', `module:${item.title}`, `模块：${item.title}`, 'system', item.body, 'module');
    moduleCount.system += 1;
  }
  for (const item of moduleText('after-history')) {
    add('suffix', `module:${item.title}`, `模块：${item.title}（历史后）`, 'system', item.body, 'module');
    messages.push({ role: 'system', content: item.body });
    moduleCount['after-history'] += 1;
  }

  // ---- 13. 停止串 ----
  const stopStrings = Array.isArray(settings.stopStrings) ? settings.stopStrings.map(String).filter(Boolean) : [];
  if (stopStrings.length) add('stop-strings', 'stop-strings', '停止串', 'meta', stopStrings.join('\n'), 'settings');

  // ---- 13.5 卡片的前置词 / 后置词 + 模块的用户输入前后 ----
  // 这两个不是独立消息，而是**拼进最后一条用户消息**里（前一段、后一段）——
  // 对标那种"游戏化卡"平台的写法，它俩放的都是"这一轮必须遵守"的即时要求。
  // 拼进用户消息是刻意的：模型把同一轮里的东西当作"当前要处理的内容"，
  // 比另起一条 system 更贴脸（上一轮做"最少字数"时就是这个结论）。
  // 模块的 before-user / after-user 排在卡片的前后置词**外面**（离用户原文更远一层）。
  // 同样允许对话级覆盖（留空 = 跟随卡片级；键在且是空串 = 这一样不要）。
  const prefixOverridden = Object.prototype.hasOwnProperty.call(settings, 'prefixText');
  const suffixOverridden = Object.prototype.hasOwnProperty.call(settings, 'suffixText');
  const cardPrefix = expand(String((prefixOverridden ? settings.prefixText : card.prefix_text) ?? '').trim());
  const cardSuffix = expand(String((suffixOverridden ? settings.suffixText : card.suffix_text) ?? '').trim());
  const moduleBefore = moduleText('before-user').map((item) => item.body);
  const moduleAfter = moduleText('after-user').map((item) => item.body);
  moduleCount['before-user'] = moduleBefore.length;
  moduleCount['after-user'] = moduleAfter.length;
  const prefixParts = [...moduleBefore, cardPrefix].filter(Boolean);
  const suffixParts = [cardSuffix, ...moduleAfter].filter(Boolean);
  if (prefixParts.length || suffixParts.length) {
    const index = messages.findLastIndex((message) => message.role === 'user');
    if (index >= 0) {
      const target = messages[index];
      messages[index] = {
        ...target,
        content: [...prefixParts, target.content, ...suffixParts].filter(Boolean).join('\n\n'),
      };
      const detail = [
        moduleBefore.length ? `${moduleBefore.length} 个模块` : '',
        cardPrefix ? (prefixOverridden ? '前置词（这个对话覆盖的）' : '前置词（卡片级）') : '',
        cardSuffix ? (suffixOverridden ? '后置词（这个对话覆盖的）' : '后置词（卡片级）') : '',
        moduleAfter.length ? `${moduleAfter.length} 个模块` : '',
      ].filter(Boolean).join(' + ');
      notes.push(`${detail}拼在了最后一条用户消息上`);
    } else {
      notes.push('有前置词 / 后置词 / 模块，但这一轮没有用户消息，没拼上去');
    }
  }
  {
    const parts = [];
    if (moduleCount.system) parts.push(`系统提示里 ${moduleCount.system} 个`);
    if (moduleCount['before-user']) parts.push(`用户输入前 ${moduleCount['before-user']} 个`);
    if (moduleCount['after-user']) parts.push(`用户输入后 ${moduleCount['after-user']} 个`);
    if (moduleCount['after-history']) parts.push(`历史之后 ${moduleCount['after-history']} 个`);
    if (parts.length) notes.push(`挂了 ${parts.join('、')}模块`);
  }

  // ---- 14. 输出后处理（正则输出段 + 去空行）----
  const postProcess = settings.postProcess ?? { trimBlank: true };
  add('post-process', 'post-process', '输出后处理', 'meta', JSON.stringify({ trimBlank: postProcess.trimBlank !== false }, null, 0), 'settings');

  // ---- 手动踢掉某一段 ----
  const drop = new Set(dropSections ?? []);
  const finalSections = drop.size ? sections.filter((section) => !drop.has(section.id)) : sections;
  for (const id of drop) if (sections.some((section) => section.id === id)) notes.push(`X 光机：手动丢掉了「${id}」这一段`);

  // 按阶段顺序稳定排序（同阶段保持生成顺序）。
  const orderOf = (section) => {
    const index = STAGE_IDS.indexOf(section.stage);
    return index < 0 ? STAGE_IDS.length : index;
  };
  finalSections.sort((a, b) => orderOf(a) - orderOf(b));

  const system = finalSections
    // suffix（收尾指令）与 preset-inline（预设排在历史之后的条目、深度注入）已经作为
    // 消息发在对话里了，不要再塞进最前面的系统提示，否则模型会看到两遍。
    .filter((section) => section.role === 'system' && section.stage !== 'suffix' && section.stage !== 'preset-inline')
    .map((section) => section.content)
    .join('\n\n');

  const bySection = {};
  let total = 0;
  for (const section of finalSections) {
    bySection[section.id] = section.tokens;
    total += section.tokens;
  }

  return {
    system,
    messages,
    sections: finalSections,
    tokens: { total, bySection, budget: budget || null },
    notes,
    params: { stopStrings },
  };
}

/** 群聊 APPEND 模式：把成员卡合起来（等价酒馆的 getGroupCharacterCards）。 */
function mergeGroupCards(members, currentCard, mode) {
  const currentMember = members.find((member) => member.card === currentCard || member.card?.name === currentCard?.name);
  const included = mode === 'append_disabled' ? members.filter((member) => !member.muted || member === currentMember) : members;
  const ordered = [currentMember, ...included.filter((member) => member && member !== currentMember)];
  const block = (title, pick) => {
    const parts = [];
    for (const member of ordered) {
      if (!member) continue;
      const value = pick(member.card ?? {});
      if (value && String(value).trim()) parts.push(`[${member.name}]\n${String(value).trim()}`);
    }
    return parts.length ? `${title}:\n${parts.join('\n\n')}` : '';
  };
  return {
    description: [
      `群聊成员：${included.map((member) => member.name).join('、')}`,
      currentMember ? `现在是 ${currentMember.name} 说话。` : '',
      block('描述', (card) => card.description),
      block('性格', (card) => card.personality),
      block('场景', (card) => card.scenario),
    ].filter(Boolean).join('\n\n'),
    examples: ordered.filter(Boolean).map((member) => String(member.card?.mes_example ?? '').trim()).filter(Boolean).join('\n\n'),
  };
}

/** 把状态面板转成给模型看的一行清单（空状态返回空串）。 */
export function describeState(worldState = {}) {
  const parts = [];
  const map = (obj) => Object.entries(obj ?? {}).map(([key, value]) => `${key} ${value}`).join('、');
  const attributes = map(worldState.attributes);
  const affection = map(worldState.affection);
  if (attributes) parts.push(`属性：${attributes}`);
  if (affection) parts.push(`好感度：${affection}`);
  if (worldState.place) parts.push(`地点：${worldState.place}`);
  if (worldState.time) parts.push(`时间：${worldState.time}`);
  const quests = (worldState.quests ?? []).filter((quest) => (quest.status ?? 'active') === 'active').map((quest) => quest.title);
  if (quests.length) parts.push(`进行中的任务：${quests.join('、')}`);
  const items = (worldState.items ?? []).map((item) => (item.qty && item.qty !== 1 ? `${item.name}×${item.qty}` : item.name));
  if (items.length) parts.push(`物品：${items.join('、')}`);
  return parts.join('\n');
}
