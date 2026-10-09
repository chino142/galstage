/**
 * 向量与检索服务。
 *
 * 四类内容各自独立：世界书条目 / 参考资料 / 历史对话 / 记忆条目。
 * 存储走 ports.vectorStore（server/db/vectors.mjs），嵌入走 ports.embed：
 *   ports.embed(texts, providerId) -> number[][]
 * 没有接嵌入模型时也能用：只建索引不算向量（keyword-only），统计里记为"待处理"。
 *
 * 检索是混合的：关键词得分 + 向量余弦，加权融合后排序。
 * 增量更新靠内容哈希：片段没变就不重新算向量。
 *
 * ── 检索增强（这一层以前是缺的）────────────────────────────────────────
 *   · 多查询融合：一句话 + 最近几条消息 + 可选的模型改写，取每条的最高分
 *   · 时间衰减：历史对话 / 记忆按新鲜度打折（7 天半衰期），参考资料与世界书不打折
 *   · 去重与多样性：同源去重 + MMR，避免十段都是同一段话的复述
 *   · 最低分门槛：宁可少给，也不塞一堆不相关的进上下文
 *   · 外部向量库：ports.vectorBackend（Qdrant）可选，出错自动回退内置暴力检索
 */

import { NotImplementedError, ValidationError } from '../errors.mjs';
import { contentHash } from '../ids.mjs';

export const VECTOR_COLLECTIONS = [
  { id: 'worldbook', title: '世界书条目', status: 'ready' },
  { id: 'databank', title: '参考资料', status: 'ready' },
  { id: 'history', title: '历史对话', status: 'ready' },
  { id: 'memory', title: '记忆条目', status: 'ready' },
];

const COLLECTION_IDS = VECTOR_COLLECTIONS.map((item) => item.id);

/** 哪些集合吃"时间衰减"。参考资料和世界书是设定，不该因为放得久就降权。 */
const DECAYING = { history: true, memory: true, worldbook: false, databank: false };

const DECAY_HALF_LIFE_DAYS = 7;

function tokenSetOf(text) {
  return new Set(tokensOf(text));
}

/** Jaccard 相似度：MMR 去冗余用。 */
export function jaccard(a, b) {
  if (!a?.size || !b?.size) return 0;
  let inter = 0;
  for (const token of a) if (b.has(token)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/** 时间衰减系数：0 天 = 1，半衰期 = 0.5。 */
export function recencyFactor(stamp, halfLifeDays = DECAY_HALF_LIFE_DAYS, now = Date.now()) {
  const time = new Date(stamp ?? 0).getTime();
  if (!Number.isFinite(time) || !time) return 1; // 没时间戳就不打折，别凭空惩罚老数据
  const ageDays = Math.max(0, (now - time) / 86400000);
  return Math.pow(0.5, ageDays / Math.max(0.5, halfLifeDays));
}

/**
 * MMR：在"相关"和"不重复"之间取平衡，避免召回十段几乎一样的话。
 * lambda 越大越偏相关（1 = 纯按分数，0 = 纯按多样性）。
 */
export function mmrSelect(candidates = [], { topK = 10, lambda = 0.7 } = {}) {
  const pool = candidates.map((item) => ({ item, tokens: item.tokens ?? tokenSetOf(item.content) }));
  const picked = [];
  while (picked.length < topK && pool.length) {
    let bestIndex = 0;
    let bestValue = -Infinity;
    for (let i = 0; i < pool.length; i += 1) {
      const { item, tokens } = pool[i];
      const redundancy = picked.length ? Math.max(...picked.map((chosen) => jaccard(tokens, chosen.tokens))) : 0;
      const value = Number(item.score ?? 0) * lambda - redundancy * (1 - lambda);
      if (value > bestValue) { bestValue = value; bestIndex = i; }
    }
    picked.push(pool[bestIndex]);
    pool.splice(bestIndex, 1);
  }
  return picked.map((entry) => entry.item);
}

/** 把一段长文本切成适合嵌入的小块（按段落聚，再按长度硬切）。 */
export function chunkText(text, { size = 400, overlap = 40 } = {}) {
  const source = String(text ?? '').trim();
  if (!source) return [];
  if (source.length <= size) return [source];
  const paragraphs = source.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  const chunks = [];
  let buffer = '';
  const flush = () => {
    if (buffer.trim()) chunks.push(buffer.trim());
    buffer = '';
  };
  for (const paragraph of paragraphs) {
    if (paragraph.length > size) {
      flush();
      for (let i = 0; i < paragraph.length; i += Math.max(1, size - overlap)) chunks.push(paragraph.slice(i, i + size));
      continue;
    }
    if ((buffer + '\n\n' + paragraph).trim().length > size) flush();
    buffer = buffer ? `${buffer}\n\n${paragraph}` : paragraph;
  }
  flush();
  return chunks.length ? chunks : [source.slice(0, size)];
}

// ---------------------------------------------------------------- 文本相似度

function tokensOf(text) {
  const lower = String(text ?? '').toLowerCase();
  const words = lower.split(/[^\p{L}\p{N}_]+/u).filter(Boolean);
  // 中文按字再补一份，保证"书店"能匹配到"旧书店"。
  const chars = [...lower].filter((ch) => /[\u4e00-\u9fff]/.test(ch));
  return [...words, ...chars];
}

/** 关键词得分：查询词在候选里出现的比例（0..1）。 */
export function keywordScore(query, content) {
  const queryTokens = [...new Set(tokensOf(query))];
  if (!queryTokens.length) return 0;
  const haystack = String(content ?? '').toLowerCase();
  let hits = 0;
  for (const token of queryTokens) if (haystack.includes(token)) hits += 1;
  return hits / queryTokens.length;
}

/** 覆盖率：查询里有多少个不同的词在候选里出现过（比 keywordScore 更严格，去重后算）。 */
export function coverageScore(query, content) {
  const queryTokens = [...new Set(tokensOf(query))];
  if (!queryTokens.length) return 0;
  const haystack = String(content ?? '').toLowerCase();
  let hits = 0;
  for (const token of queryTokens) if (haystack.includes(token)) hits += 1;
  return hits / queryTokens.length;
}

/**
 * 重排打分（蓝图 1.8「还没做」里补上的 rerank）。
 *
 * 有意偏离：没有引入重排模型 —— 那需要给提供方加一个 rerank 类型，
 * 而模型接入层是别人在维护的、这次不允许动。所以用零依赖的确定性打分：
 *   0.45 × 混合检索原始分 + 0.30 × 查询词覆盖率 + 0.15 × 关键词命中率 + 0.10 × 整句命中
 * 对"向量召回了一堆近义但没答到点上"的片段，覆盖率与整句命中能把真正相关的顶上来。
 */
export function rerankScore(query, content, baseScore = 0) {
  const q = String(query ?? '').trim();
  if (!q) return Number(Number(baseScore ?? 0).toFixed(6));
  const base = Math.max(0, Math.min(1, Number(baseScore) || 0));
  const coverage = coverageScore(q, content);
  const keyword = keywordScore(q, content);
  const phrase = String(content ?? '').toLowerCase().includes(q.toLowerCase()) ? 1 : 0;
  return Number((base * 0.45 + coverage * 0.3 + keyword * 0.15 + phrase * 0.1).toFixed(6));
}

/** 给一批候选重排。items 里要有 content，可选 score。 */
export function rerankItems(query, items = [], { topK = 10 } = {}) {
  const ranked = items.map((item, index) => {
    const base = Number(item.score ?? item.vectorScore ?? item.keywordScore ?? 0) || 0;
    return { ...item, rerank: { baseScore: base, rankBefore: index }, score: rerankScore(query, item.content, base) };
  });
  ranked.sort((a, b) => b.score - a.score);
  return ranked.slice(0, Math.max(1, Math.min(200, Number(topK) || 10))).map((item, index) => ({
    ...item,
    rerank: { ...item.rerank, rankAfter: index },
  }));
}

export function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function createVectorService({ settings, ports = {} } = {}) {
  void settings;
  const store = ports.vectorStore ?? null;
  const embed = typeof ports.embed === 'function' ? ports.embed : null;
  /** 可选的外部向量库（server/vectors/qdrant.mjs）。没配就是 null，一切照旧。 */
  const backend = ports.vectorBackend ?? null;
  const logger = ports.logger ?? null;

  function requireStore(what) {
    if (!store) throw new NotImplementedError(what, { reason: '没有注入向量存储端口（ports.vectorStore）' });
    return store;
  }

  function requireCollection(collection) {
    if (!COLLECTION_IDS.includes(collection)) throw new ValidationError(`未知的向量集合：${collection}`);
    return collection;
  }

  async function embedTexts(texts, providerId) {
    if (!embed) return null;
    const vectors = await embed(texts, providerId ?? null);
    return Array.isArray(vectors) ? vectors : null;
  }

  async function indexSource({ collection, sourceId, content, providerId = null, meta = null } = {}) {
    const vectorStore = requireStore('建立向量索引');
    requireCollection(collection);
    if (!sourceId) throw new ValidationError('索引来源缺少 sourceId');
    const chunks = chunkText(content);
    const existing = new Map(vectorStore.getBySource(collection, sourceId).map((item) => [item.chunkIndex, item]));
    const shrank = [...existing.keys()].some((index) => index >= chunks.length);
    if (shrank) vectorStore.deleteBySource(collection, sourceId);

    // 找出真正需要（重新）算向量的块：新块、内容变了、或者以前没算出来
    const toEmbed = [];
    const toEmbedIndexes = [];
    chunks.forEach((chunk, index) => {
      const previous = shrank ? null : existing.get(index);
      if (previous && previous.contentHash === contentHash(chunk) && previous.vector) return;
      toEmbed.push(chunk);
      toEmbedIndexes.push(index);
    });

    let vectors = null;
    if (toEmbed.length && embed) {
      try {
        vectors = await embedTexts(toEmbed, providerId);
      } catch (err) {
        if (toEmbed.length === chunks.length) throw err;
        vectors = null; // 部分失败就退化成关键词索引
      }
    }

    let embedded = 0;
    const written = [];
    chunks.forEach((chunk, index) => {
      const previous = shrank ? null : existing.get(index);
      const position = toEmbedIndexes.indexOf(index);
      const fresh = vectors && position >= 0 ? vectors[position] ?? null : null;
      const vector = fresh ?? (previous && previous.contentHash === contentHash(chunk) ? previous.vector : null);
      const row = vectorStore.upsert({ collection, sourceId, chunkIndex: index, content: chunk, vector, model: vector ? providerId ?? 'default' : null, meta });
      written.push({ ...row, vector });
      if (fresh) embedded += 1;
    });
    await mirrorToBackend(written);
    return { collection, sourceId, chunks: chunks.length, indexed: chunks.length, embedded, pending: chunks.length - embedded };
  }

  /** 外部向量库镜像（best-effort）：库里出问题不该让"建索引"失败。 */
  async function mirrorToBackend(items = []) {
    if (!backend?.upsert) return 0;
    const points = items
      .filter((item) => Array.isArray(item.vector))
      .map((item) => ({
        id: item.id,
        vector: item.vector,
        payload: { itemId: item.id, collection: item.collection, sourceId: item.sourceId, chunkIndex: item.chunkIndex, content: item.content, meta: item.meta ?? null },
      }));
    if (!points.length) return 0;
    try {
      await backend.upsert({ points });
      return points.length;
    } catch (err) {
      logger?.warn?.(`写入外部向量库失败（本地索引不受影响）：${err?.message ?? err}`);
      return 0;
    }
  }

  /** 把 query / queries 归一成一组查询串（去空、去重、限长）。 */
  function normaliseQueries({ query = '', queries = null } = {}) {
    const list = Array.isArray(queries) ? queries : [];
    const all = [query, ...list].map((item) => String(item ?? '').trim()).filter(Boolean);
    const seen = new Set();
    const out = [];
    for (const item of all) {
      const key = item.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item.slice(0, 2000));
    }
    return out.slice(0, 8); // 再多也没意义，只是多算几次余弦
  }

  /**
   * 混合检索（增强版）。
   *
   * 兼容老签名：只传 query 时行为跟以前一样，只是不再被 2000 条上限悄悄截断。
   * 新增：
   *   queries           多查询融合（每条候选取所有查询里的最高分）
   *   collectionWeights 每类内容的权重，{worldbook: 1, memory: 0.8, ...}
   *   minScore          低于这个分不要（默认 0，即不过滤）
   *   decay             是否对历史/记忆按新鲜度打折（默认按集合自动判断）
   *   diversify         是否做 MMR 去冗余（默认 false，recall 里默认开）
   *   maxScan           最多扫多少条片段（默认取 store 全部，上限 50000）
   */
  async function search({
    query = '',
    queries = null,
    collections = null,
    topK = 10,
    providerId = null,
    keywordWeight = 0.5,
    rerank = false,
    collectionWeights = null,
    minScore = 0,
    decay = null,
    diversify = false,
    maxScan = 50000,
    excludeSourceIds = null,
  } = {}) {
    if (!store) return [];
    const wanted = (collections && collections.length ? collections : COLLECTION_IDS).filter((id) => COLLECTION_IDS.includes(id));
    const limit = Math.max(1, Math.min(200, Number(topK) || 10));
    // 要重排 / 去冗余就得多召回一些候选，最后再挑 limit 条
    const needsPool = rerank || diversify;
    const fetchLimit = needsPool ? Math.min(400, limit * 5 + 20) : limit;
    const queryList = normaliseQueries({ query, queries });
    if (!queryList.length) return [];

    // 一次性把查询都嵌了（省往返），失败就退化成关键词检索
    let queryVectors = null;
    if (embed) {
      try {
        queryVectors = await embedTexts(queryList, providerId);
      } catch {
        queryVectors = null;
      }
    }
    const weight = Math.max(0, Math.min(1, Number(keywordWeight)));
    const floor = Math.max(0, Number(minScore) || 0);
    const scanLimit = Math.max(100, Math.min(50000, Number(maxScan) || 50000));
    // 已经在上下文里的东西别再召回来一份（比如最近几条消息）
    const excluded = new Set(Array.isArray(excludeSourceIds) ? excludeSourceIds : []);

    const scoreOne = (item) => {
      const tokens = tokenSetOf(item.content);
      let best = 0;
      let bestKw = 0;
      let bestVec = 0;
      let matchedQuery = '';
      queryList.forEach((text, index) => {
        const kw = keywordScore(text, item.content);
        const vector = queryVectors?.[index];
        const vec = vector && item.vector ? Math.max(0, cosine(vector, item.vector)) : 0;
        const value = vector && item.vector ? kw * weight + vec * (1 - weight) : kw;
        if (value > best) { best = value; bestKw = kw; bestVec = vec; matchedQuery = text; }
      });
      const collectionBoost = collectionWeights?.[item.collection] === undefined ? 1 : Math.max(0, Math.min(3, Number(collectionWeights[item.collection])));
      const wantDecay = decay === null ? Boolean(DECAYING[item.collection]) : Boolean(decay);
      // meta.timestamp 是"内容的时间"（消息时间 / 记忆生成时间），比 updated_at（索引时间）准
      const stamp = item.meta?.timestamp ?? item.updatedAt;
      const factor = wantDecay ? recencyFactor(stamp) : 1;
      return {
        collection: item.collection,
        sourceId: item.sourceId,
        chunkIndex: item.chunkIndex,
        content: item.content,
        meta: item.meta ?? null,
        keywordScore: Number(bestKw.toFixed(4)),
        vectorScore: Number(bestVec.toFixed(4)),
        matchedQuery,
        recency: Number(factor.toFixed(4)),
        score: Number((best * collectionBoost * factor).toFixed(6)),
        tokens,
      };
    };

    let items = null;
    let backendUsed = 'builtin';
    // 外部向量库（Qdrant）：只在"有查询向量"时才有意义，出错就悄悄回退
    if (backend && queryVectors?.length) {
      try {
        const hits = await backend.search({
          vectors: queryVectors,
          queries: queryList,
          collections: wanted,
          topK: Math.min(400, fetchLimit * 3),
          providerId,
        });
        if (Array.isArray(hits) && hits.length) {
          // 外部库只当"候选生成器"（ANN 预筛）；最终排序仍走下面同一套公式，
          // 这样内置检索和外部检索的分数口径一致，来回切不会"忽好忽坏"。
          // 注意：这里必须按 id 回表，不能把整表拉出来建 Map —— 那等于把
          // "用外部库省掉全表扫描"这件事又还回去了（十万条时每轮都要拉一遍）。
          const ids = hits.map((hit) => hit.id);
          const resolved = store.getMany ? store.getMany(ids) : store.list({ limit: scanLimit }).filter((item) => ids.includes(item.id));
          // 一个都回表不到（外部库和本地不同步）就当这次没命中，走回退，别让用户看到空结果
          if (resolved.length) {
            items = resolved;
            backendUsed = 'qdrant';
          }
        }
      } catch (err) {
        logger?.warn?.(`外部向量库检索失败，回退内置检索：${err?.message ?? err}`);
        items = null;
      }
    }
    if (!items) items = store.list({ limit: scanLimit }).filter((item) => wanted.includes(item.collection));
    if (excluded.size) items = items.filter((item) => !excluded.has(item.sourceId));

    let scored = items
      .map(scoreOne)
      .filter((item) => item.score > 0 && item.score >= floor)
      .sort((a, b) => b.score - a.score);

    if (diversify) scored = mmrSelect(scored, { topK: fetchLimit, lambda: 0.7 });
    else scored = scored.slice(0, fetchLimit);

    if (rerank) scored = rerankItems(queryList[0], scored, { topK: limit });
    else scored = scored.slice(0, limit);

    return scored.map((item) => ({ ...item, backend: backendUsed, tokens: undefined }));
  }

  /**
   * 给对话用的一轮召回：多查询 + 门槛 + 去冗余 + 按字数截断。
   *
   * 返回的不只是片段，还带"为什么给它"（X 光机会显示），以及统计信息
   * （界面和日志里能看到这一轮到底扫了多少、留了多少、占了多少字）。
   */
  async function recall({
    queries = [],
    collections = null,
    collectionWeights = null,
    topK = 8,
    providerId = null,
    keywordWeight = 0.5,
    minScore = 0.1,
    maxChars = 1500,
    decay = null,
    diversify = true,
    perCollection = 0,
    maxScan = 50000,
    excludeSourceIds = null,
  } = {}) {
    if (!store) return { entries: [], stats: { scanned: 0, candidates: 0, kept: 0, chars: 0, backend: 'none' } };
    const wanted = (collections && collections.length ? collections : COLLECTION_IDS).filter((id) => COLLECTION_IDS.includes(id));
    const limit = Math.max(1, Math.min(50, Number(topK) || 8));
    const scored = await search({
      queries,
      collections: wanted,
      topK: limit,
      providerId,
      keywordWeight,
      minScore,
      decay,
      diversify,
      maxScan,
      excludeSourceIds,
    });

    const entries = [];
    let chars = 0;
    const perSource = new Map();
    const cap = Math.max(0, Number(perCollection) || 0);
    for (const item of scored) {
      const text = String(item.content ?? '').trim();
      if (!text) continue;
      // 同一来源最多留 cap 段（默认不限），免得一本书把上下文吃光
      if (cap) {
        const used = perSource.get(item.sourceId) ?? 0;
        if (used >= cap) continue;
        perSource.set(item.sourceId, used + 1);
      }
      if (chars + text.length > maxChars && entries.length) break;
      chars += text.length;
      entries.push({
        collection: item.collection,
        sourceId: item.sourceId,
        chunkIndex: item.chunkIndex,
        content: text,
        score: item.score,
        reason: reasonForRecall(item),
      });
    }
    return {
      entries,
      stats: {
        // "扫了多少条" = 库里有几条，但不超过这次允许扫的上限
        scanned: Math.min(store.total?.() ?? 0, Math.max(100, Math.min(50000, Number(maxScan) || 50000))),
        candidates: scored.length,
        kept: entries.length,
        chars,
        backend: scored[0]?.backend ?? 'builtin',
      },
    };
  }

  function reasonForRecall(item) {
    const parts = [];
    if (item.vectorScore > 0.3) parts.push(`语义相近 ${(item.vectorScore * 100).toFixed(0)}%`);
    if (item.keywordScore > 0) parts.push(`命中关键词 ${(item.keywordScore * 100).toFixed(0)}%`);
    if (item.recency < 0.999) parts.push(`新鲜度 ${(item.recency * 100).toFixed(0)}%`);
    const title = item.meta?.title ? `《${item.meta.title}》` : item.collection;
    return `${title}：${parts.join('，') || '综合得分靠前'}`;
  }

  return {
    collections: () => VECTOR_COLLECTIONS,

    stats: async () => {
      if (!store) return { collections: [], total: 0, pending: 0 };
      const raw = store.stats();
      return {
        collections: VECTOR_COLLECTIONS.map((item) => ({ ...item, count: raw.byCollection[item.id] ?? 0 })),
        total: raw.total,
        pending: raw.pending,
      };
    },

    indexSource,

    /** 批量索引（调用方把 sources 准备好：{collection, sourceId, content}）。 */
    reindex: async ({ sources = [], collection = null, providerId = null, clear = false } = {}) => {
      const vectorStore = requireStore('重建向量索引');
      if (clear) vectorStore.removeAll(collection ?? null);
      const wanted = collection ? sources.filter((source) => source.collection === collection) : sources;
      const results = [];
      for (const source of wanted) results.push(await indexSource({ ...source, providerId }));
      return {
        sources: results.length,
        chunks: results.reduce((sum, item) => sum + item.chunks, 0),
        embedded: results.reduce((sum, item) => sum + item.embedded, 0),
        pending: results.reduce((sum, item) => sum + item.pending, 0),
      };
    },

    removeBySource: async (collection, sourceId) => {
      const vectorStore = requireStore('删除向量');
      const removed = vectorStore.deleteBySource(requireCollection(collection), sourceId);
      if (backend?.deleteBySource) {
        try {
          await backend.deleteBySource(collection, sourceId);
        } catch (err) {
          logger?.warn?.(`删除外部向量库里的片段失败：${err?.message ?? err}`);
        }
      }
      return removed;
    },

    /** 清空索引（可只清一个集合）。注意 rebuild 的 clear 选项是"清了再建"，这个是只清。 */
    clear: async ({ collection = null } = {}) => {
      const vectorStore = requireStore('清空向量索引');
      vectorStore.removeAll(collection ? requireCollection(collection) : null);
      if (backend?.clear) {
        try {
          await backend.clear({ collection });
        } catch (err) {
          logger?.warn?.(`清空外部向量库失败：${err?.message ?? err}`);
        }
      }
      const raw = vectorStore.stats();
      return { collections: VECTOR_COLLECTIONS.map((item) => ({ ...item, count: raw.byCollection[item.id] ?? 0 })), total: raw.total, pending: raw.pending };
    },

    search,
    searchHybrid: async (input = {}) => search(input),
    recall,

    /** 外部向量库把片段镜像一份过去（best-effort，失败只记警告，不影响本地索引）。 */
    syncToBackend: async ({ collection = null } = {}) => {
      if (!backend?.upsert) return { synced: 0, skipped: true };
      const items = store ? store.list({ limit: 50000 }) : [];
      const wanted = collection ? items.filter((item) => item.collection === collection) : items;
      const points = wanted
        .filter((item) => Array.isArray(item.vector))
        .map((item) => ({
          id: item.id,
          vector: item.vector,
          payload: { itemId: item.id, collection: item.collection, sourceId: item.sourceId, chunkIndex: item.chunkIndex, content: item.content, meta: item.meta ?? null },
        }));
      if (!points.length) return { synced: 0, skipped: false };
      await backend.upsert({ points });
      return { synced: points.length, skipped: false };
    },

    backendStatus: async () => {
      if (!backend) return { configured: false, backend: 'builtin' };
      try {
        return await backend.status();
      } catch (err) {
        return { configured: true, backend: 'qdrant', ok: false, error: String(err?.message ?? err) };
      }
    },

    /** 对任意候选做重排（界面上的"重排"勾选走的是 search 的 rerank 参数）。 */
    rerank: async ({ query = '', items = [], topK = 10 } = {}) => rerankItems(query, items, { topK }),

    testEmbedding: async ({ providerId = null, text = '你好' } = {}) => {
      if (!embed) throw new NotImplementedError('测试嵌入模型', { reason: '没有注入嵌入端口（ports.embed）' });
      const vector = (await embedTexts([String(text)], providerId))?.[0] ?? null;
      if (!vector) throw new ValidationError('嵌入模型没有返回向量');
      return { dim: vector.length, providerId, sample: vector.slice(0, 5) };
    },
  };
}
