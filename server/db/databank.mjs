/**
 * 参考资料（databank）存储：reference_docs 一张表。
 *
 * 这里只存**原文**。向量是它的衍生物（存在 vector_items 的 databank 集合里），
 * 所以随时可以清掉重建成 —— 以前片段只活在向量表里，一重建就没了。
 *
 * 导入流程：写原文 → 交给向量服务切块 + 嵌入。切块大小跟着文档走，
 * 所以 400/40 这两个默认值也一起存下来，重建时不至于换一套参数。
 */

import { newId, nowIso } from '../../core/ids.mjs';
import { fromJson } from './repo.mjs';
import { NotFoundError, ValidationError } from '../../core/errors.mjs';

const MAX_TITLE = 120;
const MAX_CHARS = 4 * 1024 * 1024; // 单份资料 4MB 文本，够放整本设定集了

function rowToDoc(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title ?? '',
    source: row.source ?? '',
    content: row.content ?? '',
    tags: Array.isArray(fromJson(row.tags, [])) ? fromJson(row.tags, []) : [],
    charCount: String(row.content ?? '').length,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createReferenceStore({ repo }) {
  /** 列表默认不带正文（正文可能很大），要正文用 get()。 */
  function list({ limit = 200 } = {}) {
    const rows = repo.all(
      `SELECT id, title, source, tags, LENGTH(content) AS n, created_at, updated_at
       FROM reference_docs ORDER BY updated_at DESC LIMIT ?`,
      [Number(limit) || 200],
    );
    return {
      items: rows.map((row) => ({
        id: row.id,
        title: row.title ?? '',
        source: row.source ?? '',
        tags: fromJson(row.tags, []),
        charCount: Number(row.n ?? 0),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
      total: rows.length,
    };
  }

  function get(id) {
    return rowToDoc(repo.get('SELECT * FROM reference_docs WHERE id = ?', [id]));
  }

  function insert({ title = '', source = '', content = '', tags = [] } = {}) {
    const text = String(content ?? '');
    if (!text.trim()) throw new ValidationError('参考资料内容不能为空');
    if (text.length > MAX_CHARS) throw new ValidationError(`单份参考资料不能超过 ${Math.round(MAX_CHARS / 1024)}KB 文本`);
    const id = newId('ref');
    const now = nowIso();
    repo.run(
      `INSERT INTO reference_docs (id, title, source, content, tags, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, String(title ?? '').trim().slice(0, MAX_TITLE) || '未命名资料', String(source ?? ''), text, JSON.stringify(Array.isArray(tags) ? tags : []), now, now],
    );
    return get(id);
  }

  function update(id, patch = {}) {
    const existing = get(id);
    if (!existing) throw new NotFoundError(`参考资料 ${id}`);
    const fields = [];
    const params = [];
    if (patch.title !== undefined) {
      fields.push('title = ?');
      params.push(String(patch.title ?? '').trim().slice(0, MAX_TITLE) || existing.title);
    }
    if (patch.content !== undefined) {
      const text = String(patch.content ?? '');
      if (!text.trim()) throw new ValidationError('参考资料内容不能为空');
      if (text.length > MAX_CHARS) throw new ValidationError(`单份参考资料不能超过 ${Math.round(MAX_CHARS / 1024)}KB 文本`);
      fields.push('content = ?');
      params.push(text);
    }
    if (patch.tags !== undefined) {
      fields.push('tags = ?');
      params.push(JSON.stringify(Array.isArray(patch.tags) ? patch.tags : []));
    }
    if (!fields.length) return existing;
    fields.push('updated_at = ?');
    params.push(nowIso(), id);
    repo.run(`UPDATE reference_docs SET ${fields.join(', ')} WHERE id = ?`, params);
    return get(id);
  }

  function remove(id) {
    if (!get(id)) throw new NotFoundError(`参考资料 ${id}`);
    repo.run('DELETE FROM reference_docs WHERE id = ?', [id]);
    return true;
  }

  function stats() {
    const row = repo.get('SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(content)), 0) AS chars FROM reference_docs');
    return { docs: Number(row?.n ?? 0), chars: Number(row?.chars ?? 0) };
  }

  return { list, get, insert, update, remove, stats };
}
