/**
 * 世界书的两种存储形状与内部结构之间的转换（纯逻辑）。
 *
 * 两种形状：
 *   - tavern：酒馆导出的世界书文件。entries 是以 uid 为键的对象，
 *             字段用 key / keysecondary / order / disable / selectiveLogic 这一套。
 *   - card  ：角色卡内嵌的 character_book。entries 是数组，
 *             字段用 keys / secondary_keys / insertion_order / enabled，
 *             大部分高级字段塞在 extensions 里（snake_case）。
 *
 * 字段对应关系逐条对照 SillyTavern `release` 分支 `public/scripts/world-info.js`
 * 的 `originalWIDataKeyMap`（约 2687 行）与 `convertCharacterBook`（约 5617 行）。
 *
 * 未知字段不丢：每个条目解析时把不认识的键收进 `unknown` / `unknownExtensions`，
 * 写回任意一种形状时先铺开它们再覆盖已知字段。
 */

export const POSITION = {
  before: 0,
  after: 1,
  ANTop: 2,
  ANBottom: 3,
  atDepth: 4,
  EMTop: 5,
  EMBottom: 6,
  outlet: 7,
};

export const SELECTIVE_LOGIC = { AND_ANY: 0, NOT_ALL: 1, NOT_ANY: 2, AND_ALL: 3 };

export const POSITION_OPTIONS = [
  { value: POSITION.before, label: '角色定义之前' },
  { value: POSITION.after, label: '角色定义之后' },
  { value: POSITION.ANTop, label: '作者注顶部' },
  { value: POSITION.ANBottom, label: '作者注底部' },
  { value: POSITION.atDepth, label: '指定深度' },
  { value: POSITION.EMTop, label: '示例对话顶部' },
  { value: POSITION.EMBottom, label: '示例对话底部' },
];

export const LOGIC_OPTIONS = [
  { value: SELECTIVE_LOGIC.AND_ANY, label: '任一命中（AND ANY）' },
  { value: SELECTIVE_LOGIC.NOT_ALL, label: '非全中（NOT ALL）' },
  { value: SELECTIVE_LOGIC.NOT_ANY, label: '全不中（NOT ANY）' },
  { value: SELECTIVE_LOGIC.AND_ALL, label: '全中（AND ALL）' },
];

export const MATCH_SOURCES = [
  { key: 'matchPersonaDescription', label: '我的人设' },
  { key: 'matchCharacterDescription', label: '角色简介' },
  { key: 'matchCharacterPersonality', label: '角色性格' },
  { key: 'matchCharacterDepthPrompt', label: '角色深度提示' },
  { key: 'matchScenario', label: '场景' },
  { key: 'matchCreatorNotes', label: '作者备注' },
];

const POSITION_BY_NAME = {
  before_char: POSITION.before,
  after_char: POSITION.after,
  before_an: POSITION.ANTop,
  after_an: POSITION.ANBottom,
  at_depth: POSITION.atDepth,
  em_top: POSITION.EMTop,
  em_bottom: POSITION.EMBottom,
};

const TAVERN_KNOWN = new Set([
  'uid', 'key', 'keysecondary', 'comment', 'content', 'constant', 'disable', 'selective',
  'selectiveLogic', 'order', 'position', 'depth', 'probability', 'useProbability', 'group',
  'groupOverride', 'groupWeight', 'scanDepth', 'caseSensitive', 'matchWholeWords',
  'useGroupScoring', 'ignoreBudget', 'excludeRecursion', 'preventRecursion',
  'delayUntilRecursion', 'vectorized', 'sticky', 'cooldown', 'delay', 'role', 'extensions',
  'outletName',
]);

const CARD_KNOWN = new Set([
  'id', 'keys', 'secondary_keys', 'comment', 'content', 'constant', 'selective',
  'insertion_order', 'enabled', 'position', 'use_regex', 'extensions',
]);

const CARD_EXTENSION_KNOWN = new Set([
  'position', 'depth', 'probability', 'useProbability', 'selectiveLogic', 'group',
  'group_override', 'group_weight', 'scan_depth', 'case_sensitive', 'match_whole_words',
  'use_group_scoring', 'automation_id', 'role', 'vectorized', 'sticky', 'cooldown', 'delay',
  'exclude_recursion', 'prevent_recursion', 'delay_until_recursion', 'ignore_budget',
  'match_persona_description',
  'match_character_description', 'match_character_personality', 'match_character_depth_prompt',
  'match_scenario', 'match_creator_notes',
]);

function toArray(value) {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.map((item) => String(item)).filter((item) => item.length);
  if (typeof value === 'string') {
    // 有些第三方导出把关键词写成逗号分隔的一整串。
    return value.split(',').map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function boolOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  return Boolean(value);
}

/** 三种命名都认的布尔开关：extensions.snake / raw.snake / raw.camel。 */
function flagOf(extensions, raw, snake, camel) {
  const value = extensions?.[snake] ?? raw?.[snake] ?? raw?.[camel];
  return value === undefined || value === null ? false : Boolean(value);
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizePosition(value, fallback = POSITION.before) {
  if (typeof value === 'string' && POSITION_BY_NAME[value] !== undefined) return POSITION_BY_NAME[value];
  const n = numberOrNull(value);
  return n === null ? fallback : n;
}

/** 判断一份原始文档是酒馆形状还是卡内形状。 */
export function detectShape(doc) {
  const entries = doc?.entries;
  if (Array.isArray(entries)) return 'card';
  if (entries && typeof entries === 'object') return 'tavern';
  return Array.isArray(doc?.character_book?.entries) ? 'card' : 'tavern';
}

/**
 * 归一化一个条目。
 * @param {object} raw 原始条目（酒馆或卡内形状）
 * @param {string} shape
 * @param {number} index
 */
export function normalizeEntry(raw = {}, shape = 'tavern', index = 0) {
  const extensions = raw.extensions && typeof raw.extensions === 'object' ? raw.extensions : {};
  const isCard = shape === 'card';

  // 三种写法都认：酒馆的 key/keysecondary、卡内的 keys/secondary_keys、
  // 以及界面编辑时用的归一化 camelCase（keys/secondaryKeys）。
  const keys = toArray(raw.keys ?? raw.key);
  const secondaryKeys = toArray(raw.secondary_keys ?? raw.keysecondary ?? raw.secondaryKeys);
  const enabled = raw.enabled !== undefined ? Boolean(raw.enabled) : raw.disable !== undefined ? !raw.disable : true;

  const known = isCard ? CARD_KNOWN : TAVERN_KNOWN;
  const unknown = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!known.has(key)) unknown[key] = value;
  }
  const unknownExtensions = {};
  for (const [key, value] of Object.entries(extensions)) {
    if (!CARD_EXTENSION_KNOWN.has(key)) unknownExtensions[key] = value;
  }

  const pick = (camel, snake, fallback) =>
    raw[camel] ?? raw[snake] ?? extensions[camel] ?? extensions[snake] ?? fallback;

  const normalized = {
    uid: raw.uid ?? raw.id ?? index,
    index,
    keys,
    secondaryKeys,
    content: String(raw.content ?? ''),
    comment: String(raw.comment ?? raw.name ?? ''),
    enabled,
    constant: Boolean(raw.constant),
    selective: raw.selective !== undefined ? Boolean(raw.selective) : secondaryKeys.length > 0,
    selectiveLogic: Number(pick('selectiveLogic', 'selectiveLogic', SELECTIVE_LOGIC.AND_ANY)) || 0,
    order: Number(raw.order ?? raw.insertion_order ?? 100) || 0,
    position: isCard && raw.position !== undefined && typeof raw.position === 'string'
      ? normalizePosition(raw.position)
      : normalizePosition(extensions.position ?? raw.position),
    depth: numberOrNull(extensions.depth ?? raw.depth) ?? 4,
    role: numberOrNull(extensions.role ?? raw.role),
    probability: numberOrNull(extensions.probability ?? raw.probability) ?? 100,
    useProbability: boolOrNull(extensions.useProbability ?? raw.useProbability) ?? true,
    caseSensitive: boolOrNull(raw.caseSensitive ?? raw.case_sensitive ?? extensions.case_sensitive) ?? false,
    matchWholeWords: boolOrNull(raw.matchWholeWords ?? raw.match_whole_words ?? extensions.match_whole_words),
    scanDepth: numberOrNull(raw.scanDepth ?? raw.scan_depth ?? extensions.scan_depth),
    group: String(pick('group', 'group', '') ?? ''),
    groupOverride: Boolean(pick('groupOverride', 'group_override', false)),
    groupWeight: numberOrNull(pick('groupWeight', 'group_weight', 100)) ?? 100,
    useGroupScoring: boolOrNull(pick('useGroupScoring', 'use_group_scoring', null)),
    ignoreBudget: Boolean(pick('ignoreBudget', 'ignore_budget', false)),
    excludeRecursion: Boolean(pick('excludeRecursion', 'exclude_recursion', false)),
    preventRecursion: Boolean(pick('preventRecursion', 'prevent_recursion', false)),
    delayUntilRecursion: Boolean(pick('delayUntilRecursion', 'delay_until_recursion', false)),
    vectorized: Boolean(pick('vectorized', 'vectorized', false)),
    sticky: numberOrNull(raw.sticky ?? extensions.sticky) ?? 0,
    cooldown: numberOrNull(raw.cooldown ?? extensions.cooldown) ?? 0,
    delay: numberOrNull(raw.delay ?? extensions.delay) ?? 0,
    // 只在特定生成动作下激活（normal / continue / impersonate / swipe / regenerate / quiet）。
    // 空数组 = 任何动作都生效。原样保留在 extensions 里，所以导出不会丢。
    injectionTrigger: (() => {
      const value = pick('injectionTrigger', 'injection_trigger', extensions.injection_trigger ?? null);
      if (Array.isArray(value)) return value.map((item) => String(item).trim().toLowerCase()).filter(Boolean);
      if (typeof value === 'string') return value.split(/[,，]/).map((item) => item.trim().toLowerCase()).filter(Boolean);
      return [];
    })(),
    automationId: String(pick('automationId', 'automation_id', '') ?? ''),
    // 这些"额外扫描来源"的开关在卡里存 extensions.match_*，界面上是 camelCase。
    matchPersonaDescription: flagOf(extensions, raw, 'match_persona_description', 'matchPersonaDescription'),
    matchCharacterDescription: flagOf(extensions, raw, 'match_character_description', 'matchCharacterDescription'),
    matchCharacterPersonality: flagOf(extensions, raw, 'match_character_personality', 'matchCharacterPersonality'),
    matchCharacterDepthPrompt: flagOf(extensions, raw, 'match_character_depth_prompt', 'matchCharacterDepthPrompt'),
    matchScenario: flagOf(extensions, raw, 'match_scenario', 'matchScenario'),
    matchCreatorNotes: flagOf(extensions, raw, 'match_creator_notes', 'matchCreatorNotes'),
    semanticThreshold: numberOrNull(raw.semanticThreshold ?? raw.semantic_threshold),
    unknown,
    unknownExtensions,
  };
  // 把不认识的键也铺在条目上（已知字段优先），这样界面与调用方不用再翻 unknown。
  return { ...unknown, ...normalized };
}

/** 归一化整份世界书文档。 */
export function normalizeWorldBook(doc = {}, fallbackName = '未命名世界书') {
  const source = doc?.character_book && !doc.entries ? doc.character_book : doc;
  const shape = detectShape(source);
  const rawEntries = Array.isArray(source?.entries) ? source.entries : Object.values(source?.entries ?? {});
  const entries = rawEntries.map((entry, index) => normalizeEntry(entry ?? {}, shape, index));
  return {
    shape,
    name: String(source?.name ?? doc?.name ?? fallbackName),
    description: String(source?.description ?? ''),
    scanDepth: numberOrNull(source?.scan_depth ?? source?.scanDepth),
    tokenBudget: numberOrNull(source?.token_budget ?? source?.tokenBudget),
    recursiveScanning: Boolean(source?.recursive_scanning ?? source?.recursiveScanning),
    entries,
  };
}

function matchSourceExtensions(entry) {
  const out = {};
  const map = {
    match_persona_description: entry.matchPersonaDescription,
    match_character_description: entry.matchCharacterDescription,
    match_character_personality: entry.matchCharacterPersonality,
    match_character_depth_prompt: entry.matchCharacterDepthPrompt,
    match_scenario: entry.matchScenario,
    match_creator_notes: entry.matchCreatorNotes,
  };
  for (const [key, value] of Object.entries(map)) if (value) out[key] = true;
  return out;
}

/** 内部条目 → 酒馆形状的条目对象。 */
export function entryToTavern(entry) {
  return {
    ...entry.unknown,
    uid: entry.uid,
    key: [...entry.keys],
    keysecondary: [...entry.secondaryKeys],
    comment: entry.comment,
    content: entry.content,
    constant: entry.constant,
    disable: !entry.enabled,
    selective: entry.selective,
    selectiveLogic: entry.selectiveLogic,
    order: entry.order,
    position: entry.position,
    depth: entry.depth,
    probability: entry.probability,
    useProbability: entry.useProbability,
    group: entry.group,
    groupOverride: entry.groupOverride,
    groupWeight: entry.groupWeight,
    scanDepth: entry.scanDepth,
    caseSensitive: entry.caseSensitive,
    matchWholeWords: entry.matchWholeWords,
    useGroupScoring: entry.useGroupScoring,
    ignoreBudget: entry.ignoreBudget,
    excludeRecursion: entry.excludeRecursion,
    preventRecursion: entry.preventRecursion,
    delayUntilRecursion: entry.delayUntilRecursion,
    vectorized: entry.vectorized,
    sticky: entry.sticky,
    cooldown: entry.cooldown,
    delay: entry.delay,
    role: entry.role,
    automationId: entry.automationId,
    extensions: { ...entry.unknownExtensions },
  };
}

/** 内部条目 → 卡内（character_book）形状的条目。 */
export function entryToCard(entry, index = 0) {
  const extensions = {
    ...entry.unknownExtensions,
    position: entry.position,
    depth: entry.depth,
    probability: entry.probability,
    useProbability: entry.useProbability,
    selectiveLogic: entry.selectiveLogic,
    group: entry.group,
    group_override: entry.groupOverride,
    group_weight: entry.groupWeight,
    scan_depth: entry.scanDepth,
    case_sensitive: entry.caseSensitive,
    match_whole_words: entry.matchWholeWords,
    use_group_scoring: entry.useGroupScoring,
    ignore_budget: entry.ignoreBudget,
    exclude_recursion: entry.excludeRecursion,
    prevent_recursion: entry.preventRecursion,
    delay_until_recursion: entry.delayUntilRecursion,
    role: entry.role,
    vectorized: entry.vectorized,
    sticky: entry.sticky,
    cooldown: entry.cooldown,
    delay: entry.delay,
    automation_id: entry.automationId,
    ...matchSourceExtensions(entry),
  };
  // 去掉空值，别把一堆 null 写进卡里。
  for (const key of Object.keys(extensions)) if (extensions[key] === null || extensions[key] === undefined) delete extensions[key];
  return {
    ...entry.unknown,
    id: typeof entry.uid === 'number' ? entry.uid : index,
    keys: [...entry.keys],
    secondary_keys: [...entry.secondaryKeys],
    comment: entry.comment,
    content: entry.content,
    constant: entry.constant,
    selective: entry.selective,
    insertion_order: entry.order,
    enabled: entry.enabled,
    position: entry.position === POSITION.after ? 'after_char' : 'before_char',
    extensions,
  };
}

/** 内部书 → 酒馆形状文档。 */
export function toTavernDocument(book) {
  const entries = {};
  book.entries.forEach((entry, index) => {
    const uid = entry.uid !== undefined && entry.uid !== null ? entry.uid : index;
    entries[uid] = entryToTavern(entry);
  });
  return {
    name: book.name,
    description: book.description ?? '',
    scan_depth: book.scanDepth ?? null,
    token_budget: book.tokenBudget ?? null,
    recursive_scanning: Boolean(book.recursiveScanning),
    entries,
  };
}

/** 内部书 → 卡内形状文档（可直接塞进角色卡的 data.character_book）。 */
export function toCardDocument(book) {
  return {
    name: book.name,
    description: book.description ?? '',
    scan_depth: book.scanDepth ?? null,
    token_budget: book.tokenBudget ?? null,
    recursive_scanning: Boolean(book.recursiveScanning),
    entries: book.entries.map((entry, index) => entryToCard(entry, index)),
  };
}

/** 把一份文档转成另一种形状（未知字段一路带着走）。 */
export function convertDocument(doc, targetShape) {
  const book = normalizeWorldBook(doc);
  return targetShape === 'card' ? toCardDocument(book) : toTavernDocument(book);
}

/**
 * 把编辑过的条目合并回原始文档，保持原始形状与未知字段。
 * 返回新的文档对象（不改原对象）。
 */
export function applyEntryToDocument(doc, entryPatch) {
  const source = doc?.character_book && !doc.entries ? doc.character_book : doc;
  const shape = detectShape(source);
  const isCard = shape === 'card';
  const next = structuredClone(source);

  const list = isCard ? next.entries ?? [] : Object.values(next.entries ?? {});
  const match = list.find((entry, index) => String(entry?.uid ?? entry?.id ?? index) === String(entryPatch.uid));
  const index = match ? list.indexOf(match) : list.length;
  const rawEntry = match ?? {};

  const mapped = patchToRaw(entryPatch, shape);
  const mergedRaw = {
    ...rawEntry,
    ...mapped,
    // extensions 要合并而不是覆盖，否则原始条目里没被我们认出来的扩展字段会丢。
    extensions: { ...(rawEntry.extensions ?? {}), ...(mapped.extensions ?? {}) },
  };
  const normalized = normalizeEntry(mergedRaw, shape, index);
  const merged = isCard ? entryToCard(normalized, index) : entryToTavern(normalized);

  if (isCard) {
    if (!Array.isArray(next.entries)) next.entries = [];
    if (match) next.entries[index] = merged;
    else next.entries.push(merged);
  } else {
    if (!next.entries || typeof next.entries !== 'object') next.entries = {};
    const key = merged.uid !== undefined && merged.uid !== null ? merged.uid : index;
    next.entries[key] = merged;
  }
  return next;
}

/** 内部条目字段 → 该形状认识的键（用于合并到原始条目上）。 */
function patchToRaw(entry, shape) {
  if (shape === 'card') {
    return {
      keys: entry.keys,
      secondary_keys: entry.secondaryKeys,
      comment: entry.comment,
      content: entry.content,
      constant: entry.constant,
      selective: entry.selective,
      insertion_order: entry.order,
      enabled: entry.enabled,
      extensions: { ...entryToCard(entry).extensions },
    };
  }
  return entryToTavern(entry);
}
