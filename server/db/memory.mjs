/**
 * 记忆存储：memories 一张表。
 * layer: small（场景级小总结）/ large（章节级大总结）/ profile（结构化档案）。
 * 小总结用 covers_from / covers_to 记住它覆盖的消息区间。
 */

import { newId, nowIso } from '../../core/ids.mjs';
import { fromJson } from './repo.mjs';
import { NotFoundError } from '../../core/errors.mjs';

function rowToMemory(row) {
  if (!row) return null;
  return {
    id: row.id,
    chatId: row.chat_id ?? null,
    characterId: row.character_id ?? null,
    layer: row.layer ?? 'small',
    title: row.title ?? '',
    content: row.content ?? '',
    coversFrom: row.covers_from ?? null,
    coversTo: row.covers_to ?? null,
    pinned: Boolean(row.pinned),
    data: null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createMemoryStore({ repo }) {
  function list({ chatId = null, layer = null, limit = 200 } = {}) {
    const where = [];
    const params = [];
    if (chatId) { where.push('chat_id = ?'); params.push(chatId); }
    if (layer) { where.push('layer = ?'); params.push(layer); }
    const rows = repo.all(
      `SELECT * FROM memories ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`,
      [...params, Number(limit) || 200],
    );
    const items = rows.map(rowToMemory);
    return { items, total: items.length };
  }

  function get(id) {
    return rowToMemory(repo.get('SELECT * FROM memories WHERE id = ?', [id]));
  }

  function insert({ chatId = null, characterId = null, layer = 'small', title = '', content = '', coversFrom = null, coversTo = null, pinned = false } = {}) {
    const id = newId('mem');
    const now = nowIso();
    repo.run(
      `INSERT INTO memories (id, chat_id, character_id, layer, title, content, covers_from, covers_to, pinned, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, chatId, characterId, layer, title, content, coversFrom, coversTo, pinned ? 1 : 0, now, now],
    );
    return get(id);
  }

  function update(id, patch = {}) {
    const existing = get(id);
    if (!existing) throw new NotFoundError(`记忆 ${id}`);
    const fields = [];
    const params = [];
    if (patch.title !== undefined) { fields.push('title = ?'); params.push(String(patch.title)); }
    if (patch.content !== undefined) { fields.push('content = ?'); params.push(String(patch.content)); }
    if (patch.layer !== undefined) { fields.push('layer = ?'); params.push(String(patch.layer)); }
    if (patch.coversFrom !== undefined) { fields.push('covers_from = ?'); params.push(patch.coversFrom || null); }
    if (patch.coversTo !== undefined) { fields.push('covers_to = ?'); params.push(patch.coversTo || null); }
    if (patch.pinned !== undefined) { fields.push('pinned = ?'); params.push(patch.pinned ? 1 : 0); }
    fields.push('updated_at = ?');
    params.push(nowIso(), id);
    repo.run(`UPDATE memories SET ${fields.join(', ')} WHERE id = ?`, params);
    return get(id);
  }

  function remove(id) {
    if (!get(id)) throw new NotFoundError(`记忆 ${id}`);
    repo.run('DELETE FROM memories WHERE id = ?', [id]);
    return true;
  }

  function removeAutoForChat(chatId, layers = ['small', 'large']) {
    const placeholders = layers.map(() => '?').join(',');
    repo.run(`DELETE FROM memories WHERE chat_id = ? AND pinned = 0 AND layer IN (${placeholders})`, [chatId, ...layers]);
    return true;
  }

  return { list, get, insert, update, remove, removeAutoForChat };
}
