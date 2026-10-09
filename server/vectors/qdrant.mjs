/**
 * 外部向量库：Qdrant（可选）。
 *
 * 为什么是 Qdrant：它有一套完整的 REST API，用 fetch 就能调 —— 这个项目的硬约束是
 * 零第三方**运行时依赖**，所以不能引 SDK，只能用 HTTP。同类里 Milvus / Chroma 也
 * 有 REST，将来照这个形状再加一个实现就行。
 *
 * 定位（重要）：**它只当"候选生成器"，不负责最终排序。**
 *   · 内置检索是"把整表拉进内存暴力算余弦"，几十万条就顶不住了；Qdrant 有 ANN 索引。
 *   · 但分数口径必须一致，否则切换后端会出现"同一句话换个后端结果变差"。
 *   · 所以：Qdrant 负责用 ANN 找出候选，拿 id 回本地表取正文，
 *     再用 core/vectors/service.mjs 里那套同一公式重算一遍分。
 *   · Qdrant 挂了 / 连不上 → 调用方 catch 后回退内置检索，功能不中断。
 *
 * 点 id：Qdrant 只接受 uint64 或 UUID，我们的 id 是 `vec_xxx` 这种字符串，
 * 所以用 sha256 派生一个稳定的 UUID（同一个 id 永远得到同一个 UUID）。
 */

import { createHash } from 'node:crypto';

/** 把内部 id 映射成稳定的 UUID（Qdrant 的硬要求）。 */
export function pointIdOf(id) {
  const hex = createHash('sha256').update(String(id)).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function createQdrantBackend({
  url = 'http://127.0.0.1:6333',
  apiKey = null,
  collection = 'silver_tavern',
  timeoutMs = 8000,
  logger = null,
  fetchImpl = null,
} = {}) {
  const base = String(url ?? '').trim().replace(/\/+$/, '');
  const doFetch = fetchImpl ?? fetch;
  let ensuredDim = 0;

  function headers() {
    const out = { 'content-type': 'application/json' };
    if (apiKey) out['api-key'] = apiKey;
    return out;
  }

  async function call(pathname, { method = 'GET', body = null } = {}) {
    const response = await doFetch(`${base}${pathname}`, {
      method,
      headers: headers(),
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = { raw: text.slice(0, 300) };
    }
    if (!response.ok) {
      const detail = payload?.status?.error ?? payload?.message ?? payload?.raw ?? `HTTP ${response.status}`;
      throw new Error(`Qdrant ${method} ${pathname} 失败：${detail}`);
    }
    return payload;
  }

  /** 惰性建集合：维度要等第一个向量来了才知道。 */
  async function ensure(dim) {
    if (!dim || ensuredDim === dim) return;
    try {
      await call(`/collections/${encodeURIComponent(collection)}`);
      ensuredDim = dim;
      return;
    } catch {
      /* 不存在就建 */
    }
    await call(`/collections/${encodeURIComponent(collection)}`, {
      method: 'PUT',
      body: { vectors: { size: dim, distance: 'Cosine' } },
    });
    ensuredDim = dim;
  }

  function collectionFilter(collection) {
    return collection ? [{ key: 'collection', match: { value: collection } }] : [];
  }

  async function upsert({ points = [] } = {}) {
    if (!points.length) return { upserted: 0 };
    await ensure(points[0].vector?.length ?? 0);
    const payload = {
      points: points.map((point) => ({
        id: pointIdOf(point.id),
        vector: point.vector,
        payload: point.payload ?? {},
      })),
    };
    await call(`/collections/${encodeURIComponent(collection)}/points?wait=true`, { method: 'PUT', body: payload });
    return { upserted: payload.points.length };
  }

  /**
   * 向量检索。多条查询各搜一次，同一个点取最高分（跟内置的多查询融合口径一致）。
   * 返回 [{ id, score }]，id 是**内部 id**（调用方拿去回本地表取正文）。
   */
  async function search({ vectors = [], collections = null, topK = 30 } = {}) {
    const best = new Map();
    for (const vector of vectors) {
      if (!Array.isArray(vector) || !vector.length) continue;
      await ensure(vector.length);
      const result = await call(`/collections/${encodeURIComponent(collection)}/points/search`, {
        method: 'POST',
        body: {
          vector,
          limit: Math.max(1, Math.min(400, Number(topK) || 30)),
          with_payload: true,
          filter: collections?.length ? { must: [{ key: 'collection', match: { any: collections } }] } : undefined,
        },
      });
      for (const hit of result?.result ?? []) {
        const id = hit.payload?.itemId ?? null;
        if (!id) continue;
        const score = Number(hit.score ?? 0);
        if (!best.has(id) || best.get(id) < score) best.set(id, score);
      }
    }
    return [...best.entries()].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score);
  }

  async function deleteBySource(collectionId, sourceId) {
    await call(`/collections/${encodeURIComponent(collection)}/points/delete?wait=true`, {
      method: 'POST',
      body: { filter: { must: [...collectionFilter(collectionId), { key: 'sourceId', match: { value: sourceId } }] } },
    });
    return true;
  }

  async function clear({ collection: collectionId = null } = {}) {
    const must = collectionFilter(collectionId);
    if (!must.length) {
      // 全清：直接删集合（下次写入会自动重建）
      await call(`/collections/${encodeURIComponent(collection)}`, { method: 'DELETE' });
      ensuredDim = 0;
      return true;
    }
    await call(`/collections/${encodeURIComponent(collection)}/points/delete?wait=true`, { method: 'POST', body: { filter: { must } } });
    return true;
  }

  async function status() {
    const info = await call(`/collections/${encodeURIComponent(collection)}`);
    return {
      configured: true,
      backend: 'qdrant',
      ok: true,
      url: base,
      collection,
      points: info?.result?.points_count ?? null,
      dim: info?.result?.config?.params?.vectors?.size ?? null,
    };
  }

  logger?.debug?.(`外部向量库已启用：${base} / ${collection}`);
  return { kind: 'qdrant', ensure, upsert, search, deleteBySource, clear, status, pointIdOf };
}
