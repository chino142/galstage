/**
 * 召回与记忆检索的单元测试（零依赖，直接跑 core）。
 *
 * 覆盖这一轮新增的：
 *   · 多查询融合 / 最低分门槛 / 时间衰减 / MMR 去重（core/vectors）
 *   · 记忆"基线 + 相关性补充"，结构化档案终于能进提示词（core/memory）
 *   · 每轮召回的查询怎么拼（core/chat 的 buildRecallQueries）
 *   · 外部向量库（Qdrant）当候选生成器 + 出错回退内置
 */

import assert from 'node:assert/strict';
import http from 'node:http';

import { createVectorService, chunkText, jaccard, mmrSelect, recencyFactor } from '../core/vectors/service.mjs';
import { createMemoryService, fallbackRank } from '../core/memory/service.mjs';
import { buildRecallQueries } from '../core/chat/service.mjs';
import { createQdrantBackend, pointIdOf } from '../server/vectors/qdrant.mjs';

const silent = { info() {}, warn() {}, error() {}, debug() {} };

/** 内存版向量存储：形状跟 server/db/vectors.mjs 一致，省得为了测试起数据库。 */
function makeStore(items = []) {
  let rows = items.map((item, index) => ({
    id: item.id ?? `vec_${index}`,
    collection: item.collection,
    sourceId: item.sourceId,
    chunkIndex: item.chunkIndex ?? 0,
    content: item.content,
    vector: item.vector ?? null,
    meta: item.meta ?? null,
    updatedAt: item.updatedAt ?? new Date().toISOString(),
  }));
  return {
    list: ({ collection = null, limit = 50000 } = {}) =>
      (collection ? rows.filter((row) => row.collection === collection) : rows).slice(0, limit),
    total: () => rows.length,
    getMany: (ids) => rows.filter((row) => ids.includes(row.id)),
    stats: () => ({ byCollection: {}, total: rows.length, pending: 0 }),
    getBySource: () => [],
    upsert: (input) => { const row = { id: `vec_new_${rows.length}`, ...input, updatedAt: new Date().toISOString() }; rows.push(row); return row; },
    touchMeta: () => {},
    deleteBySource: () => 0,
    removeAll: () => { rows = []; return true; },
  };
}

/** 极简嵌入：按"包含哪些字符"造一个稳定的小向量，够算出有意义的余弦。 */
function fakeEmbed(texts) {
  const dims = ['猫', '狗', '书店', '剑', '雨', '海', '车', '花', '龙', '酒'];
  return texts.map((text) => dims.map((dim) => (String(text).includes(dim) ? 1 : 0)));
}

export async function run() {
  // ── chunkText 没被改坏 ────────────────────────────────────────────
  assert.ok(chunkText('a'.repeat(1000), { size: 400, overlap: 40 }).length >= 3);
  assert.deepEqual(chunkText(''), []);

  // ── jaccard / recencyFactor ───────────────────────────────────────
  assert.equal(jaccard(new Set(['a', 'b']), new Set(['a', 'b'])), 1);
  assert.equal(jaccard(new Set(['a']), new Set(['b'])), 0);
  assert.ok(Math.abs(recencyFactor(new Date().toISOString()) - 1) < 0.01);
  assert.ok(Math.abs(recencyFactor(new Date(Date.now() - 7 * 86400000).toISOString()) - 0.5) < 0.02);
  assert.equal(recencyFactor(null), 1, '没有时间戳不该打折');

  // ── MMR：同样的分数，重复内容被压下去 ───────────────────────────
  const mmr = mmrSelect(
    [
      { content: '书店 老板 说 话', score: 1 },
      { content: '书店 老板 说 话', score: 0.99 },
      { content: '海边 的 灯塔 很 高', score: 0.8 },
    ],
    { topK: 2, lambda: 0.5 },
  );
  assert.equal(mmr.length, 2);
  assert.ok(mmr.some((item) => item.content.includes('灯塔')), '第二段要选不重复的，而不是两条一样的话');

  // ── 多查询融合 + 门槛 + 衰减 ─────────────────────────────────────
  const store = makeStore([
    { id: 'vec_cat', collection: 'databank', sourceId: 'doc-cat', content: '一只猫趴在窗台上晒太阳。', vector: fakeEmbed(['一只猫趴在窗台上晒太阳。'])[0], meta: { title: '猫' } },
    { collection: 'databank', sourceId: 'doc-sword', content: '墙上的剑落满了灰。', vector: fakeEmbed(['墙上的剑落满了灰。'])[0], meta: { title: '剑' } },
    { collection: 'history', sourceId: 'msg-old', content: '我们上个月聊过雨天和猫。', vector: fakeEmbed(['我们上个月聊过雨天和猫。'])[0], updatedAt: new Date(Date.now() - 60 * 86400000).toISOString() },
  ]);
  const vectors = createVectorService({ settings: {}, ports: { vectorStore: store, embed: async (texts) => fakeEmbed(texts), logger: silent } });

  const multi = await vectors.search({ queries: ['猫', '书店'], topK: 5, keywordWeight: 0.3 });
  assert.equal(multi[0].sourceId, 'doc-cat', '多查询里只要有一条命中就该被召上来');

  const filtered = await vectors.search({ query: '猫', topK: 5, minScore: 0.9, keywordWeight: 0.3 });
  assert.ok(filtered.every((item) => item.score >= 0.9), '低于门槛的不要');

  const decayed = await vectors.search({ query: '猫', collections: ['history'], topK: 5, keywordWeight: 0.3, decay: true });
  if (decayed.length) assert.ok(decayed[0].recency < 0.05, '60 天前的历史要被衰减得很低');
  const noDecay = await vectors.search({ query: '猫', collections: ['history'], topK: 5, keywordWeight: 0.3, decay: false });
  if (noDecay.length && decayed.length) assert.ok(noDecay[0].score > decayed[0].score, '关掉衰减分数应该更高');

  // ── recall：按字数截断 + 理由 ────────────────────────────────────
  const recalled = await vectors.recall({ queries: ['猫'], topK: 5, maxChars: 10, minScore: 0 });
  assert.ok(recalled.entries.length >= 1);
  assert.ok(recalled.entries.every((entry) => entry.reason), '每段都要能说清为什么给它');
  assert.ok(recalled.stats.scanned >= 1);

  // ── 记忆：基线 + 相关性补充（结构化档案终于进得来）──────────────
  const memoryStore = {
    list: () => ({
      items: [
        { id: 'm1', layer: 'small', title: '最近', content: '刚刚在书店买书。', pinned: false, createdAt: '2026-01-03', updatedAt: '2026-01-03' },
        { id: 'm2', layer: 'small', title: '很久以前', content: '主角养了一只叫雪球的猫。', pinned: false, createdAt: '2026-01-01', updatedAt: '2026-01-01' },
        { id: 'm3', layer: 'profile', title: '人物表', content: '雪球：主角的猫，怕生。', pinned: false, createdAt: '2026-01-01', updatedAt: '2026-01-01' },
        { id: 'm4', layer: 'large', title: '大总结', content: '整体档案。', pinned: false, createdAt: '2026-01-04', updatedAt: '2026-01-04' },
      ],
    }),
  };
  const memory = createMemoryService({ settings: {}, ports: { memoryStore, logger: silent } });

  const baseline = await memory.selectForPrompt({ chatId: 'c1', smallLimit: 1 });
  assert.deepEqual(
    baseline.entries.map((item) => item.id).sort(),
    ['m1', 'm4'],
    '基线：最新大总结 + 最近 1 条小总结（注入前按时间排序）',
  );

  const withRecall = await memory.selectForPrompt({ chatId: 'c1', smallLimit: 1, query: '雪球 猫 怎么样了', recallTop: 2 });
  const ids = withRecall.entries.map((item) => item.id);
  assert.ok(ids.includes('m2') || ids.includes('m3'), '和"猫"相关的旧总结 / 档案应该被补进来');
  assert.ok(withRecall.reasons.some((reason) => reason.selected && /相关/.test(reason.reason)));
  // 每条记忆都要在 reasons 里有交代（选中的写为什么选，没选的写为什么没选）——
  // X 光机就是靠这个显示"这轮带了哪些、为什么"。
  assert.equal(withRecall.reasons.length, 4, '每条记忆都要有交代');
  assert.ok(withRecall.reasons.every((reason) => reason.reason), '理由不能是空字符串');

  const noProfile = await memory.selectForPrompt({ chatId: 'c1', smallLimit: 1, query: '雪球 猫', recallTop: 2, includeProfile: false });
  assert.ok(!noProfile.entries.some((item) => item.layer === 'profile'), '关掉档案参与后不能带 profile');

  // 关键词兜底打分
  assert.ok(fallbackRank('猫', [{ id: 'x', title: '', content: '一只猫' }]).length === 1);
  assert.deepEqual(fallbackRank('', [{ id: 'x', content: '一只猫' }]), []);

  // ── 查询怎么拼 ───────────────────────────────────────────────────
  const queries = buildRecallQueries({
    text: '它现在在哪？',
    history: [
      { role: 'user', content: '我去书店了' },
      { role: 'assistant', content: '书店老板抬头看你' },
      { role: 'user', content: '我买了本书' },
    ],
    window: 2,
  });
  assert.equal(queries.length, 2);
  assert.equal(queries[0], '它现在在哪？');
  assert.ok(queries[1].includes('书店老板') && !queries[1].includes('我去书店了'), '只取最近 window 条');
  assert.deepEqual(buildRecallQueries({ text: '', history: [], window: 4 }), []);

  // ── 外部向量库：当候选生成器用 ───────────────────────────────────
  assert.match(pointIdOf('vec_abc'), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(pointIdOf('vec_abc'), pointIdOf('vec_abc'), '同一个 id 必须得到同一个 UUID');
  assert.notEqual(pointIdOf('vec_abc'), pointIdOf('vec_abd'));

  const hits = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
      res.setHeader('content-type', 'application/json');
      if (req.url.includes('/points/search')) {
        res.end(JSON.stringify({ result: [{ id: pointIdOf('vec_cat'), score: 0.91, payload: { itemId: 'vec_cat', collection: 'databank' } }] }));
        return;
      }
      if (req.url.includes('/points')) { hits.push(body); res.end(JSON.stringify({ result: { status: 'completed' } })); return; }
      res.end(JSON.stringify({ result: { points_count: 1, config: { params: { vectors: { size: 10 } } } } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const backend = createQdrantBackend({ url: `http://127.0.0.1:${port}`, logger: silent });
    await backend.upsert({ points: [{ id: 'vec_cat', vector: [1, 0], payload: { itemId: 'vec_cat' } }] });
    assert.ok(hits.length >= 1, 'upsert 应该真的发了请求');
    const found = await backend.search({ vectors: [[1, 0]], topK: 3 });
    assert.equal(found[0].id, 'vec_cat', 'search 要把 payload.itemId 还原成内部 id');
    assert.ok(await backend.status());

    // 接进向量服务：候选由外部库给，最终打分仍走本地同一套公式
    const bridged = createVectorService({
      settings: {},
      ports: { vectorStore: store, embed: async (texts) => fakeEmbed(texts), vectorBackend: backend, logger: silent },
    });
    const viaBackend = await bridged.search({ query: '猫', topK: 3, keywordWeight: 0.3 });
    assert.ok(viaBackend.length >= 1);
    assert.equal(viaBackend[0].backend, 'qdrant', '命中时应该标明走的是外部库');
    assert.equal(viaBackend[0].sourceId, 'doc-cat', '回表取到的应该是本地那条');

    // 外部库挂了 → 自动回退内置，不能把整轮对话带崩
    const broken = createQdrantBackend({ url: 'http://127.0.0.1:1', timeoutMs: 300, logger: silent });
    const fallback = createVectorService({
      settings: {},
      ports: { vectorStore: store, embed: async (texts) => fakeEmbed(texts), vectorBackend: broken, logger: silent },
    });
    const stillWorks = await fallback.search({ query: '猫', topK: 3, keywordWeight: 0.3 });
    assert.ok(stillWorks.length >= 1, '外部库连不上也要能出结果');
    assert.equal(stillWorks[0].backend, 'builtin');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
