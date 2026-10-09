/**
 * 世界书触发引擎（纯逻辑，不认识数据库）。
 *
 * 移植自老项目 core/worldinfo.mjs，并按 SillyTavern `release` 分支
 * `public/scripts/world-info.js` 核对了这些点：
 *   - 位置常量 world_info_position：before=0 after=1 ANTop=2 ANBottom=3 atDepth=4 EMTop=5 EMBottom=6
 *   - 四种次关键词逻辑 world_info_logic：AND_ANY=0 NOT_ALL=1 NOT_ANY=2 AND_ALL=3（约 4938 行的 matchSecondaryKeys）
 *   - 关键词匹配：`/pattern/flags` 当正则；否则大小写按 caseSensitive、整词按 `(?:^|\W)key(?:$|\W)`，
 *     多词整词退化成子串匹配（约 337 行的 matchKeys）
 *   - 扫描深度只看最近 N 条消息，常量条目永远注入，粘性 / 冷却 / 延迟按条目生效
 *   - 分组：groupOverride 直接取胜，其次组内评分，最后按 groupWeight 加权抽签
 *   - 预算：按 order 从高到低装，ignoreBudget 的条目永远进
 * 有意偏离：语义触发（vectorized + semanticThreshold）是蓝图里"比酒馆更进一步"的部分，
 * 这里只留接口 —— 调用方把向量相似度放进 `semanticScores`，命中了就按语义算激活。
 */

import { estimateTokens } from '../chat/tokens.mjs';

export const POSITION = { before: 0, after: 1, ANTop: 2, ANBottom: 3, atDepth: 4, EMTop: 5, EMBottom: 6, outlet: 7 };
export const SELECTIVE_LOGIC = { AND_ANY: 0, NOT_ALL: 1, NOT_ANY: 2, AND_ALL: 3 };

const MAX_SCAN_DEPTH = 1000;

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 把 `/pattern/flags` 解析成正则；不是合法正则就返回 null（当作普通关键词）。 */
export function parseRegexKey(key) {
  if (typeof key !== 'string' || key.length < 2 || !key.startsWith('/')) return null;
  const lastSlash = key.lastIndexOf('/');
  if (lastSlash <= 0) return null;
  const pattern = key.slice(1, lastSlash);
  const flags = key.slice(lastSlash + 1);
  if (!/^[dgimsuvy]*$/.test(flags)) return null;
  try {
    return new RegExp(pattern, flags);
  } catch {
    return null;
  }
}

/** 单条关键词是否命中；行为对齐 ST 的 WorldInfoBuffer#matchKeys。 */
export function matchesKey(key, haystack, { caseSensitive = false, wholeWords = false } = {}) {
  if (!key) return false;
  const regex = parseRegexKey(key);
  if (regex) return regex.test(haystack);
  const hay = caseSensitive ? haystack : haystack.toLowerCase();
  const needle = caseSensitive ? key : key.toLowerCase();
  if (wholeWords && !/\s/.test(needle)) {
    const pattern = caseSensitive ? new RegExp(`(?:^|\\W)(${escapeRegex(needle)})(?:$|\\W)`, 'u')
      : new RegExp(`(?:^|\\W)(${escapeRegex(needle)})(?:$|\\W)`, 'iu');
    return pattern.test(haystack);
  }
  return hay.includes(needle);
}

/** 单条主/次关键词的判定，返回 {matched, detail, score}。 */
function matchEntry(entry, haystack, defaults) {
  const options = {
    caseSensitive: entry.caseSensitive ?? defaults.caseSensitive,
    wholeWords: entry.matchWholeWords ?? defaults.wholeWords,
  };

  if (entry.constant) return { matched: true, detail: 'constant', score: 1000 };
  if (!entry.keys.length) return { matched: false, detail: 'no-keys', score: 0 };

  const primaryHits = entry.keys.filter((key) => matchesKey(key, haystack, options)).length;
  if (primaryHits === 0) return { matched: false, detail: 'no-primary', score: 0 };
  if (!entry.selective || entry.secondaryKeys.length === 0) {
    return { matched: true, detail: 'primary', score: primaryHits };
  }

  const secondaryHits = entry.secondaryKeys.filter((key) => matchesKey(key, haystack, options)).length;
  const total = entry.secondaryKeys.length;
  let matched = false;
  switch (entry.selectiveLogic) {
    case SELECTIVE_LOGIC.NOT_ALL:
      matched = secondaryHits < total;
      break;
    case SELECTIVE_LOGIC.NOT_ANY:
      matched = secondaryHits === 0;
      break;
    case SELECTIVE_LOGIC.AND_ALL:
      matched = secondaryHits === total;
      break;
    case SELECTIVE_LOGIC.AND_ANY:
    default:
      matched = secondaryHits > 0;
      break;
  }
  return { matched, detail: matched ? 'secondary' : 'secondary-miss', score: primaryHits + secondaryHits };
}

/**
 * 激活一次世界书。
 *
 * @param {object} input
 * @param {Array}  input.books          归一化过的书 [{id,name,entries:[normalizeEntry…]}]
 * @param {Array}  input.messages       对话历史，最早在前 [{role,content,name}]
 * @param {string} input.text           本轮额外要扫描的文本（通常是用户刚发的话）
 * @param {object} input.settings       { scanDepth, tokenBudget, tokenBudgetCap, recursive, includeNames, ... }
 * @param {object} input.state          每对话的条目状态（sticky / cooldown 用），会被复制后返回
 * @param {object} input.scanSources    条目可以额外扫描的内容来源
 * @param {object} input.semanticScores { [uid]: 0..1 } 向量相似度（可选）
 * @param {Function} input.rng
 */
export function activateWorldInfo({
  books = [],
  messages = [],
  text = '',
  settings = {},
  state = {},
  scanSources = {},
  semanticScores = {},
  generationType = 'normal',
  rng = Math.random,
} = {}) {
  const defaults = {
    caseSensitive: false,
    wholeWords: false,
    scanDepth: settings.scanDepth ?? 2,
    tokenBudget: settings.tokenBudget ?? Math.round((settings.contextBudget ?? 4096) * 0.25),
    tokenBudgetCap: settings.tokenBudgetCap ?? 0,
    recursive: settings.recursive ?? false,
    maxRecursionPasses: settings.maxRecursionPasses ?? 3,
    includeNames: settings.includeNames ?? true,
    minActivations: settings.minActivations ?? 0,
    minActivationsDepthMax: settings.minActivationsDepthMax ?? 0,
    useGroupScoring: settings.useGroupScoring ?? false,
  };

  const nextState = {};
  for (const [key, value] of Object.entries(state ?? {})) nextState[key] = { ...value };

  const messageIndex = messages.length;
  const candidates = [];
  const trace = new Map();
  const scanCache = new Map();

  const buildHaystack = (depth, extra = '') => {
    const d = Math.min(depth ?? defaults.scanDepth, MAX_SCAN_DEPTH);
    const cacheKey = `${d}|${extra}`;
    if (scanCache.has(cacheKey)) return scanCache.get(cacheKey);
    const slice = d <= 0 ? [] : messages.slice(Math.max(0, messages.length - d));
    const parts = slice.map((message) =>
      defaults.includeNames && message.name ? `${message.name}: ${message.content ?? ''}` : message.content ?? '',
    );
    if (extra) parts.push(extra);
    const result = parts.join('\n').trim();
    scanCache.set(cacheKey, result);
    return result;
  };

  const haystackFor = (entry, base) => {
    const parts = [base];
    if (entry.matchPersonaDescription && scanSources.personaDescription) parts.push(scanSources.personaDescription);
    if (entry.matchCharacterDescription && scanSources.characterDescription) parts.push(scanSources.characterDescription);
    if (entry.matchCharacterPersonality && scanSources.characterPersonality) parts.push(scanSources.characterPersonality);
    if (entry.matchCharacterDepthPrompt && scanSources.characterDepthPrompt) parts.push(scanSources.characterDepthPrompt);
    if (entry.matchScenario && scanSources.scenario) parts.push(scanSources.scenario);
    if (entry.matchCreatorNotes && scanSources.creatorNotes) parts.push(scanSources.creatorNotes);
    return parts.filter(Boolean).join('\n');
  };

  const recordTrace = (book, entry, patch) => {
    const key = `${book.id ?? book.name ?? ''}:${entry.uid}`;
    const existing = trace.get(key) ?? { bookId: book.id ?? null, bookName: book.name ?? '', uid: entry.uid, comment: entry.comment, activated: false };
    trace.set(key, { ...existing, ...patch });
  };

  const collect = (pass, buffer, { allowRecursion = true } = {}) => {
    let activated = 0;
    for (const book of books) {
      for (const entry of book.entries ?? []) {
        if (candidates.some((candidate) => candidate.entry === entry)) continue;
        if (!entry.enabled) {
          recordTrace(book, entry, { activated: false, code: 'disabled', detail: '条目被停用' });
          continue;
        }
        // 按生成动作过滤：只在 continue / swipe / regenerate / quiet 等特定动作下激活。
        // 没声明 injectionTrigger 的条目在任何动作下都生效。
        if (Array.isArray(entry.injectionTrigger) && entry.injectionTrigger.length > 0) {
          const wanted = String(generationType ?? 'normal').toLowerCase();
          if (!entry.injectionTrigger.map((item) => String(item).toLowerCase()).includes(wanted)) {
            recordTrace(book, entry, {
              activated: false,
              code: 'generation-trigger',
              detail: `只在 ${entry.injectionTrigger.join(' / ')} 时激活，本轮是 ${wanted}`,
            });
            continue;
          }
        }
        if (pass > 0 && entry.preventRecursion) continue;
        if (pass === 0 && entry.delayUntilRecursion && defaults.recursive) continue;

        const entryState = nextState[entry.uid] ?? {};

        // delay：对话还没长够之前这条不参与
        if (entry.delay > 0 && entryState.lastSeenIndex === undefined && messageIndex < entry.delay) {
          recordTrace(book, entry, { activated: false, code: 'delay', detail: `延迟 ${entry.delay} 轮，现在才第 ${messageIndex} 轮` });
          continue;
        }

        const base = entry.scanDepth === null || entry.scanDepth === undefined ? buffer : buildHaystack(entry.scanDepth, text);
        const haystack = haystackFor(entry, base);
        const semanticScore = Number(semanticScores[entry.uid]);
        const semanticHit = entry.vectorized && Number.isFinite(semanticScore)
          && semanticScore >= (entry.semanticThreshold ?? 0.6);

        const result = semanticHit ? { matched: true, detail: 'semantic', score: 999 } : matchEntry(entry, haystack, defaults);
        if (!result.matched) {
          // sticky：命中后还能继续生效 N 轮
          if (entry.sticky > 0 && entryState.lastSeenIndex !== undefined && messageIndex - entryState.lastSeenIndex <= entry.sticky) {
            candidates.push({ entry, book, score: 1, sticky: true });
            recordTrace(book, entry, { activated: true, code: 'sticky', detail: `粘性生效（最近一次命中在第 ${entryState.lastSeenIndex} 轮）` });
            continue;
          }
          recordTrace(book, entry, { activated: false, code: result.detail, detail: describeMiss(result.detail) });
          continue;
        }

        // cooldown：命中后 N 轮内不许再触发
        if (entry.cooldown > 0 && entryState.lastSeenIndex !== undefined && messageIndex - entryState.lastSeenIndex < entry.cooldown) {
          recordTrace(book, entry, { activated: false, code: 'cooldown', detail: `冷却中（还差 ${entry.cooldown - (messageIndex - entryState.lastSeenIndex)} 轮）` });
          continue;
        }

        if (entry.useProbability && entry.probability < 100 && rng() * 100 >= entry.probability) {
          recordTrace(book, entry, { activated: false, code: 'probability', detail: `概率 ${entry.probability}% 没抽中` });
          continue;
        }

        nextState[entry.uid] = { ...entryState, lastSeenIndex: messageIndex };
        candidates.push({ entry, book, score: result.score, pass });
        recordTrace(book, entry, { activated: true, code: result.detail, detail: describeHit(result.detail, result.score) });
        activated++;
      }
    }
    return activated;
  };

  collect(0, buildHaystack(null, text));

  if (defaults.minActivations > 0) {
    const ceiling = defaults.minActivationsDepthMax > 0 ? Math.min(defaults.minActivationsDepthMax, messages.length) : messages.length;
    let depth = defaults.scanDepth;
    while (candidates.length < defaults.minActivations && depth < ceiling) {
      depth++;
      collect(0, buildHaystack(depth, text), { allowRecursion: false });
    }
  }

  if (defaults.recursive) {
    for (let pass = 1; pass <= defaults.maxRecursionPasses; pass++) {
      const before = candidates.length;
      const buffer = candidates.filter((candidate) => !candidate.entry.excludeRecursion).map((candidate) => candidate.entry.content).join('\n');
      if (!buffer) break;
      collect(pass, `${buildHaystack(null, text)}\n${buffer}`);
      if (candidates.length === before) break;
    }
  }

  // ---- 分组：一组最多出一条 ----
  const byGroup = new Map();
  const resolved = [];
  for (const candidate of candidates) {
    if (!candidate.entry.group) {
      resolved.push(candidate);
      continue;
    }
    if (!byGroup.has(candidate.entry.group)) byGroup.set(candidate.entry.group, []);
    byGroup.get(candidate.entry.group).push(candidate);
  }
  for (const group of byGroup.values()) {
    if (group.length === 1) {
      resolved.push(group[0]);
      continue;
    }
    const overrides = group.filter((candidate) => candidate.entry.groupOverride).sort((a, b) => b.entry.order - a.entry.order);
    if (overrides.length) {
      resolved.push(overrides[0]);
      for (const candidate of group) if (candidate !== overrides[0]) recordTrace(candidate.book, candidate.entry, { activated: false, code: 'group', detail: '同组有更高优先级的覆盖条目' });
      continue;
    }
    let pool = group;
    const scored = group.filter((candidate) => candidate.entry.useGroupScoring ?? defaults.useGroupScoring);
    if (scored.length) {
      const best = Math.max(...group.map((candidate) => candidate.score));
      pool = group.filter((candidate) => !(candidate.entry.useGroupScoring ?? defaults.useGroupScoring) || candidate.score >= best);
    }
    const total = pool.reduce((sum, candidate) => sum + Math.max(1, candidate.entry.groupWeight), 0);
    let roll = rng() * total;
    let chosen = pool[pool.length - 1];
    for (const candidate of pool) {
      roll -= Math.max(1, candidate.entry.groupWeight);
      if (roll <= 0) {
        chosen = candidate;
        break;
      }
    }
    resolved.push(chosen);
    for (const candidate of group) if (candidate !== chosen) recordTrace(candidate.book, candidate.entry, { activated: false, code: 'group', detail: '同组抽签没被选中' });
  }

  // ---- 预算：order 高的先装 ----
  const sorted = resolved.slice().sort((a, b) => (b.entry.order - a.entry.order) || (a.entry.uid - b.entry.uid));
  const budget = defaults.tokenBudgetCap > 0 ? Math.min(defaults.tokenBudget, defaults.tokenBudgetCap) : defaults.tokenBudget;
  const accepted = [];
  let used = 0;
  for (const candidate of sorted) {
    const cost = estimateTokens(candidate.entry.content);
    if (candidate.entry.ignoreBudget) {
      used += cost;
      accepted.push(candidate);
      continue;
    }
    if (used + cost > budget && accepted.length > 0) {
      recordTrace(candidate.book, candidate.entry, { activated: false, code: 'budget', detail: `超出预算（${budget} token）` });
      continue;
    }
    used += cost;
    accepted.push(candidate);
  }
  accepted.sort((a, b) => (a.entry.order - b.entry.order) || (a.entry.uid - b.entry.uid));

  const result = { entries: [], before: [], after: [], atDepth: [], examples: [], tokenCount: used, state: nextState, reasons: [...trace.values()] };
  for (const candidate of accepted) {
    const { entry, book } = candidate;
    const content = String(entry.content ?? '').trim();
    const item = { ...entry, content, bookId: book.id ?? null, bookName: book.name ?? '' };
    result.entries.push(item);
    if (!content) continue;
    switch (entry.position) {
      case POSITION.atDepth:
        result.atDepth.push({ depth: Math.max(0, entry.depth), role: entry.role ?? 0, content, name: entry.comment || '世界书' });
        break;
      case POSITION.EMTop:
      case POSITION.EMBottom:
        result.examples.push({ content, bottom: entry.position === POSITION.EMBottom });
        break;
      case POSITION.after:
      case POSITION.ANBottom:
        result.after.push(content);
        break;
      default:
        result.before.push(content);
        break;
    }
  }
  return result;
}

function describeHit(detail, score) {
  switch (detail) {
    case 'constant': return '常量条目，永远注入';
    case 'semantic': return '语义相似度过线';
    case 'secondary': return `主关键词 + 次关键词都满足（得分 ${score}）`;
    default: return `主关键词命中（得分 ${score}）`;
  }
}

function describeMiss(detail) {
  switch (detail) {
    case 'no-keys': return '没有主关键词，也不是常量条目';
    case 'no-primary': return '主关键词没命中';
    case 'secondary-miss': return '主关键词命中，但次关键词逻辑不满足';
    default: return '没有命中';
  }
}

/** 纯文本渲染（给没有位置概念的老管线兜底用）。 */
export function renderWorldInfoBlock(sections, header = '') {
  const body = [...(sections.before ?? []), ...(sections.after ?? [])].filter(Boolean).join('\n');
  if (!body) return '';
  return header ? `${header}\n${body}` : body;
}
