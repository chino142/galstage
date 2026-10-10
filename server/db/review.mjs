/**
 * 报告的存储层：只做 SQL 聚合，算账交给 core/toolbox/review.mjs。
 *
 * 时间口径跟「花费与统计」一致：库里存的是 UTC ISO 串。切天 / 月 / 小时一律用 SQLite 的
 * 'localtime' 修饰符按**服务器本地时区**算 —— 所以"最投入的一天""凌晨还在聊"不会因为
 * 存的是 UTC 而错开 8 小时。区间过滤仍旧拿 UTC ISO 串比较（半开 [from, to)）。
 *
 * 全部只读，不写任何表。列名一律写死，不接受外部传进来的字符串拼 SQL。
 */

const USAGE_SUM = `COUNT(*) AS turns,
  COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
  COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
  COALESCE(SUM(total_tokens), 0) AS total_tokens,
  COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
  COALESCE(SUM(cost), 0) AS cost,
  COALESCE(SUM(cache_savings), 0) AS cache_savings,
  SUM(CASE WHEN cost IS NULL THEN 1 ELSE 0 END) AS unpriced,
  COALESCE(SUM(reported), 0) AS reported`;

export function createReviewStore({ repo }) {
  if (!repo) throw new Error('createReviewStore 需要 repo');

  /**
   * 卡上可能没有头像（characters.avatar_asset_id 空），但平台导入的卡会把封面素材
   * 存在 data.extensions.st_cover 里 —— 卡库页也是这么回退的，这里跟上。
   * 注意 avatar_asset_id 存的是 **cards/<id>.png 相对路径**，不是 assets 表 id。
   */
  function readCoverAsset(data) {
    try {
      const parsed = JSON.parse(data ?? '{}');
      const cover = parsed?.extensions?.st_cover;
      return typeof cover === 'string' && cover ? cover : null;
    } catch {
      return null;
    }
  }

  /** 半开区间过滤：created_at >= from 且 < to。from/to 都是 UTC ISO 串（或 null）。 */
  function clause(column, range = {}) {
    const parts = [];
    const params = [];
    if (range.from) {
      parts.push(`${column} >= ?`);
      params.push(range.from);
    }
    if (range.to) {
      parts.push(`${column} < ?`);
      params.push(range.to);
    }
    return { sql: parts.length ? `WHERE ${parts.join(' AND ')}` : '', params };
  }

  /** 拼 "WHERE 已有条件 AND 这句"：给还要附加固定条件的查询用。 */
  function andMore(base, extra) {
    return base ? `${base} AND ${extra}` : `WHERE ${extra}`;
  }

  function usageTotals(range = {}) {
    const { sql, params } = clause('created_at', range);
    const row = repo.get(`SELECT ${USAGE_SUM} FROM usage_log ${sql}`, params);
    return {
      turns: Number(row?.turns ?? 0),
      promptTokens: Number(row?.prompt_tokens ?? 0),
      completionTokens: Number(row?.completion_tokens ?? 0),
      totalTokens: Number(row?.total_tokens ?? 0),
      cachedTokens: Number(row?.cached_tokens ?? 0),
      cost: Number(row?.cost ?? 0),
      cacheSavings: Number(row?.cache_savings ?? 0),
      unpricedTurns: Number(row?.unpriced ?? 0),
      reportedTurns: Number(row?.reported ?? 0),
    };
  }

  /** 按卡分组（token 前十用）。卡删了名字就没了，界面上退化成"（已删除的卡）"。 */
  function usageByCharacter(range = {}, limit = 12) {
    const { sql, params } = clause('u.created_at', range);
    const rows = repo.all(
      `SELECT u.character_id AS character_id, c.name AS name, c.avatar_asset_id AS avatar, c.data AS card_data, COUNT(*) AS turns,
              COALESCE(SUM(u.total_tokens), 0) AS tokens, COALESCE(SUM(u.cost), 0) AS cost
         FROM usage_log u
         LEFT JOIN characters c ON c.id = u.character_id
         ${sql}
        GROUP BY u.character_id
        ORDER BY tokens DESC, turns DESC
        LIMIT ?`,
      [...params, Math.max(1, Math.min(100, Number(limit) || 12))],
    );
    return rows.map((row) => ({
      characterId: row.character_id ?? null,
      name: row.name ?? null,
      avatarAssetId: row.avatar ?? null,
      coverAssetId: readCoverAsset(row.card_data),
      turns: Number(row.turns ?? 0),
      tokens: Number(row.tokens ?? 0),
      cost: Number(row.cost ?? 0),
    }));
  }

  function usageByModel(range = {}) {
    const { sql, params } = clause('created_at', range);
    const rows = repo.all(
      `SELECT model AS model, COUNT(*) AS turns,
              COALESCE(SUM(total_tokens), 0) AS tokens, COALESCE(SUM(cost), 0) AS cost
         FROM usage_log ${sql}
        GROUP BY model
        ORDER BY tokens DESC
        LIMIT 12`,
      params,
    );
    return rows.map((row) => ({
      model: row.model ?? null,
      turns: Number(row.turns ?? 0),
      tokens: Number(row.tokens ?? 0),
      cost: Number(row.cost ?? 0),
    }));
  }

  function usageByDay(range = {}) {
    const { sql, params } = clause('created_at', range);
    const rows = repo.all(
      `SELECT date(created_at, 'localtime') AS day, COUNT(*) AS turns,
              COALESCE(SUM(total_tokens), 0) AS tokens, COALESCE(SUM(cost), 0) AS cost
         FROM usage_log ${sql}
        GROUP BY day ORDER BY day`,
      params,
    );
    return rows.map((row) => ({
      date: row.day,
      turns: Number(row.turns ?? 0),
      tokens: Number(row.tokens ?? 0),
      cost: Number(row.cost ?? 0),
    }));
  }

  /** 消息口径：只数用户 / 角色的正常消息，系统消息（旁白）不算。 */
  function activityTotals(range = {}) {
    const { sql, params } = clause('created_at', range);
    const row = repo.get(
      `SELECT COUNT(*) AS messages,
              COALESCE(SUM(CASE WHEN role = 'user' THEN LENGTH(content) ELSE 0 END), 0) AS user_words,
              COALESCE(SUM(CASE WHEN role = 'assistant' THEN LENGTH(content) ELSE 0 END), 0) AS assistant_words,
              COALESCE(MAX(CASE WHEN role = 'assistant' THEN LENGTH(content) ELSE 0 END), 0) AS longest
         FROM chat_messages ${andMore(sql, "is_system = 0 AND role IN ('user', 'assistant')")}`,
      params,
    );
    return {
      messages: Number(row?.messages ?? 0),
      userWords: Number(row?.user_words ?? 0),
      assistantWords: Number(row?.assistant_words ?? 0),
      longestMessage: Number(row?.longest ?? 0),
    };
  }

  function activityByDay(range = {}) {
    const { sql, params } = clause('created_at', range);
    const rows = repo.all(
      `SELECT date(created_at, 'localtime') AS day, COUNT(*) AS messages,
              COALESCE(SUM(CASE WHEN role = 'user' THEN LENGTH(content) ELSE 0 END), 0) AS user_words,
              COALESCE(SUM(CASE WHEN role = 'assistant' THEN LENGTH(content) ELSE 0 END), 0) AS assistant_words
         FROM chat_messages ${andMore(sql, "is_system = 0 AND role IN ('user', 'assistant')")}
        GROUP BY day ORDER BY day`,
      params,
    );
    return rows.map((row) => ({
      date: row.day,
      messages: Number(row.messages ?? 0),
      userWords: Number(row.user_words ?? 0),
      assistantWords: Number(row.assistant_words ?? 0),
    }));
  }

  /** 你几点最活跃：按本地小时切。 */
  function activityByHour(range = {}) {
    const { sql, params } = clause('created_at', range);
    const rows = repo.all(
      `SELECT CAST(strftime('%H', created_at, 'localtime') AS INTEGER) AS hour, COUNT(*) AS messages
         FROM chat_messages ${andMore(sql, "is_system = 0 AND role IN ('user', 'assistant')")}
        GROUP BY hour ORDER BY hour`,
      params,
    );
    return rows.map((row) => ({ hour: Number(row.hour ?? 0), messages: Number(row.messages ?? 0) }));
  }

  function activityByWeekday(range = {}) {
    const { sql, params } = clause('created_at', range);
    const rows = repo.all(
      `SELECT CAST(strftime('%w', created_at, 'localtime') AS INTEGER) AS weekday, COUNT(*) AS messages
         FROM chat_messages ${andMore(sql, "is_system = 0 AND role IN ('user', 'assistant')")}
        GROUP BY weekday ORDER BY weekday`,
      params,
    );
    return rows.map((row) => ({ weekday: Number(row.weekday ?? 0), messages: Number(row.messages ?? 0) }));
  }

  /** 玩了几张卡：这段时间里说过话的不同角色。 */
  function charactersPlayed(range = {}) {
    const { sql, params } = clause('created_at', range);
    const row = repo.get(
      `SELECT COUNT(DISTINCT character_id) AS played
         FROM chat_messages ${andMore(sql, "is_system = 0 AND role = 'assistant' AND character_id IS NOT NULL")}`,
      params,
    );
    return Number(row?.played ?? 0);
  }

  function chatsCreated(range = {}) {
    const { sql, params } = clause('created_at', range);
    const row = repo.get(
      `SELECT COALESCE(SUM(CASE WHEN parent_chat_id IS NULL THEN 1 ELSE 0 END), 0) AS fresh,
              COALESCE(SUM(CASE WHEN parent_chat_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS branches
         FROM chats ${sql}`,
      params,
    );
    return { fresh: Number(row?.fresh ?? 0), branches: Number(row?.branches ?? 0) };
  }

  function countWhere(table, range = {}) {
    const { sql, params } = clause('created_at', range);
    const row = repo.get(`SELECT COUNT(*) AS n FROM ${table} ${sql}`, params);
    return Number(row?.n ?? 0);
  }

  function creationTotals(range = {}) {
    const { sql, params } = clause('created_at', range);
    const edited = repo.get(
      `SELECT COUNT(DISTINCT character_id) AS cards, COUNT(*) AS versions FROM character_versions ${sql}`,
      params,
    );
    return {
      cardsCreated: countWhere('characters', range),
      cardsEdited: Number(edited?.cards ?? 0),
      cardVersions: Number(edited?.versions ?? 0),
      worldbooks: countWhere('worldbooks', range),
      presets: countWhere('prompt_presets', range),
      memories: countWhere('memories', range),
    };
  }

  function imagesByStatus(range = {}) {
    const { sql, params } = clause('created_at', range);
    const row = repo.get(
      `SELECT COALESCE(SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END), 0) AS done,
              COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0) AS error,
              COALESCE(SUM(CASE WHEN status IN ('queued', 'running') THEN 1 ELSE 0 END), 0) AS active
         FROM comfy_runs ${sql}`,
      params,
    );
    return { done: Number(row?.done ?? 0), error: Number(row?.error ?? 0), active: Number(row?.active ?? 0) };
  }

  /** 这段时间出过的图：从成功的出图记录里把图片 id 摊平（按时间倒序，去重）。 */
  function galleryAssets(range = {}, limit = 18) {
    const { sql, params } = clause('created_at', range);
    const rows = repo.all(
      `SELECT images FROM comfy_runs ${andMore(sql, "status = 'done'")} ORDER BY created_at DESC LIMIT 60`,
      params,
    );
    const out = [];
    for (const row of rows) {
      let list = [];
      try {
        list = JSON.parse(row.images ?? '[]');
      } catch {
        list = [];
      }
      for (const id of Array.isArray(list) ? list : []) {
        if (id && !out.includes(id)) out.push(id);
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  /** 有哪些月份可选：三张表里出现过的月份，按本地时区切，新的在前。 */
  function availablePeriods() {
    const rows = repo.all(
      `SELECT month FROM (
         SELECT DISTINCT strftime('%Y-%m', created_at, 'localtime') AS month FROM usage_log
         UNION
         SELECT DISTINCT strftime('%Y-%m', created_at, 'localtime') AS month FROM chat_messages
         UNION
         SELECT DISTINCT strftime('%Y-%m', created_at, 'localtime') AS month FROM characters
       ) WHERE month IS NOT NULL ORDER BY month DESC`,
    );
    const months = rows.map((row) => String(row.month)).filter((value) => /^\d{4}-\d{2}$/.test(value));
    const years = [...new Set(months.map((value) => value.slice(0, 4)))].sort((left, right) => right.localeCompare(left));
    return { months, years };
  }

  return {
    usageTotals,
    usageByCharacter,
    usageByModel,
    usageByDay,
    activityTotals,
    activityByDay,
    activityByHour,
    activityByWeekday,
    charactersPlayed,
    chatsCreated,
    creationTotals,
    imagesByStatus,
    galleryAssets,
    availablePeriods,
  };
}
