/**
 * 花费与统计的存储层。
 *
 * 汇总尽量交给 SQL（GROUP BY），因为这个表会随时间一直长；只有需要
 * "预估 vs 实际"这类跨列运算时才拉回内存，交给 core 的纯函数算。
 */

import { newId, nowIso } from '../../core/ids.mjs';
import { ValidationError } from '../../core/errors.mjs';

const USAGE_COLUMNS = `id, chat_id, character_id, member_id, provider_id, model, kind, source,
  prompt_tokens, completion_tokens, total_tokens, cached_tokens,
  est_prompt_tokens, est_completion_tokens, price_in, price_out, cost, cache_savings, reported, created_at`;

const SUM_FIELDS = `COUNT(*) AS turns,
  COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
  COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
  COALESCE(SUM(total_tokens), 0) AS total_tokens,
  COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
  COALESCE(SUM(est_prompt_tokens), 0) AS est_prompt_tokens,
  COALESCE(SUM(est_completion_tokens), 0) AS est_completion_tokens,
  COALESCE(SUM(cost), 0) AS cost,
  COALESCE(SUM(cache_savings), 0) AS cache_savings,
  SUM(CASE WHEN cost IS NULL THEN 1 ELSE 0 END) AS unpriced,
  COALESCE(SUM(reported), 0) AS reported_turns`;

/** 允许按哪些列分组（白名单，别让拿来的字符串直接进 SQL）。 */
const GROUP_COLUMNS = {
  chat: 'chat_id',
  character: 'character_id',
  provider: 'provider_id',
  model: 'model',
  kind: 'kind',
};

function usageToObject(row) {
  if (!row) return null;
  return {
    id: row.id,
    chatId: row.chat_id ?? null,
    characterId: row.character_id ?? null,
    memberId: row.member_id ?? null,
    providerId: row.provider_id ?? null,
    model: row.model ?? null,
    kind: row.kind ?? null,
    source: row.source ?? null,
    promptTokens: Number(row.prompt_tokens ?? 0),
    completionTokens: Number(row.completion_tokens ?? 0),
    totalTokens: Number(row.total_tokens ?? 0),
    cachedTokens: Number(row.cached_tokens ?? 0),
    estPromptTokens: Number(row.est_prompt_tokens ?? 0),
    estCompletionTokens: Number(row.est_completion_tokens ?? 0),
    priceIn: row.price_in === null || row.price_in === undefined ? null : Number(row.price_in),
    priceOut: row.price_out === null || row.price_out === undefined ? null : Number(row.price_out),
    cost: row.cost === null || row.cost === undefined ? null : Number(row.cost),
    cacheSavings: row.cache_savings === null || row.cache_savings === undefined ? null : Number(row.cache_savings),
    reported: Boolean(row.reported),
    createdAt: row.created_at,
  };
}

export function createCostStore({ repo }) {
  function filterClause({ from = null, to = null, chatId = null, characterId = null, providerId = null, model = null } = {}) {
    const where = [];
    const params = [];
    if (from) {
      where.push('created_at >= ?');
      params.push(from);
    }
    if (to) {
      where.push('created_at <= ?');
      params.push(to);
    }
    if (chatId) {
      where.push('chat_id = ?');
      params.push(chatId);
    }
    if (characterId) {
      where.push('character_id = ?');
      params.push(characterId);
    }
    if (providerId) {
      where.push('provider_id = ?');
      params.push(providerId);
    }
    if (model) {
      where.push('model = ?');
      params.push(model);
    }
    return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
  }

  function insertUsage(entry = {}) {
    const id = entry.id ?? newId('use');
    repo.run(
      `INSERT INTO usage_log (${USAGE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        entry.chatId ?? null,
        entry.characterId ?? null,
        entry.memberId ?? null,
        entry.providerId ?? null,
        entry.model ?? null,
        entry.kind ?? null,
        entry.source ?? null,
        entry.promptTokens ?? 0,
        entry.completionTokens ?? 0,
        entry.totalTokens ?? 0,
        entry.cachedTokens ?? 0,
        entry.estPromptTokens ?? 0,
        entry.estCompletionTokens ?? 0,
        entry.priceIn ?? null,
        entry.priceOut ?? null,
        entry.cost ?? null,
        entry.cacheSavings ?? null,
        entry.reported ? 1 : 0,
        entry.createdAt ?? nowIso(),
      ],
    );
    return usageToObject(repo.get(`SELECT ${USAGE_COLUMNS} FROM usage_log WHERE id = ?`, [id]));
  }

  function listUsage(filter = {}) {
    const { sql, params } = filterClause(filter);
    const limit = Math.max(1, Math.min(2000, Number(filter.limit) || 200));
    return repo
      .all(`SELECT ${USAGE_COLUMNS} FROM usage_log ${sql} ORDER BY created_at DESC LIMIT ?`, [...params, limit])
      .map(usageToObject);
  }

  function totals(filter = {}) {
    const { sql, params } = filterClause(filter);
    const row = repo.get(`SELECT ${SUM_FIELDS} FROM usage_log ${sql}`, params);
    return {
      turns: Number(row?.turns ?? 0),
      promptTokens: Number(row?.prompt_tokens ?? 0),
      completionTokens: Number(row?.completion_tokens ?? 0),
      totalTokens: Number(row?.total_tokens ?? 0),
      cachedTokens: Number(row?.cached_tokens ?? 0),
      estimatedPromptTokens: Number(row?.est_prompt_tokens ?? 0),
      estimatedCompletionTokens: Number(row?.est_completion_tokens ?? 0),
      cost: Number(row?.cost ?? 0),
      cacheSavings: Number(row?.cache_savings ?? 0),
      unpricedTurns: Number(row?.unpriced ?? 0),
      reportedTurns: Number(row?.reported_turns ?? 0),
    };
  }

  /** 按某一维分组（对话 / 角色 / 提供方 / 模型 / 类型）。 */
  function groupBy(dimension, filter = {}) {
    const column = GROUP_COLUMNS[dimension];
    if (!column) throw new ValidationError(`不支持按 ${dimension} 汇总`);
    const { sql, params } = filterClause(filter);
    const rows = repo.all(
      `SELECT ${column} AS bucket, ${SUM_FIELDS} FROM usage_log ${sql} GROUP BY ${column} ORDER BY cost DESC, turns DESC`,
      params,
    );
    return rows.map((row) => ({
      key: row.bucket ?? null,
      ...totalsFromRow(row),
    }));
  }

  /** 按天汇总（按本机时区的日期切分由上层决定，这里就按 ISO 前 10 位）。 */
  function byDay(filter = {}) {
    const { sql, params } = filterClause(filter);
    const rows = repo.all(
      `SELECT SUBSTR(created_at, 1, 10) AS bucket, ${SUM_FIELDS} FROM usage_log ${sql} GROUP BY bucket ORDER BY bucket DESC`,
      params,
    );
    return rows.map((row) => ({ key: row.bucket, ...totalsFromRow(row) }));
  }

  function totalsFromRow(row) {
    return {
      turns: Number(row?.turns ?? 0),
      promptTokens: Number(row?.prompt_tokens ?? 0),
      completionTokens: Number(row?.completion_tokens ?? 0),
      totalTokens: Number(row?.total_tokens ?? 0),
      cachedTokens: Number(row?.cached_tokens ?? 0),
      estimatedPromptTokens: Number(row?.est_prompt_tokens ?? 0),
      estimatedCompletionTokens: Number(row?.est_completion_tokens ?? 0),
      cost: Number(row?.cost ?? 0),
      cacheSavings: Number(row?.cache_savings ?? 0),
      unpricedTurns: Number(row?.unpriced ?? 0),
      reportedTurns: Number(row?.reported_turns ?? 0),
    };
  }

  // ------------------------------------------------------------------ 单价

  function pricingToObject(row) {
    if (!row) return null;
    return {
      id: row.id,
      providerId: row.provider_id ?? '',
      model: row.model ?? '',
      label: row.label ?? null,
      currency: row.currency ?? 'CNY',
      priceIn: row.price_in === null || row.price_in === undefined ? null : Number(row.price_in),
      priceOut: row.price_out === null || row.price_out === undefined ? null : Number(row.price_out),
      cacheDiscount: Number(row.cache_discount ?? 0.1),
      updatedAt: row.updated_at,
    };
  }

  function listPricing() {
    return repo
      .all('SELECT * FROM pricing ORDER BY provider_id, model')
      .map(pricingToObject);
  }

  function findPricing(providerId, model = null) {
    const rows = repo.all(
      `SELECT * FROM pricing WHERE provider_id = ? AND (model = ? OR model = '') ORDER BY
         CASE WHEN model = ? THEN 0 ELSE 1 END LIMIT 1`,
      [providerId ?? '', model ?? '', model ?? ''],
    );
    return pricingToObject(rows[0]);
  }

  function upsertPricing(input = {}) {
    const providerId = String(input.providerId ?? '');
    const model = String(input.model ?? '');
    const existing = repo.get('SELECT id FROM pricing WHERE provider_id = ? AND model = ?', [providerId, model]);
    const id = existing?.id ?? newId('price');
    const priceIn = input.priceIn === null || input.priceIn === undefined || input.priceIn === '' ? null : Number(input.priceIn);
    const priceOut = input.priceOut === null || input.priceOut === undefined || input.priceOut === '' ? null : Number(input.priceOut);
    if (priceIn !== null && !Number.isFinite(priceIn)) throw new ValidationError('输入单价应该是数字（元 / 百万 token）');
    if (priceOut !== null && !Number.isFinite(priceOut)) throw new ValidationError('输出单价应该是数字（元 / 百万 token）');
    const discount = input.cacheDiscount === undefined ? 0.1 : Number(input.cacheDiscount);
    if (!Number.isFinite(discount) || discount < 0 || discount > 1) throw new ValidationError('缓存折扣要在 0 ~ 1 之间');
    repo.run(
      `INSERT INTO pricing (id, provider_id, model, label, currency, price_in, price_out, cache_discount, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider_id, model) DO UPDATE SET
         label = excluded.label, currency = excluded.currency, price_in = excluded.price_in,
         price_out = excluded.price_out, cache_discount = excluded.cache_discount, updated_at = excluded.updated_at`,
      [id, providerId, model, input.label ?? null, input.currency ?? 'CNY', priceIn, priceOut, discount, nowIso()],
    );
    return pricingToObject(repo.get('SELECT * FROM pricing WHERE provider_id = ? AND model = ?', [providerId, model]));
  }

  function removePricing(id) {
    const found = repo.get('SELECT id FROM pricing WHERE id = ?', [id]);
    if (!found) return false;
    repo.run('DELETE FROM pricing WHERE id = ?', [id]);
    return true;
  }

  function stats() {
    const row = repo.get('SELECT COUNT(*) AS turns, MIN(created_at) AS first_at, MAX(created_at) AS last_at FROM usage_log');
    return { turns: Number(row?.turns ?? 0), firstAt: row?.first_at ?? null, lastAt: row?.last_at ?? null };
  }

  return {
    insertUsage,
    listUsage,
    totals,
    groupBy,
    byDay,
    listPricing,
    findPricing,
    upsertPricing,
    removePricing,
    stats,
  };
}
