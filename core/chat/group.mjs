/**
 * 群聊的说话策略 —— 移植自 SillyTavern `release` 分支
 * `public/scripts/group-chats.js`（AGPL-3.0，见 NOTICE.md）。
 *
 * 对齐的是这几件事（逐条对着 release 源码核对过）：
 *   - `group_activation_strategy = { NATURAL:0, LIST:1, MANUAL:2, POOLED:3 }`
 *   - `group_generation_mode   = { SWAP:0, APPEND:1, APPEND_DISABLED:2 }`
 *   - `activateNaturalOrder`：先看有没有人被我点名，再按 talkativeness 逐个掷骰子，
 *     一个都没激活时从"话多的人"里随机挑一个；上一位说话者默认不能连说
 *     （除非开了 allow_self_responses 或这轮是我发的言）。
 *   - `activateListOrder`：按成员顺序所有人都回。
 *   - `activatePooledOrder`：优先挑"我说话之后还没开口的"。
 *   - talkativeness 是 0~1 的概率（默认 0.5），不是权重。
 *
 * 有意偏离（都写在注释里）：
 *   1. 酒馆用 avatar 文件名当成员标识，这里用成员 id / characterId。
 *   2. 酒馆的 `extractAllWords` 是英文式分词，中文名点不到。这里在词集合命中之外
 *      补一条"整串包含"，让"阿狸"这种两字名也能被点名激活。
 *   3. `combineGroupCards`（APPEND 模式）在酒馆里是给实时预览 UI 用的惰性 getter 链，
 *      带逐字段前缀后缀替换。这里改成普通函数，产出的信息等价（谁在场、谁在说话、
 *      各字段按成员拼接），但不保证逐字节一致。
 */

/** 说话策略。`mixed` 对应酒馆的 POOLED。 */
export const GROUP_STRATEGIES = [
  { id: 'natural', title: '自然', stValue: 0, summary: '点名优先，其余按活跃度掷骰子' },
  { id: 'list', title: '列表', stValue: 1, summary: '按成员顺序，每个人都说一句' },
  { id: 'manual', title: '手动', stValue: 2, summary: '谁开口由我点' },
  { id: 'mixed', title: '混合', stValue: 3, summary: '优先让还没开口的人接话' },
];

export const GROUP_MODES = [
  { id: 'swap', title: '只带当前角色', stValue: 0, summary: '提示词里只放正在说话那个人的卡，最省 token、最不串味' },
  { id: 'append', title: '合并所有角色', stValue: 1, summary: '把在场所有角色的卡并成一份，模型看得见全场' },
  { id: 'append_disabled', title: '合并（跳过静音）', stValue: 2, summary: '同上，但静音的成员不写进提示词' },
];

export const DEFAULT_AUTO_MODE_DELAY = 5;
export const DEFAULT_TALKATIVENESS = 0.5;
export const DEFAULT_GROUP_NUDGE = '[Write the next reply only as {{char}}.]';

export function strategyById(id) {
  return GROUP_STRATEGIES.find((item) => item.id === id) ?? GROUP_STRATEGIES[0];
}

export function modeById(id) {
  return GROUP_MODES.find((item) => item.id === id) ?? GROUP_MODES[0];
}

const onlyUnique = (value, index, self) => self.indexOf(value) === index;

/** 粗略分词：英文按非字母数字切开，CJK 整段保留。 */
export function extractWords(text) {
  return String(text ?? '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/**
 * 名字命中：词集合相交，或整串包含。
 * 整串包含是为中文名补的（见文件头的"有意偏离 2"）。
 */
export function mentionsName(input, name) {
  const needle = String(name ?? '').trim().toLowerCase();
  if (!needle) return false;
  const haystack = String(input ?? '').toLowerCase();
  if (!haystack) return false;
  if (haystack.includes(needle)) return true;
  const nameWords = new Set(extractWords(needle));
  return extractWords(haystack).some((word) => nameWords.has(word));
}

function shuffled(list, rng) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function talkativenessOf(member) {
  const value = Number(member?.talkativeness);
  if (!Number.isFinite(value)) return DEFAULT_TALKATIVENESS;
  return Math.min(1, Math.max(0, value));
}

/**
 * 自然顺序。返回这一轮该开口的成员数组（可能不止一个，和酒馆一致）。
 */
export function activateNaturalOrder(members, { input = '', lastSpeakerName = null, allowSelfResponses = false, isUserInput = true, rng = Math.random } = {}) {
  const activated = [];
  const bannedName = !isUserInput && !allowSelfResponses ? lastSpeakerName : null;
  const eligible = members.filter((member) => member.name !== bannedName);

  if (input) {
    const words = extractWords(input);
    for (const member of eligible) {
      const nameWords = extractWords(member.name);
      // 词命中（酒馆原逻辑）+ 整串包含（中文名兜底，见文件头"有意偏离 2"）
      if (nameWords.some((word) => words.includes(word)) || mentionsName(input, member.name)) {
        activated.push(member);
      }
    }
  }

  const chatty = [];
  for (const member of shuffled(eligible, rng)) {
    if (activated.includes(member)) continue;
    const talkativeness = talkativenessOf(member);
    if (talkativeness >= rng()) activated.push(member);
    if (talkativeness > 0) chatty.push(member);
  }

  // 一个都没激活时，从"话多的人"里随机挑一个（避免整轮没人说话）
  let retries = 0;
  const pool = chatty.length ? chatty : members;
  while (!activated.length && pool.length && ++retries <= pool.length) {
    const pick = pool[Math.floor(rng() * pool.length)];
    if (pick) activated.push(pick);
  }

  return activated.filter(onlyUnique);
}

/** 列表顺序：所有人都回。 */
export function activateListOrder(members) {
  return members.filter(onlyUnique);
}

/** 我说话之后已经开过口的人（新到旧）—— mixed 策略的输入。 */
export function spokenSinceUser(messages = []) {
  const spoken = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === 'user' && !message.isSystem) break;
    if (message.role !== 'assistant') continue;
    if (message.characterId !== undefined && message.characterId !== null) spoken.push(message.characterId);
  }
  return spoken;
}

/** 混合顺序：优先没开口的；都开口了就随机挑一个（不连续同一个人）。 */
export function activatePooledOrder(members, { spokenSinceUser: spoken = [], lastSpeakerId = null, rng = Math.random } = {}) {
  const haveNotSpoken = members.filter((member) => !spoken.includes(member.characterId) && !spoken.includes(member.id));
  if (haveNotSpoken.length) return haveNotSpoken[Math.floor(rng() * haveNotSpoken.length)];
  const pool =
    members.length > 1 && lastSpeakerId !== null
      ? members.filter((member) => member.characterId !== lastSpeakerId && member.id !== lastSpeakerId)
      : members;
  const usable = pool.length ? pool : members;
  return usable[Math.floor(rng() * usable.length)] ?? null;
}

/**
 * 这一轮谁开口。
 * @returns {Array} 该开口的成员（manual 返回空，等前端点名）
 */
export function activateMembers({
  members = [],
  strategy = 'natural',
  messages = [],
  input = '',
  isUserInput = true,
  allowSelfResponses = false,
  forcedId = null,
  rng = Math.random,
} = {}) {
  if (forcedId) {
    const forced = members.find((member) => member.id === forcedId || member.characterId === forcedId);
    return forced ? [forced] : [];
  }
  if (!members.length) return [];

  const lastAssistant = [...messages].reverse().find((message) => message.role === 'assistant');
  const lastSpeakerId = lastAssistant?.characterId ?? null;
  const lastSpeakerName = lastAssistant?.name ?? null;

  switch (strategy) {
    case 'list':
      return activateListOrder(members);
    case 'manual':
      return [];
    case 'mixed': {
      const pick = activatePooledOrder(members, { spokenSinceUser: spokenSinceUser(messages), lastSpeakerId, rng });
      return pick ? [pick] : [];
    }
    case 'natural':
    default:
      return activateNaturalOrder(members, { input, lastSpeakerName, allowSelfResponses, isUserInput, rng });
  }
}

/** 单个发言者版本，给"手动 / 自动模式"用。 */
export function pickSpeaker(options = {}) {
  return activateMembers(options)[0] ?? null;
}

/**
 * APPEND 模式：把在场成员的卡合成一份，当前说话者排在最前。
 * 对应酒馆的 `getGroupCharacterCards`（见文件头"有意偏离 3"）。
 */
export function combineGroupCards(members, currentMemberId = null) {
  const ordered = [
    ...members.filter((member) => member.id === currentMemberId),
    ...members.filter((member) => member.id !== currentMemberId),
  ];
  const block = (title, pick) => {
    const parts = [];
    for (const member of ordered) {
      const value = pick(member.card ?? {});
      if (value && String(value).trim()) parts.push(`[${member.name}]\n${String(value).trim()}`);
    }
    return parts.length ? `${title}:\n${parts.join('\n\n')}` : null;
  };

  const sections = [
    block('描述', (card) => card.description),
    block('性格', (card) => card.personality),
    block('场景', (card) => card.scenario),
  ].filter(Boolean);

  const current = ordered.find((member) => member.id === currentMemberId);
  const header = `群聊成员：${members.map((member) => member.name).join('、')}`;
  const speaking = current ? `现在由 ${current.name} 说话。` : '';
  return {
    description: [header, speaking, ...sections].filter(Boolean).join('\n\n'),
    examples: ordered
      .map((member) => String(member.card?.mes_example ?? '').trim())
      .filter(Boolean)
      .join('\n\n'),
  };
}
