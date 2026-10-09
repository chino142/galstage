/**
 * 世界书存储：worldbooks（整份文档）+ worldbook_entries（可查询的投影）。
 *
 * 关键约定：`worldbooks.data` 存的是**原始文档**（酒馆导出的整份 JSON，
 * 或角色卡里的 character_book），原始字段与未知字段一个不动。编辑条目时
 * 是往原始文档里就地改（见 core/worldbook/shapes.mjs 的 applyEntryToDocument），
 * 不是拿数据库列重新拼一份文档 —— 这样才能保证两种形状互转不丢字段。
 *
 * worldbook_entries 是从原始文档投影出来的、方便搜索与统计的行；它只覆盖
 * 我们建了列的字段，读条目时仍然以原始文档为准（见 entries()）。
 */

import { newId, nowIso } from '../../core/ids.mjs';
import { fromJson } from './repo.mjs';
import { NotFoundError, ValidationError } from '../../core/errors.mjs';
import { MATCH_SOURCES } from '../../core/worldbook/shapes.mjs';
import {
  normalizeWorldBook,
  normalizeEntry,
  detectShape,
  convertDocument,
  applyEntryToDocument,
} from '../../core/worldbook/shapes.mjs';

function rowToBook(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    spec: row.spec ?? 'tavern',
    data: fromJson(row.data, { entries: {} }) ?? {},
    characterId: row.character_id ?? null,
    source: row.source ?? 'original',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    entryCount: row.entry_count !== undefined ? Number(row.entry_count) : undefined,
  };
}

function matchSourcesOf(entry) {
  return MATCH_SOURCES.filter((source) => entry[source.key]).map((source) => source.key);
}

export function createWorldbookStore({ repo }) {
  // ---------------------------------------------------------------- 投影

  function syncEntries(id, doc) {
    const book = normalizeWorldBook(doc);
    repo.run('DELETE FROM worldbook_entries WHERE worldbook_id = ?', [id]);
    const now = nowIso();
    for (const entry of book.entries) {
      repo.run(
        `INSERT INTO worldbook_entries
           (id, worldbook_id, uid, comment, content, keys, secondary_keys, logic, constant, position, depth,
            order_index, probability, sticky, cooldown, delay, group_name, group_weight, ignore_budget,
            match_sources, enabled, semantic_threshold, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          newId('wbe'), id, String(entry.uid ?? ''), entry.comment, entry.content,
          JSON.stringify(entry.keys), JSON.stringify(entry.secondaryKeys), entry.selectiveLogic,
          entry.constant ? 1 : 0, String(entry.position), entry.depth, entry.order, entry.probability,
          entry.sticky, entry.cooldown, entry.delay, entry.group, entry.groupWeight,
          entry.ignoreBudget ? 1 : 0, JSON.stringify(matchSourcesOf(entry)), entry.enabled ? 1 : 0,
          entry.semanticThreshold, now,
        ],
      );
    }
    return book.entries;
  }

  // ---------------------------------------------------------------- 书

  function list({ q = '', characterId = undefined } = {}) {
    const where = [];
    const params = [];
    if (q) {
      where.push('w.name LIKE ?');
      params.push(`%${q}%`);
    }
    if (characterId === null) where.push('w.character_id IS NULL');
    else if (characterId) {
      where.push('w.character_id = ?');
      params.push(characterId);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = repo.all(
      `SELECT w.*, (SELECT COUNT(*) FROM worldbook_entries e WHERE e.worldbook_id = w.id) AS entry_count
         FROM worldbooks w ${whereSql} ORDER BY w.updated_at DESC`,
      params,
    );
    const items = rows.map(rowToBook);
    return { items, total: items.length };
  }

  function get(id) {
    const row = repo.get(
      `SELECT w.*, (SELECT COUNT(*) FROM worldbook_entries e WHERE e.worldbook_id = w.id) AS entry_count
         FROM worldbooks w WHERE w.id = ?`,
      [id],
    );
    return rowToBook(row);
  }

  function insert({ name = '未命名世界书', spec = null, data = null, characterId = null, source = 'original' } = {}) {
    const id = newId('wb');
    const now = nowIso();
    const doc = data ?? { name, description: '', scan_depth: null, token_budget: null, recursive_scanning: false, entries: {} };
    const shape = spec ?? detectShape(doc);
    repo.run(
      `INSERT INTO worldbooks (id, name, spec, data, character_id, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, name, shape, JSON.stringify(doc), characterId, source, now, now],
    );
    syncEntries(id, doc);
    return get(id);
  }

  function update(id, patch = {}) {
    const existing = get(id);
    if (!existing) throw new NotFoundError(`世界书 ${id}`);
    const fields = [];
    const params = [];
    if (patch.name !== undefined) {
      fields.push('name = ?');
      params.push(String(patch.name));
    }
    if (patch.data !== undefined) {
      fields.push('data = ?');
      params.push(JSON.stringify(patch.data ?? {}));
    }
    if (patch.spec !== undefined) {
      fields.push('spec = ?');
      params.push(String(patch.spec));
    }
    if (patch.characterId !== undefined) {
      fields.push('character_id = ?');
      params.push(patch.characterId || null);
    }
    if (patch.source !== undefined) {
      fields.push('source = ?');
      params.push(String(patch.source));
    }
    fields.push('updated_at = ?');
    params.push(nowIso(), id);
    repo.run(`UPDATE worldbooks SET ${fields.join(', ')} WHERE id = ?`, params);
    if (patch.data !== undefined) syncEntries(id, patch.data);
    return get(id);
  }

  function remove(id) {
    const existing = get(id);
    if (!existing) throw new NotFoundError(`世界书 ${id}`);
    repo.run('DELETE FROM worldbooks WHERE id = ?', [id]);
    return true;
  }

  // ---------------------------------------------------------------- 条目

  /** 读条目以原始文档为准（数据库列只是投影，会缺字段）。 */
  function entries(id) {
    const book = get(id);
    if (!book) throw new NotFoundError(`世界书 ${id}`);
    return normalizeWorldBook(book.data).entries;
  }

  function nextUid(book) {
    let max = -1;
    for (const entry of book.entries) {
      const n = Number(entry.uid);
      if (Number.isFinite(n) && n > max) max = n;
    }
    return max + 1;
  }

  function saveEntry(id, patch = {}) {
    const book = get(id);
    if (!book) throw new NotFoundError(`世界书 ${id}`);
    const normalized = normalizeEntry(patch, detectShape(book.data), 0);
    if (patch.uid === undefined || patch.uid === null || patch.uid === '') {
      normalized.uid = nextUid({ entries: normalizeWorldBook(book.data).entries });
    }
    const nextDoc = applyEntryToDocument(book.data, normalized);
    update(id, { data: nextDoc });
    // 返回刚写进去的那条（按 uid 找）
    return entries(id).find((entry) => String(entry.uid) === String(normalized.uid)) ?? null;
  }

  function removeEntry(id, uid) {
    const book = get(id);
    if (!book) throw new NotFoundError(`世界书 ${id}`);
    const source = book.data?.character_book && !book.data.entries ? book.data.character_book : book.data;
    const next = structuredClone(source);
    if (Array.isArray(next.entries)) {
      next.entries = next.entries.filter((entry, index) => String(entry?.id ?? index) !== String(uid));
    } else {
      delete next.entries?.[uid];
      // 如果 entries 是对象但 uid 是数字，键可能是字符串化的数字
      for (const key of Object.keys(next.entries ?? {})) {
        if (String(key) === String(uid)) delete next.entries[key];
      }
    }
    update(id, { data: next });
    return true;
  }

  // ---------------------------------------------------------------- 导入导出

  function importDocument(doc, { name = null, characterId = null, source = 'imported' } = {}) {
    const source_doc = doc?.data?.character_book ? doc.data.character_book : doc?.character_book && !doc.entries ? doc.character_book : doc;
    const normalized = normalizeWorldBook(source_doc, name ?? '未命名世界书');
    if (!normalized.entries.length) throw new ValidationError('这个文件里没有世界书条目');
    return insert({ name: name ?? normalized.name, spec: normalized.shape, data: source_doc, characterId, source });
  }

  function exportDocument(id, { shape = null } = {}) {
    const book = get(id);
    if (!book) throw new NotFoundError(`世界书 ${id}`);
    if (!shape) return book.data;
    return convertDocument(book.data, shape);
  }

  return {
    list,
    get,
    insert,
    update,
    remove,
    entries,
    saveEntry,
    removeEntry,
    importDocument,
    exportDocument,
  };
}
