/**
 * 记忆服务：小总结 / 大总结 / 结构化档案三层。
 *
 * 原始消息是唯一事实来源，永远不删；记忆是从它上面滚出来的摘要。
 * 存储走 ports.memoryStore（server/db/memory.mjs），
 * 摘要本身由模型生成，走 ports.summarize（server 里接模型网关），
 * 这样 core 保持纯逻辑、测试里塞个假摘要就能跑。
 *
 * 注入（selectForPrompt）的规则：
 *   - 钉住（pinned）的永远发
 *   - 最近 N 条小总结按时间顺序发（默认 3 条）
 *   - 最新一条大总结发
 *   - 每条都给出"为什么被选中"的 reasons，X 光机能显示、能手动踢
 */

import { emptyList } from '../contracts.mjs';
import { NotImplementedError, ValidationError } from '../errors.mjs';

export const MEMORY_LAYERS = [
  { id: 'small', title: '小总结', summary: '滚动摘要，挂在它覆盖的消息区间上', status: 'ready' },
  { id: 'large', title: '大总结', summary: '总结的总结，保留关系、设定、伏笔', status: 'ready' },
  { id: 'profile', title: '结构化档案', summary: '人物 / 事件 / 物品 / 地点四张表', status: 'ready' },
];

export const PROFILE_KINDS = [
  { id: 'person', title: '人物' },
  { id: 'event', title: '事件' },
  { id: 'item', title: '物品' },
  { id: 'place', title: '地点' },
];

/**
 * 记忆热度（蓝图 1.7「热度还没做」里补上的）：0..1，越大越"该被想起来"。
 * 零依赖、确定性，只从已有字段算，不额外记访问次数：
 *   0.50 时间新鲜度（7 天半衰期） + 0.20 层权重 + 0.15 覆盖区间 + 0.15 钉住
 * 给界面排序用；`selectForPrompt` 的注入规则没变（钉住 + 最近 + 最新大总结），
 * 免得"热度"悄悄改变模型看到的东西。
 */
export function memoryHeat(item = {}, now = new Date()) {
  const stamp = new Date(item.updatedAt ?? item.createdAt ?? 0).getTime();
  const ageDays = Number.isFinite(stamp) && stamp ? Math.max(0, (now.getTime() - stamp) / 86400000) : 365;
  const recency = Math.exp(-ageDays / 7);
  const layerWeight = item.layer === 'large' ? 0.7 : item.layer === 'small' ? 0.95 : 0.55;
  const coverage = item.coversFrom && item.coversTo && item.coversFrom !== item.coversTo ? 1 : item.coversFrom ? 0.7 : 0.4;
  const pinned = item.pinned ? 1 : 0;
  return Number((recency * 0.5 + layerWeight * 0.2 + coverage * 0.15 + pinned * 0.15).toFixed(4));
}

/**
 * 没有注入相关性端口时的兜底打分：查询词命中率 × 覆盖率，再乘一点新鲜度。
 * 零依赖、确定性。中文按字切，所以"书店"能命中"旧书店"。
 */
export function fallbackRank(query, items = []) {
  const tokens = [...new Set(String(query ?? '').toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(Boolean))];
  const chars = [...new Set([...String(query ?? '').toLowerCase()].filter((ch) => /[\u4e00-\u9fff]/.test(ch)))];
  const all = [...tokens, ...chars];
  if (!all.length) return [];
  return items
    .map((item) => {
      const haystack = `${item.title ?? ''}\n${item.content ?? ''}`.toLowerCase();
      let hits = 0;
      for (const token of all) if (haystack.includes(token)) hits += 1;
      const overlap = hits / all.length;
      const score = overlap * (0.85 + 0.15 * memoryHeat(item));
      return { id: item.id, score: Number(score.toFixed(4)), overlap: Number(overlap.toFixed(4)) };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);
}

export function createMemoryService({ settings, ports = {} } = {}) {
  void settings;
  const store = ports.memoryStore ?? null;
  const summarize = typeof ports.summarize === 'function' ? ports.summarize : null;
  /** 相关性排序端口（server 侧接的是向量检索）。没有就用下面的本地关键词打分。 */
  const rank = typeof ports.rank === 'function' ? ports.rank : null;

  function requireStore(what) {
    if (!store) throw new NotImplementedError(what, { reason: '没有注入记忆存储端口（ports.memoryStore）' });
    return store;
  }

  return {
    layers: () => MEMORY_LAYERS,
    profileKinds: () => PROFILE_KINDS,

    list: async (query = {}) => {
      if (!store) return emptyList();
      const result = store.list(query ?? {});
      const items = (result.items ?? []).map((item) => ({ ...item, heat: memoryHeat(item) }));
      if (query?.sort === 'heat') items.sort((a, b) => b.heat - a.heat);
      return { ...result, items };
    },
    get: async (id) => (store ? store.get(id) : null),
    timeline: async (query = {}) => {
      if (!store) return emptyList();
      const result = store.list({ ...(query ?? {}), limit: query?.limit ?? 500 });
      return { ...result, items: (result.items ?? []).map((item) => ({ ...item, heat: memoryHeat(item) })) };
    },
    /** 只取热度，界面画热度条用。 */
    heat: async (query = {}) => {
      if (!store) return emptyList();
      const result = store.list({ ...(query ?? {}), limit: query?.limit ?? 500 });
      return { items: (result.items ?? []).map((item) => ({ id: item.id, layer: item.layer, title: item.title, pinned: item.pinned, heat: memoryHeat(item) })), total: result.items?.length ?? 0 };
    },
    listProfiles: async ({ chatId = null } = {}) => {
      if (!store) return emptyList();
      const { items } = store.list({ chatId, layer: 'profile', limit: 500 });
      return {
        items: items.map((item) => {
          let data = null;
          try { data = JSON.parse(item.content); } catch { data = null; }
          return { ...item, data };
        }),
        total: items.length,
      };
    },

    /**
     * 这轮要注入哪几条记忆。
     *
     * 老版本只有"钉住 + 最近 3 条小总结 + 最新 1 条大总结"—— 跟当前说的话毫无关系，
     * 于是聊到第 80 轮时，和眼前话题最相关的那条旧总结只要不在"最近 3 条"里就永远进不去；
     * 结构化档案写了"按需检索"却没人实现，等于从来没进过提示词。
     *
     * 现在分两段：
     *   基线（保持不变，保证"最近发生了什么"始终在）：钉住 + 最新大总结 + 最近 N 条小总结
     *   补充（新增）：拿当前输入去问一遍相关性，把相关的旧总结 / 结构化档案补进来
     * 相关性打分优先用注入的 ports.rank（server 侧接的是向量检索，能算语义），
     * 没有就退化成内置的关键词重合度 —— core 单独跑也能用。
     */
    selectForPrompt: async ({
      chatId = null,
      characterId = null,
      smallLimit = 3,
      query = '',
      recallTop = 0,
      includeProfile = true,
    } = {}) => {
      if (!store) return { entries: [], reasons: [] };
      const { items } = store.list({ chatId, limit: 500 });
      const reasons = [];
      const chosen = [];
      const chosenIds = new Set();
      const push = (item, why, score = null) => {
        if (chosenIds.has(item.id)) return;
        chosenIds.add(item.id);
        chosen.push(item);
        reasons.push({ id: item.id, layer: item.layer, title: item.title, selected: true, reason: why, score });
      };

      for (const item of items) if (item.pinned) push(item, '你钉住了这条');
      const large = items.filter((item) => item.layer === 'large')[0];
      if (large) push(large, '最新的大总结');
      for (const item of items.filter((entry) => entry.layer === 'small').slice(0, Math.max(0, Number(smallLimit) || 0))) {
        push(item, '最近的小总结');
      }

      // 相关性补充：只从"没被基线选中"的条目里挑。档案默认参与，不参与就排除掉。
      const wanted = Math.max(0, Math.min(10, Number(recallTop) || 0));
      let ranked = [];
      if (wanted && String(query).trim()) {
        const pool = items.filter((item) => !chosenIds.has(item.id) && (includeProfile || item.layer !== 'profile'));
        if (pool.length) {
          try {
            ranked = rank ? await rank({ query: String(query), items: pool }) : fallbackRank(String(query), pool);
          } catch (err) {
            reasons.push({ id: null, layer: null, title: '相关性检索', selected: false, reason: `检索失败，退回基线：${err?.message ?? err}` });
            ranked = [];
          }
        }
      }
      const byId = new Map(items.map((item) => [item.id, item]));
      for (const hit of (Array.isArray(ranked) ? ranked : []).slice(0, wanted)) {
        const item = byId.get(hit.id);
        if (!item) continue;
        const layerName = item.layer === 'profile' ? '结构化档案' : '旧总结';
        push(item, `${layerName}：和当前输入相关（相关度 ${(Number(hit.score) || 0).toFixed(2)}）`, Number(hit.score) || 0);
      }

      for (const item of items) {
        if (chosenIds.has(item.id)) continue;
        const why = item.layer === 'profile'
          ? (includeProfile ? '和当前输入不相关，没带进来' : '结构化档案未开启检索')
          : '不在最近窗口里，也和当前输入不相关';
        reasons.push({ id: item.id, layer: item.layer, title: item.title, selected: false, reason: why });
      }
      chosen.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
      void characterId;
      return { entries: chosen, reasons };
    },

    /**
     * 生成小总结：总结"最老的、还没被总结过的"那一段消息。
     * messages 缺省表示调用方已经把要总结的消息准备好了。
     */
    summarizeSmall: async ({ chatId = null, characterId = null, messages = null, title = '', force = false, content = undefined } = {}) => {
      const memoryStore = requireStore('生成小总结');
      const list = Array.isArray(messages) ? messages : [];
      // 允许手写一条总结（content 直接给），不手写才去调模型
      let text = content;
      if (text === undefined || text === null) {
        if (!summarize) throw new NotImplementedError('生成小总结', { reason: '没有注入摘要端口（ports.summarize）' });
        if (!list.length) throw new ValidationError('没有可总结的消息');
        text = await summarize({ kind: 'small', chatId, characterId, messages: list, title });
      }
      const previous = memoryStore.list({ chatId, layer: 'small', limit: 1 }).items[0] ?? null;
      const coversFrom = list[0]?.id ?? null;
      const coversTo = list[list.length - 1]?.id ?? null;
      const memory = memoryStore.insert({
        chatId, characterId, layer: 'small', title: title || `小总结 ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
        content: String(text ?? '').trim() || '（模型没有返回内容）',
        coversFrom, coversTo,
      });
      return { memory, previous: previous?.id ?? null, covered: list.length, force: Boolean(force) };
    },

    /** 大总结：把小总结再总结一遍。 */
    summarizeLarge: async ({ chatId = null, characterId = null, title = '' } = {}) => {
      const memoryStore = requireStore('生成大总结');
      if (!summarize) throw new NotImplementedError('生成大总结', { reason: '没有注入摘要端口（ports.summarize）' });
      const smalls = memoryStore.list({ chatId, layer: 'small', limit: 50 }).items;
      if (!smalls.length) throw new ValidationError('还没有小总结，先攒一点再来做大总结');
      const content = await summarize({ kind: 'large', chatId, characterId, messages: smalls.map((item) => ({ role: 'assistant', content: `${item.title}：${item.content}` })) });
      return memoryStore.insert({
        chatId, characterId, layer: 'large', title: title || `大总结 ${new Date().toISOString().slice(0, 10)}`,
        content: String(content ?? '').trim() || '（模型没有返回内容）',
      });
    },

    /** 重算：清掉自动生成的小 / 大总结，再按现有消息重做一遍。 */
    rebuild: async ({ chatId = null, characterId = null, batches = 1, messagesPerBatch = 20 } = {}) => {
      const memoryStore = requireStore('重算记忆');
      if (!summarize) throw new NotImplementedError('重算记忆', { reason: '没有注入摘要端口（ports.summarize）' });
      memoryStore.removeAutoForChat(chatId, ['small', 'large']);
      const source = typeof ports.memoryMessages === 'function' ? await ports.memoryMessages(chatId) : [];
      const created = [];
      for (let i = 0; i < Math.max(0, Number(batches)); i++) {
        const slice = source.slice(i * messagesPerBatch, (i + 1) * messagesPerBatch);
        if (!slice.length) break;
        const result = await this.summarizeSmall({ chatId, characterId, messages: slice });
        created.push(result.memory.id);
      }
      return { removed: true, created, available: source.length };
    },

    update: async (id, patch = {}) => requireStore('编辑记忆条目').update(id, patch),
    remove: async (id) => requireStore('删除记忆条目').remove(id),
  };
}
