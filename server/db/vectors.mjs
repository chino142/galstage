/**
 * 向量存储：vector_items 一张表管四类内容（世界书 / 参考资料 / 历史对话 / 记忆）。
 * 每条 = 一个内容片段（chunk）一行，带它所属来源与内容哈希（增量更新用）。
 */

import { newId, nowIso, contentHash } from '../../core/ids.mjs';
import { fromJson } from './repo.mjs';

function rowToItem(row, parseVector) {
  if (!row) return null;
  return {
    id: row.id,
    collection: row.collection,
    sourceId: row.source_id,
    chunkIndex: row.chunk_index ?? 0,
    content: row.content ?? '',
    vector: parseVector ? parseVector(row) : null,
    model: row.model ?? null,
    dim: row.dim ?? null,
    contentHash: row.content_hash ?? null,
    meta: fromJson(row.meta, null),
    updatedAt: row.updated_at,
  };
}

/** meta 单独一张表（见 schema V11 的注释），读的时候统一带出来。 */
const SELECT_WITH_META = 'SELECT v.*, m.meta AS meta FROM vector_items v LEFT JOIN vector_item_meta m ON m.item_id = v.id';

export function createVectorStore({ repo }) {
  /**
   * 向量以 JSON 文本存在 SQLite 里，读一行就要 JSON.parse 一次（768 维约 6KB）。
   * 检索放宽到几万条之后，"每轮把整表重新解析一遍"本身就成了新瓶颈，所以按 id
   * 缓存解析结果，用 updated_at 判断有效性。**缓存放实例里而不是模块级**：
   * 多用户模式下一进程里有多个租户各自的库，模块级缓存会跨租户串数据。
   */
  const VECTOR_CACHE_LIMIT = 80000;
  const vectorCache = new Map();

  function parseVector(row) {
    const id = row.id;
    const stamp = row.updated_at ?? '';
    const cached = vectorCache.get(id);
    if (cached && cached.stamp === stamp) return cached.vector;
    const parsed = fromJson(row.vector, null);
    const vector = Array.isArray(parsed) ? parsed : null;
    if (vectorCache.size >= VECTOR_CACHE_LIMIT) vectorCache.clear();
    vectorCache.set(id, { stamp, vector });
    return vector;
  }

  /** 写路径上把缓存里那条作废，免得读到调用方刚改过的旧向量。 */
  function forgetVector(id) {
    vectorCache.delete(id);
  }

  function getBySource(collection, sourceId) {
    return repo
      .all(`${SELECT_WITH_META} WHERE v.collection = ? AND v.source_id = ? ORDER BY v.chunk_index`, [collection, sourceId])
      .map((row) => rowToItem(row, parseVector));
  }

  function upsert({ id = null, collection, sourceId, chunkIndex = 0, content = '', vector = null, model = null, meta = null }) {
    const hash = contentHash(content);
    const now = nowIso();
    const existing = repo.get('SELECT * FROM vector_items WHERE collection = ? AND source_id = ? AND chunk_index = ?', [collection, sourceId, chunkIndex]);
    const dim = Array.isArray(vector) ? vector.length : null;
    const itemId = id ?? existing?.id ?? newId('vec');
    if (existing) {
      repo.run(
        'UPDATE vector_items SET content = ?, vector = ?, model = ?, dim = ?, content_hash = ?, updated_at = ? WHERE id = ?',
        [content, vector ? JSON.stringify(vector) : null, model, dim, hash, now, itemId],
      );
    } else {
      repo.run(
        'INSERT INTO vector_items (id, collection, source_id, chunk_index, content, vector, model, dim, content_hash, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [itemId, collection, sourceId, chunkIndex, content, vector ? JSON.stringify(vector) : null, model, dim, hash, now],
      );
    }
    if (meta !== undefined && meta !== null) touchMeta(collection, sourceId, meta);
    forgetVector(itemId);
    return rowToItem(repo.get(`${SELECT_WITH_META} WHERE v.id = ?`, [itemId]), parseVector);
  }

  /** 只补写 meta（索引完再回填时间戳之类），不动向量。 */
  function touchMeta(collection, sourceId, meta) {
    const ids = repo.all('SELECT id FROM vector_items WHERE collection = ? AND source_id = ?', [collection, sourceId]);
    for (const row of ids) {
      repo.run(
        'INSERT INTO vector_item_meta (item_id, meta) VALUES (?, ?) ON CONFLICT(item_id) DO UPDATE SET meta = excluded.meta',
        [row.id, meta ? JSON.stringify(meta) : null],
      );
    }
  }

  function deleteBySource(collection, sourceId) {
    const row = repo.get('SELECT COUNT(*) AS n FROM vector_items WHERE collection = ? AND source_id = ?', [collection, sourceId]);
    repo.run('DELETE FROM vector_item_meta WHERE item_id IN (SELECT id FROM vector_items WHERE collection = ? AND source_id = ?)', [collection, sourceId]);
    repo.run('DELETE FROM vector_items WHERE collection = ? AND source_id = ?', [collection, sourceId]);
    return Number(row?.n ?? 0);
  }

  /**
   * 拉片段。以前默认 500、检索里写死 2000 —— 超过就永远搜不到，是个隐形上限。
   * 现在默认放宽，另外给出 total() 让调用方能知道真实规模。
   */
  function list({ collection = null, limit = 50000 } = {}) {
    const rows = collection
      ? repo.all(`${SELECT_WITH_META} WHERE v.collection = ? ORDER BY v.updated_at DESC LIMIT ?`, [collection, Number(limit) || 50000])
      : repo.all(`${SELECT_WITH_META} ORDER BY v.updated_at DESC LIMIT ?`, [Number(limit) || 50000]);
    return rows.map((row) => rowToItem(row, parseVector));
  }

  function total() {
    return Number(repo.get('SELECT COUNT(*) AS n FROM vector_items')?.n ?? 0);
  }

  /** 按 id 批量回表（外部向量库只返回 id，正文要从这里取）。 */
  function getMany(ids = []) {
    const out = [];
    for (const id of ids) {
      const row = repo.get(`${SELECT_WITH_META} WHERE v.id = ?`, [id]);
      if (row) out.push(rowToItem(row, parseVector));
    }
    return out;
  }

  function stats() {
    const rows = repo.all('SELECT collection, COUNT(*) AS n, SUM(CASE WHEN vector IS NULL THEN 1 ELSE 0 END) AS pending FROM vector_items GROUP BY collection');
    const byCollection = {};
    let total = 0;
    let pending = 0;
    for (const row of rows) {
      byCollection[row.collection] = Number(row.n);
      total += Number(row.n);
      pending += Number(row.pending ?? 0);
    }
    return { byCollection, total, pending };
  }

  function removeAll(collection = null) {
    if (collection) {
      repo.run('DELETE FROM vector_item_meta WHERE item_id IN (SELECT id FROM vector_items WHERE collection = ?)', [collection]);
      repo.run('DELETE FROM vector_items WHERE collection = ?', [collection]);
    } else {
      repo.run('DELETE FROM vector_item_meta');
      repo.run('DELETE FROM vector_items');
    }
    return true;
  }

  return { getBySource, upsert, touchMeta, deleteBySource, list, total, getMany, stats, removeAll };
}
