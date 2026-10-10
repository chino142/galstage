/**
 * 坑本（story_plans）的存储层：只有增删改查，没有任何"业务判断"。
 */

import { newId, nowIso } from '../../core/ids.mjs';
import { NotFoundError } from '../../core/errors.mjs';
import { fromJson } from './repo.mjs';

const COLUMNS = 'id, title, summary, tags, cover_asset_id, note, status, card_id, created_at, updated_at';

function toObject(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    summary: row.summary ?? '',
    tags: fromJson(row.tags, []),
    coverAssetId: row.cover_asset_id ?? null,
    note: row.note ?? '',
    status: row.status ?? 'idea',
    cardId: row.card_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createPlansStore({ repo }) {
  if (!repo) throw new Error('createPlansStore 需要 repo');

  function list({ status = '' } = {}) {
    const where = [];
    const params = [];
    if (status) {
      where.push('status = ?');
      params.push(String(status));
    }
    const sql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const items = repo.all(`SELECT ${COLUMNS} FROM story_plans ${sql} ORDER BY updated_at DESC`, params).map(toObject);
    return { items, total: items.length };
  }

  function get(id) {
    return toObject(repo.get(`SELECT ${COLUMNS} FROM story_plans WHERE id = ?`, [id]));
  }

  /** 有 id 就改，没有就新建。 */
  function save(input = {}) {
    const title = String(input.title ?? '').trim();
    if (!title) throw new NotFoundError('坑本得有个标题');
    const now = nowIso();
    const id = input.id ?? newId('plan');
    const existing = input.id ? get(input.id) : null;
    const tags = Array.isArray(input.tags) ? input.tags.map(String).filter(Boolean) : (existing?.tags ?? []);
    repo.run(
      `INSERT INTO story_plans (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title, summary = excluded.summary, tags = excluded.tags,
         cover_asset_id = excluded.cover_asset_id, note = excluded.note, status = excluded.status,
         card_id = excluded.card_id, updated_at = excluded.updated_at`,
      [
        id,
        title,
        String(input.summary ?? existing?.summary ?? ''),
        JSON.stringify(tags),
        input.coverAssetId ?? existing?.coverAssetId ?? null,
        String(input.note ?? existing?.note ?? ''),
        String(input.status ?? existing?.status ?? 'idea'),
        input.cardId ?? existing?.cardId ?? null,
        existing?.createdAt ?? now,
        now,
      ],
    );
    return get(id);
  }

  function remove(id) {
    const found = get(id);
    if (!found) return false;
    repo.run('DELETE FROM story_plans WHERE id = ?', [id]);
    return true;
  }

  return { list, get, save, remove };
}
