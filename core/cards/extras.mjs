/**
 * 角色卡的加分项（蓝图 1.10）：剧本大纲、卡内 BGM / 音效清单、角色关系图、一致性锁定。
 *
 * 存储：全部挂在卡数据的 `data.extensions['silver-tavern']` 上 —— 属于"未知字段"，
 * 导出 PNG / JSON 时原样带走，不加表、不加迁移。
 */

export const EXTRAS_KEY = 'silver-tavern';

/** 允许"钉死"的卡字段（改稿时不许动的那些）。 */
export const LOCKABLE_FIELDS = [
  { id: 'name', title: '名字' },
  { id: 'description', title: '简介' },
  { id: 'personality', title: '性格' },
  { id: 'scenario', title: '场景' },
  { id: 'first_mes', title: '开场白' },
  { id: 'mes_example', title: '示例对话' },
  { id: 'system_prompt', title: '系统提示' },
  { id: 'post_history_instructions', title: '后置指令' },
  { id: 'creator_notes', title: '作者注' },
  { id: 'tags', title: '标签' },
];

const LOCKABLE = new Set(LOCKABLE_FIELDS.map((item) => item.id));

function text(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function assetId(value) {
  const id = typeof value === 'string' ? value : value?.assetId ?? '';
  return /^[A-Za-z0-9_.-]{1,80}$/.test(id) ? id : '';
}

/** 代码要保留换行，所以不能走 `text()`（那个会把空白压成空格）。 */
function code(value, max) {
  return String(value ?? '').replace(/\r\n/g, '\n').slice(0, max);
}

const FRONTEND_LIMITS = { html: 64 * 1024, css: 32 * 1024, js: 64 * 1024 };

/**
 * 卡内前端（HTML / CSS / JS + 声明的能力）。存在卡数据里，所以导出 PNG / JSON 会一起带走 ——
 * 别人拿到卡就有了这张卡的界面代码（这正是"卡带着自己的界面走"的意思）。
 *
 * 能力清单这里只做"字符串去重 + 限量"，认不认识交给 core/frontend 在渲染时过滤；
 * 这样 core/cards 不用反过来依赖 core/frontend。
 */
export function normaliseFrontend(raw = {}) {
  const seen = new Set();
  const capabilities = [];
  for (const item of Array.isArray(raw?.capabilities) ? raw.capabilities : []) {
    const id = String(item ?? '').trim().slice(0, 60);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    capabilities.push(id);
    if (capabilities.length >= 16) break;
  }
  return {
    html: code(raw?.html, FRONTEND_LIMITS.html),
    css: code(raw?.css, FRONTEND_LIMITS.css),
    js: code(raw?.js, FRONTEND_LIMITS.js),
    capabilities,
    // 卡自己的背景（导入平台作品时搬过来的横幅）。只收我方素材库的地址 ——
    // 这个值最后会被拼进沙箱的 <style> 里，不能什么字符串都放行。
    background: /^\/api\/assets\/[A-Za-z0-9_-]+\/file$/.test(String(raw?.background ?? '').trim())
      ? String(raw.background).trim()
      : '',
  };
}

/** 这张卡有没有界面代码（全空 = 没有）。 */
export function hasFrontend(frontend = {}) {
  return Boolean(String(frontend?.html ?? '').trim() || String(frontend?.css ?? '').trim() || String(frontend?.js ?? '').trim());
}

export function normaliseOutline(raw = {}) {
  return {
    logline: text(raw?.logline, 400),
    chapters: (Array.isArray(raw?.chapters) ? raw.chapters : [])
      .map((chapter, index) => ({ title: text(chapter?.title, 60) || `第 ${index + 1} 章`, summary: text(chapter?.summary, 300) }))
      .filter((chapter) => chapter.title || chapter.summary)
      .slice(0, 40),
  };
}

export function normaliseAudio(raw = {}) {
  return {
    bgm: (Array.isArray(raw?.bgm) ? raw.bgm : []).map(assetId).filter(Boolean).slice(0, 20),
    sfx: (Array.isArray(raw?.sfx) ? raw.sfx : [])
      .map((item) => ({ assetId: assetId(item), label: text(item?.label, 40) || '音效' }))
      .filter((item) => item.assetId)
      .slice(0, 40),
  };
}

export function normaliseRelations(raw) {
  return (Array.isArray(raw) ? raw : [])
    .map((relation) => ({
      from: text(relation?.from, 40),
      to: text(relation?.to, 40),
      label: text(relation?.label, 60),
      kind: text(relation?.kind, 20) || 'other',
    }))
    .filter((relation) => relation.from && relation.to)
    .slice(0, 100);
}

export function normaliseLocks(raw) {
  return (Array.isArray(raw) ? raw : []).map(String).filter((id) => LOCKABLE.has(id)).slice(0, LOCKABLE_FIELDS.length);
}

/** 平台卡搬迁时搬过来的平台专属字段（bgm / 推荐问题 / 默认消息数）。只做限量与去空，原样保留。 */
export function normalisePlatform(raw = {}) {
  const tracks = (Array.isArray(raw?.bgm?.tracks) ? raw.bgm.tracks : [])
    .map((track) => {
      if (track === null || typeof track !== 'object') return null;
      const out = {};
      for (const key of ['name', 'url', 'id', 'title', 'src']) {
        const value = track[key];
        if (typeof value === 'string' && value) out[key] = value.slice(0, 2000);
      }
      return Object.keys(out).length ? out : null;
    })
    .filter(Boolean)
    .slice(0, 40);
  const suggested = (Array.isArray(raw?.suggestedQuestions) ? raw.suggestedQuestions : [])
    .map((item) => text(item, 300))
    .filter(Boolean)
    .slice(0, 40);
  const defMsgCount = Number(raw?.defMsgCount);
  return {
    bgm: { tracks, autoplay: Boolean(raw?.bgm?.autoplay) },
    suggestedQuestions: suggested,
    defMsgCount: Number.isFinite(defMsgCount) ? defMsgCount : 0,
  };
}

export function normaliseExtras(raw = {}) {
  return {
    outline: normaliseOutline(raw?.outline),
    audio: normaliseAudio(raw?.audio),
    relations: normaliseRelations(raw?.relations),
    locks: normaliseLocks(raw?.locks),
    frontend: normaliseFrontend(raw?.frontend),
    platform: normalisePlatform(raw?.platform),
  };
}

/** 只合并传进来的字段。 */
export function mergeExtras(current, patch = {}) {
  const base = normaliseExtras(current);
  if (!patch || typeof patch !== 'object') return base;
  const next = { ...base };
  if (patch.outline !== undefined) next.outline = normaliseOutline(patch.outline);
  if (patch.audio !== undefined) next.audio = normaliseAudio(patch.audio);
  if (patch.relations !== undefined) next.relations = normaliseRelations(patch.relations);
  if (patch.locks !== undefined) next.locks = normaliseLocks(patch.locks);
  if (patch.frontend !== undefined) next.frontend = normaliseFrontend(patch.frontend);
  if (patch.platform !== undefined) next.platform = normalisePlatform(patch.platform);
  return next;
}

/** 从卡数据里取 extras（老卡没有就是空）。 */
export function extrasOf(cardData = {}) {
  return normaliseExtras(cardData?.extensions?.[EXTRAS_KEY]);
}

/** 把 extras 写回卡数据副本（保留其它扩展字段）。 */
export function withExtras(cardData = {}, extras = {}) {
  const extensions = { ...(cardData?.extensions ?? {}) };
  extensions[EXTRAS_KEY] = normaliseExtras(extras);
  return { ...cardData, extensions };
}

/**
 * 一致性锁定：这次修改**改变了**哪些被钉死的字段。
 * 只看"值有没有变"，所以把整份数据原样发回来（界面保存就是这么做的）不算违反。
 * @returns {string[]} 违反的字段名（空数组 = 没动）
 */
export function checkLocks(extras, patch = {}, existingData = {}) {
  const locks = normaliseLocks(extras?.locks);
  if (!locks.length) return [];
  const incoming = {};
  const has = (field) => {
    if (patch?.data && typeof patch.data === 'object' && field in patch.data) return true;
    if (patch?.card?.data && typeof patch.card.data === 'object' && field in patch.card.data) return true;
    return patch?.[field] !== undefined;
  };
  const read = (field) => {
    if (patch?.data && typeof patch.data === 'object' && field in patch.data) return patch.data[field];
    if (patch?.card?.data && typeof patch.card.data === 'object' && field in patch.card.data) return patch.card.data[field];
    return patch?.[field];
  };
  for (const field of locks) {
    if (!has(field)) continue;
    incoming[field] = read(field);
  }
  const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  return locks.filter((field) => field in incoming && !same(incoming[field], existingData?.[field]));
}

/**
 * 关系图：把关系列表变成"节点 + 边"，前端照着画。
 * 只做去重与索引，布局（圆环 / 力导向）交给前端。
 */
export function relationsGraph(relations = []) {
  const list = normaliseRelations(relations);
  const names = [];
  const index = new Map();
  const ensure = (name) => {
    if (!name) return -1;
    if (!index.has(name)) {
      index.set(name, names.length);
      names.push(name);
    }
    return index.get(name);
  };
  const edges = list.map((relation) => ({ from: ensure(relation.from), to: ensure(relation.to), label: relation.label, kind: relation.kind }));
  return {
    nodes: names.map((name, i) => ({ id: i, name })),
    edges,
    total: { nodes: names.length, edges: edges.length },
  };
}
