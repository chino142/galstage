/**
 * 月度与年度报告的纯逻辑。
 *
 * 结构借鉴了 Skerry 的年报（src/pages/AnnualReport/reportData.ts，AGPL-3.0）：
 * 先喂进来"按天 / 按维度的原始聚合"，再在这里算成一份报告对象（活跃天数、最长连续、
 * 峰值日、Top 榜、时段分布）。口径换成 AI 角色扮演的那套 —— 轮数 / token / 花费 /
 * 陪伴 / 写卡 / 出图，而不是玩游戏的时长。
 *
 * 这里只做计算，不碰数据库也不碰 HTTP：原始聚合由 server/db/review.mjs 出。
 * 时间口径跟「花费与统计」一致，见 server/db/review.mjs 顶部说明。
 */

export const REVIEW_SCOPES = ['month', 'year', 'all'];
export const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

/** 本地某天 00:00 对应的 UTC 瞬时：拿它当"这个月 / 这一年"的边界。 */
function localBoundary(year, monthIndex, day = 1) {
  return new Date(year, monthIndex, day, 0, 0, 0, 0).toISOString();
}

/**
 * 把 (scope, period) 归一成报告区间。
 * 区间是**半开**的 [from, to)：to 取下个月 / 下一年的 00:00，跨月那条不会被两边都算。
 * from / to 是 UTC ISO 串，但边界按服务器本地时区取 —— 跟 SQL 里 date(...,'localtime') 一套。
 */
export function normalisePeriod(scope = 'month', period = null, now = new Date()) {
  const kind = REVIEW_SCOPES.includes(String(scope)) ? String(scope) : 'month';
  const todayYear = now.getFullYear();
  const todayMonth = now.getMonth() + 1;
  if (kind === 'all') {
    return { scope: 'all', period: null, from: null, to: null, label: '全部时间' };
  }
  if (kind === 'year') {
    const value = /^\d{4}$/.test(String(period ?? '')) ? Number(period) : todayYear;
    return {
      scope: 'year',
      period: String(value),
      from: localBoundary(value, 0),
      to: localBoundary(value + 1, 0),
      label: `${value} 年`,
    };
  }
  const match = /^(\d{4})-(\d{1,2})$/.exec(String(period ?? ''));
  const year = match ? Number(match[1]) : todayYear;
  const month = match ? Math.min(12, Math.max(1, Number(match[2]))) : todayMonth;
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonthIndex = month === 12 ? 0 : month; // month 是 1-based，正好是下个月的 0-based 索引
  return {
    scope: 'month',
    period: `${year}-${pad2(month)}`,
    from: localBoundary(year, month - 1),
    to: localBoundary(nextYear, nextMonthIndex),
    label: `${year} 年 ${month} 月`,
  };
}

/** 最长连续天数（借鉴 Skerry 的 getLongestStreak；输入是 'YYYY-MM-DD' 集合）。 */
export function longestStreak(dates = []) {
  const days = [...new Set(dates)]
    .map((date) => (/^\d{4}-\d{2}-\d{2}$/.test(String(date)) ? Date.parse(`${date}T00:00:00Z`) : NaN))
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);
  let longest = 0;
  let current = 0;
  let previous = null;
  for (const day of days) {
    if (day === previous) continue;
    current = previous !== null && day - previous === 86400000 ? current + 1 : 1;
    longest = Math.max(longest, current);
    previous = day;
  }
  return longest;
}

export function formatTokens(value) {
  const amount = num(value);
  if (Math.abs(amount) >= 1_000_000) return `${(amount / 1_000_000).toFixed(2)}M`;
  if (Math.abs(amount) >= 1000) return `${(amount / 1000).toFixed(1)}k`;
  return String(Math.round(amount));
}

export function formatMoney(value) {
  const amount = num(value);
  if (!amount) return '0';
  if (Math.abs(amount) < 0.01) return amount.toFixed(4);
  return amount.toFixed(2);
}

export function formatWords(value) {
  const amount = num(value);
  if (Math.abs(amount) >= 10000) return `${(amount / 10000).toFixed(1)} 万`;
  if (Math.abs(amount) >= 1000) return `${(amount / 1000).toFixed(1)} 千`;
  return String(Math.round(amount));
}

/** 把"按天聊了多少消息"和"按天花了多少 token"两张表并成一张。 */
function mergeDayRows(activityRows = [], usageRows = []) {
  const map = new Map();
  const ensure = (date) => {
    if (!map.has(date)) {
      map.set(date, { date, messages: 0, userWords: 0, assistantWords: 0, turns: 0, tokens: 0, cost: 0 });
    }
    return map.get(date);
  };
  for (const row of Array.isArray(activityRows) ? activityRows : []) {
    if (!row?.date) continue;
    const item = ensure(String(row.date));
    item.messages += num(row.messages);
    item.userWords += num(row.userWords);
    item.assistantWords += num(row.assistantWords);
  }
  for (const row of Array.isArray(usageRows) ? usageRows : []) {
    if (!row?.date) continue;
    const item = ensure(String(row.date));
    item.turns += num(row.turns);
    item.tokens += num(row.tokens);
    item.cost += num(row.cost);
  }
  return [...map.values()].sort((left, right) => left.date.localeCompare(right.date));
}

/**
 * 折线 / 柱状用的序列。
 * 月报按天填满整月（没数据的日子补 0，图才不跳）；年报 / 全部按月聚合（一年 365 根柱子太密）。
 */
function buildSeries(days, meta) {
  if (meta.scope === 'month' && /^\d{4}-\d{2}$/.test(String(meta.period))) {
    const [year, month] = meta.period.split('-').map(Number);
    const total = new Date(year, month, 0).getDate();
    const map = new Map(days.map((row) => [row.date, row]));
    const out = [];
    for (let day = 1; day <= total; day += 1) {
      const key = `${meta.period}-${pad2(day)}`;
      const found = map.get(key);
      out.push(found ? { ...found, label: String(day) } : { date: key, label: String(day), messages: 0, userWords: 0, assistantWords: 0, turns: 0, tokens: 0, cost: 0 });
    }
    return out;
  }

  const buckets = new Map();
  for (const row of days) {
    const key = row.date.slice(0, 7);
    if (!buckets.has(key)) {
      buckets.set(key, { key, label: `${Number(key.slice(5, 7))}月`, messages: 0, userWords: 0, assistantWords: 0, turns: 0, tokens: 0, cost: 0 });
    }
    const item = buckets.get(key);
    item.messages += row.messages;
    item.userWords += row.userWords;
    item.assistantWords += row.assistantWords;
    item.turns += row.turns;
    item.tokens += row.tokens;
    item.cost += row.cost;
  }
  if (meta.scope === 'year' && /^\d{4}$/.test(String(meta.period))) {
    const year = meta.period;
    const out = [];
    for (let month = 1; month <= 12; month += 1) {
      const key = `${year}-${pad2(month)}`;
      out.push(buckets.get(key) ?? { key, label: `${month}月`, messages: 0, userWords: 0, assistantWords: 0, turns: 0, tokens: 0, cost: 0 });
    }
    return out;
  }
  return [...buckets.values()].sort((left, right) => left.key.localeCompare(right.key));
}

function peakDay(days = []) {
  let best = null;
  for (const row of days) {
    const weight = row.messages || row.turns;
    if (!best || weight > (best.messages || best.turns)) best = row;
  }
  return best && (best.messages || best.turns) ? best : null;
}

function fillHours(rows = []) {
  const map = new Map((Array.isArray(rows) ? rows : []).map((row) => [num(row.hour), num(row.messages)]));
  return Array.from({ length: 24 }, (_, hour) => ({ hour, messages: map.get(hour) ?? 0 }));
}

function fillWeekdays(rows = []) {
  const map = new Map((Array.isArray(rows) ? rows : []).map((row) => [num(row.weekday), num(row.messages)]));
  return Array.from({ length: 7 }, (_, index) => ({ weekday: index, label: WEEKDAY_LABELS[index], messages: map.get(index) ?? 0 }));
}

/** 一句话总结：本地拼，不花 token。 */
export function buildCommentary(report = {}) {
  const head = report.headline ?? {};
  const usage = report.usage ?? {};
  const activity = report.activity ?? {};
  const creation = report.creation ?? {};
  if (!head.messages && !head.turns) return ['这段时间还没有记录 — 去开一段对话，或者先写几张卡。'];
  const lines = [];
  const top = usage.topCharacters?.[0];
  if (top) lines.push(`陪得最多的是「${top.name}」，一共 ${formatTokens(top.tokens)} token。`);
  if (head.activeDays) lines.push(`活跃 ${head.activeDays} 天，最长连续 ${head.longestStreak} 天没断。`);
  if (activity.peak?.date) lines.push(`最投入的一天是 ${activity.peak.date}，那天有 ${activity.peak.messages} 条消息。`);
  if (activity.nightMessages) lines.push(`有 ${activity.nightMessages} 条消息发生在凌晨 0 点到 5 点之间。`);
  if (creation.cardsCreated || creation.cardsEdited) {
    lines.push(`新写了 ${creation.cardsCreated} 张卡${creation.cardsEdited ? `，还改动了 ${creation.cardsEdited} 张` : ''}。`);
  }
  return lines;
}

/** 原始聚合 → 报告对象。raw 缺字段也能跑（新装、没数据时）。 */
export function buildReport(raw = {}, meta = normalisePeriod()) {
  const usage = raw.usage ?? {};
  const activity = raw.activity ?? {};
  const creation = raw.creation ?? {};
  const chats = raw.chats ?? {};
  const images = raw.images ?? {};

  const usageTotals = {
    turns: num(usage.totals?.turns),
    promptTokens: num(usage.totals?.promptTokens),
    completionTokens: num(usage.totals?.completionTokens),
    totalTokens: num(usage.totals?.totalTokens),
    cachedTokens: num(usage.totals?.cachedTokens),
    cost: num(usage.totals?.cost),
    cacheSavings: num(usage.totals?.cacheSavings),
    reportedTurns: num(usage.totals?.reportedTurns),
    unpricedTurns: num(usage.totals?.unpricedTurns),
  };
  const tokenBase = usageTotals.totalTokens || 1;
  const topCharacters = (Array.isArray(usage.byCharacter) ? usage.byCharacter : [])
    .map((row) => ({
      characterId: row.characterId ?? null,
      name: row.name ?? (row.characterId ? '（已删除的卡）' : '（未归属）'),
      avatarAssetId: row.avatarAssetId ?? null,
      coverAssetId: row.coverAssetId ?? null,
      turns: num(row.turns),
      tokens: num(row.tokens),
      cost: num(row.cost),
      share: Math.round((num(row.tokens) / tokenBase) * 1000) / 10,
    }))
    .sort((left, right) => right.tokens - left.tokens || right.turns - left.turns)
    .slice(0, 10);
  const byModel = (Array.isArray(usage.byModel) ? usage.byModel : [])
    .map((row) => ({ model: row.model ?? '（未记录）', turns: num(row.turns), tokens: num(row.tokens), cost: num(row.cost) }))
    .sort((left, right) => right.tokens - left.tokens)
    .slice(0, 8);

  const mergedDays = mergeDayRows(activity.byDay, usage.byDay);
  const byDay = buildSeries(mergedDays, meta);
  const activityTotals = {
    messages: num(activity.totals?.messages),
    userWords: num(activity.totals?.userWords),
    assistantWords: num(activity.totals?.assistantWords),
    longestMessage: num(activity.totals?.longestMessage),
  };
  const activeDates = mergedDays.filter((row) => row.messages > 0 || row.turns > 0).map((row) => row.date);
  const streak = longestStreak(activeDates);
  const peak = peakDay(mergedDays);
  const byHour = fillHours(activity.byHour);
  const byWeekday = fillWeekdays(activity.byWeekday);
  const nightMessages = byHour.filter((row) => row.hour < 5).reduce((sum, row) => sum + row.messages, 0);
  const creationTotals = {
    cardsCreated: num(creation.cardsCreated),
    cardsEdited: num(creation.cardsEdited),
    cardVersions: num(creation.cardVersions),
    worldbooks: num(creation.worldbooks),
    presets: num(creation.presets),
    memories: num(creation.memories),
  };

  const report = {
    meta,
    headline: {
      turns: usageTotals.turns,
      tokens: usageTotals.totalTokens,
      cost: usageTotals.cost,
      messages: activityTotals.messages,
      words: activityTotals.userWords + activityTotals.assistantWords,
      activeDays: activeDates.length,
      longestStreak: streak,
      cardsPlayed: num(raw.charactersPlayed),
      cardsCreated: creationTotals.cardsCreated,
    },
    usage: { ...usageTotals, topCharacters, byModel },
    activity: {
      ...activityTotals,
      byDay,
      byHour,
      byWeekday,
      activeDays: activeDates.length,
      longestStreak: streak,
      peak: peak ? { date: peak.date, messages: peak.messages, turns: peak.turns } : null,
      newChats: num(chats.fresh),
      branches: num(chats.branches),
      nightMessages,
    },
    creation: creationTotals,
    images: {
      done: num(images.done),
      failed: num(images.error),
      active: num(images.active),
      gallery: Array.isArray(images.gallery) ? images.gallery.filter(Boolean).slice(0, 18) : [],
    },
    cacheHitRate: usageTotals.promptTokens
      ? Math.round((usageTotals.cachedTokens / usageTotals.promptTokens) * 1000) / 10
      : 0,
  };
  report.commentary = buildCommentary(report);
  return report;
}
