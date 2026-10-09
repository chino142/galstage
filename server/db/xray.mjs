/**
 * 提示词 X 光机的读写。
 *
 * 每轮生成都会把真正发出去的提示词按段存一份（见 core/chat/service.mjs 的
 * ports.saveXray）。这里只负责落库与查询：能看到每段内容、token 与来源，
 * 调试"AI 为什么这么答"时唯一的依据。
 */

import { newId, nowIso } from '../../core/ids.mjs';
import { fromJson } from './repo.mjs';

function rowToObject(row) {
  if (!row) return null;
  return {
    id: row.id,
    chatId: row.chat_id ?? null,
    characterId: row.character_id ?? null,
    createdAt: row.created_at,
    sections: fromJson(row.sections, []),
    text: row.text ?? '',
    tokens: fromJson(row.tokens, { total: 0, bySection: {}, budget: null }),
    notes: fromJson(row.notes, []),
    model: row.model ?? null,
  };
}

export function saveXray(repo, entry = {}) {
  const id = entry.id ? String(entry.id) : newId('xray');
  repo.run(
    `INSERT INTO prompt_xray (id, chat_id, character_id, created_at, sections, text, tokens, notes, model)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [
      id,
      entry.chatId ?? null,
      entry.characterId ?? null,
      entry.createdAt ?? nowIso(),
      JSON.stringify(entry.sections ?? []),
      String(entry.text ?? ''),
      JSON.stringify(entry.tokens ?? { total: 0, bySection: {}, budget: null }),
      JSON.stringify(entry.notes ?? []),
      entry.model ?? null,
    ],
  );
  return rowToObject(repo.get('SELECT * FROM prompt_xray WHERE id = ?', [id]));
}

export function listXray(repo, { chatId = null, limit = 50, includeText = false } = {}) {
  const rows = chatId
    ? repo.all('SELECT * FROM prompt_xray WHERE chat_id = ? ORDER BY created_at DESC LIMIT ?', [chatId, Number(limit) || 50])
    : repo.all('SELECT * FROM prompt_xray ORDER BY created_at DESC LIMIT ?', [Number(limit) || 50]);
  return rows.map((row) => {
    const item = rowToObject(row);
    if (!includeText) {
      item.text = '';
      item.textLength = String(row.text ?? '').length;
    }
    return item;
  });
}

export function getXray(repo, id) {
  return rowToObject(repo.get('SELECT * FROM prompt_xray WHERE id = ?', [id]));
}

/** 同一个对话里，这条快照的上一轮（比它早的最近一条）。没有就返回 null。 */
export function previousXray(repo, snapshot = {}) {
  const chatId = snapshot.chatId ?? null;
  const createdAt = snapshot.createdAt ?? null;
  if (!chatId || !createdAt) return null;
  return rowToObject(
    repo.get(
      'SELECT * FROM prompt_xray WHERE chat_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT 1',
      [chatId, createdAt],
    ),
  );
}

export function removeXray(repo, id) {
  repo.run('DELETE FROM prompt_xray WHERE id = ?', [id]);
  return true;
}

/** 按保留条数裁剪（设置项 data.keepPromptXrayLimit，0 表示不限制）。 */
export function pruneXray(repo, limit) {
  const max = Number(limit);
  if (!Number.isFinite(max) || max <= 0) return 0;
  const row = repo.get('SELECT COUNT(*) AS n FROM prompt_xray');
  const excess = Number(row?.n ?? 0) - max;
  if (excess <= 0) return 0;
  repo.run(`DELETE FROM prompt_xray WHERE id IN (SELECT id FROM prompt_xray ORDER BY created_at ASC LIMIT ?)`, [excess]);
  return excess;
}
