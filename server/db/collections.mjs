/**
 * 剧本合集（分组 / 分类 / 卡）的存储层。
 *
 * 只有增删改查；"最多两级""删分组连坐"这类判断在 core/collections/service.mjs 里。
 */

import { newId, nowIso } from '../../core/ids.mjs';
import { NotFoundError } from '../../core/errors.mjs';

const COLUMNS = 'id, name, parent_id, order_index, created_at, updated_at';

function toObject(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    parentId: row.parent_id ?? null,
    orderIndex: Number(row.order_index ?? 100),
    cardCount: row.card_count === undefined ? undefined : Number(row.card_count ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createCollectionsStore({ repo }) {
  if (!repo) throw new Error('createCollectionsStore 需要 repo');

  function list() {
    const rows = repo.all(
      `SELECT c.${COLUMNS.replaceAll(', ', ', c.')},
              (SELECT COUNT(*) FROM card_collection_items i WHERE i.collection_id = c.id) AS card_count
         FROM card_collections c
        ORDER BY c.parent_id IS NOT NULL, c.order_index, c.name`,
    );
    return { items: rows.map(toObject), total: rows.length };
  }

  function get(id) {
    return toObject(
      repo.get(
        `SELECT c.${COLUMNS.replaceAll(', ', ', c.')},
                (SELECT COUNT(*) FROM card_collection_items i WHERE i.collection_id = c.id) AS card_count
           FROM card_collections c WHERE c.id = ?`,
        [id],
      ),
    );
  }

  function save(input = {}) {
    const name = String(input.name ?? '').trim();
    if (!name) throw new NotFoundError('合集得有个名字');
    const now = nowIso();
    const existing = input.id ? get(input.id) : null;
    const id = input.id ?? newId('col');
    repo.run(
      `INSERT INTO card_collections (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name, parent_id = excluded.parent_id,
         order_index = excluded.order_index, updated_at = excluded.updated_at`,
      [
        id,
        name,
        input.parentId === undefined ? (existing?.parentId ?? null) : (input.parentId || null),
        Number.isFinite(Number(input.orderIndex)) ? Number(input.orderIndex) : (existing?.orderIndex ?? 100),
        existing?.createdAt ?? now,
        now,
      ],
    );
    return get(id);
  }

  function remove(id) {
    const found = get(id);
    if (!found) return false;
    // 子分类 / 成员由外键 CASCADE 带走（PRAGMA foreign_keys 是开的）
    repo.run('DELETE FROM card_collections WHERE id = ?', [id]);
    return true;
  }

  function cards(collectionId) {
    return repo
      .all(
        `SELECT ch.id, ch.name, ch.avatar_asset_id
           FROM card_collection_items i
           JOIN characters ch ON ch.id = i.character_id
          WHERE i.collection_id = ?
          ORDER BY ch.name COLLATE NOCASE`,
        [collectionId],
      )
      .map((row) => ({ id: row.id, name: row.name, avatarAssetId: row.avatar_asset_id ?? null }));
  }

  function addCards(collectionId, characterIds = []) {
    const now = nowIso();
    for (const characterId of characterIds) {
      repo.run(
        'INSERT OR IGNORE INTO card_collection_items (collection_id, character_id, created_at) VALUES (?, ?, ?)',
        [collectionId, String(characterId), now],
      );
    }
    return cards(collectionId);
  }

  function removeCards(collectionId, characterIds = []) {
    for (const characterId of characterIds) {
      repo.run('DELETE FROM card_collection_items WHERE collection_id = ? AND character_id = ?', [collectionId, String(characterId)]);
    }
    return cards(collectionId);
  }

  return { list, get, save, remove, cards, addCards, removeCards };
}
