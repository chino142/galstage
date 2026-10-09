/**
 * 演出层的加分项（蓝图 2.5）纯逻辑：转场、BGM / 音效、CG 回廊、好感度与路线 / 多结局。
 *
 * 和 `core/staging/service.mjs` 一个路子：这里不碰 HTTP、不碰文件、不读设置——
 * 只把"一条对话 + 出图记录 + 世界状态"算成"该演什么"。播放声音、套 CSS 动画、
 * 写回聊天设置都在前端 / 路由侧。
 *
 * 存储：这些都挂在 `chat.settings.show` 这一个 JSON 上（`chats.settings` 已有），
 * 所以不加表、不加迁移。
 */

// ------------------------------------------------------------------ 转场

export const TRANSITIONS = [
  { id: 'none', title: '不转场', summary: '直接切。' },
  { id: 'fade-black', title: '黑屏淡入', summary: '先压黑再亮起来，换场景最常用。' },
  { id: 'flash-white', title: '闪白', summary: '白光一闪，适合突然事件。' },
  { id: 'shake', title: '震动', summary: '画面抖一下，适合受击 / 惊吓。' },
  { id: 'pan-left', title: '镜头左移', summary: '背景横向平移。' },
  { id: 'pan-right', title: '镜头右移', summary: '背景反向平移。' },
];

export function getTransition(id) {
  return TRANSITIONS.find((item) => item.id === id) ?? TRANSITIONS[1];
}

const DEFAULT_TRANSITION = { effect: 'fade-black', durationMs: 700, onSceneChange: true };

function clampNumber(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, num));
}

export function normaliseTransition(raw = {}) {
  return {
    effect: TRANSITIONS.some((item) => item.id === raw.effect) ? raw.effect : DEFAULT_TRANSITION.effect,
    durationMs: Math.round(clampNumber(raw.durationMs, 200, 3000, DEFAULT_TRANSITION.durationMs)),
    onSceneChange: raw.onSceneChange !== false,
  };
}

/**
 * 该放哪个转场。
 *   trigger='auto'   —— 地点 / 时间变了才放；第一次加载（没有 previous）不放。
 *   trigger='manual' —— 手动点，按配置直接放（配置是 none 就什么都不放）。
 */
export function planTransition({ previousScene = null, scene = null, transition = {}, trigger = 'auto' } = {}) {
  const conf = normaliseTransition(transition);
  const effect = conf.effect;
  if (effect === 'none') return { effect: 'none', durationMs: 0, reason: '配置为不转场' };
  if (trigger === 'manual') return { effect, durationMs: conf.durationMs, reason: '手动播放' };
  if (!conf.onSceneChange) return { effect: 'none', durationMs: 0, reason: '没有开启"场景变化时转场"' };
  if (!previousScene) return { effect: 'none', durationMs: 0, reason: '第一次进入，不需要转场' };
  const changed = ['place', 'time'].filter((key) => String(previousScene[key] ?? '') !== String(scene?.[key] ?? ''));
  if (!changed.length) return { effect: 'none', durationMs: 0, reason: '场景没变化' };
  return { effect, durationMs: conf.durationMs, reason: `场景变化：${changed.join(' / ')}` };
}

// ------------------------------------------------------------------ BGM / 音效

const ASSET_ID_RE = /^[A-Za-z0-9_.-]{1,80}$/;

function assetIdOrNull(value) {
  return typeof value === 'string' && ASSET_ID_RE.test(value) ? value : null;
}

export function clampVolume(value, fallback = 0.6) {
  return clampNumber(value, 0, 1, fallback);
}

export const AUDIO_CHANNELS = [
  { id: 'bgm', title: 'BGM', summary: '循环播放的背景音乐；可以按地点自动切。' },
  { id: 'sfx', title: '音效', summary: '点一下放一声（开门 / 脚步 / 铃声……）。' },
];

export function normaliseAudio(raw = {}) {
  const bgmByPlace = {};
  for (const [place, assetId] of Object.entries(raw.bgmByPlace ?? {})) {
    const key = String(place ?? '').trim();
    const id = assetIdOrNull(assetId);
    if (key && id) bgmByPlace[key.slice(0, 60)] = id;
  }
  const sfx = (Array.isArray(raw.sfx) ? raw.sfx : [])
    .map((item) => ({ assetId: assetIdOrNull(item?.assetId), label: String(item?.label ?? '').slice(0, 40) }))
    .filter((item) => item.assetId)
    .slice(0, 24);
  return {
    volume: clampVolume(raw.volume),
    muted: Boolean(raw.muted),
    bgm: assetIdOrNull(raw.bgm),
    bgmByPlace,
    sfx,
  };
}

/** 当前场景该放哪首 BGM：精确地点 > `*` 默认 > 全局默认 > 不放。 */
export function pickBgm({ audio = {}, scene = {} } = {}) {
  const conf = normaliseAudio(audio);
  const place = String(scene?.place ?? '').trim();
  if (place && conf.bgmByPlace[place]) return { assetId: conf.bgmByPlace[place], reason: `地点「${place}」` };
  if (conf.bgmByPlace['*']) return { assetId: conf.bgmByPlace['*'], reason: '默认地点音乐' };
  if (conf.bgm) return { assetId: conf.bgm, reason: '默认 BGM' };
  return { assetId: null, reason: '还没有配置 BGM' };
}

// ------------------------------------------------------------------ CG 回廊

/**
 * 把出过的图收进相册：背景 / 立绘 / 表情 / CG，按内容去重、按时间倒序。
 * 只认 done 且有图的 run（出图记录本来就带 kind 与 workflowName）。
 */
export function buildGallery({ runs = [], messages = [], limit = 200 } = {}) {
  const max = Math.max(1, Number(limit) || 200);
  const messageById = new Map((messages ?? []).map((message) => [message.id, message]));
  const items = [];
  const seen = new Set();
  for (const run of runs ?? []) {
    if (run?.status !== 'done' || !Array.isArray(run.images)) continue;
    const owner = run.messageId ? messageById.get(run.messageId) ?? null : null;
    for (const image of run.images) {
      const assetId = assetIdOrNull(image?.assetId);
      if (!assetId || seen.has(assetId)) continue;
      seen.add(assetId);
      items.push({
        assetId,
        runId: run.id ?? null,
        kind: run.kind ?? 'custom',
        workflowName: run.workflowName ?? null,
        messageId: run.messageId ?? null,
        name: owner?.name || run.workflowName || '图',
        emotion: run.values?.emotion ?? owner?.extra?.stateDelta?.emotion ?? null,
        createdAt: run.createdAt ?? null,
      });
      if (items.length >= max) break;
    }
    if (items.length >= max) break;
  }
  const counts = {};
  for (const item of items) counts[item.kind] = (counts[item.kind] ?? 0) + 1;
  return { items, total: items.length, counts };
}

// ------------------------------------------------------------------ 好感度与路线

export const ROUTE_KINDS = [
  { id: 'friend', title: '友情线', summary: '关系升温的第一档。' },
  { id: 'lover', title: '恋人线', summary: '越过这条线就是另一条剧情走向。' },
  { id: 'true', title: '真结局', summary: '最高档，通常要一路不踩雷。' },
  { id: 'bad', title: '坏结局', summary: '条件反转时触发。' },
];

/** 没有自定义时就给三条模板路线，界面里能直接改阈值 / 结局文案。 */
export const DEFAULT_ROUTES = [
  { id: 'route-friend', title: '挚友线', target: '', threshold: 30, ending: '你们成了并肩的挚友，故事还会继续。' },
  { id: 'route-lover', title: '恋人线', target: '', threshold: 60, ending: '雪停的时候，她牵住了你的手。' },
  { id: 'route-true', title: '真结局', target: '', threshold: 90, ending: '旧书馆的灯亮了整夜——这一次谁也没有走。' },
];

export function normaliseRoutes(raw) {
  const source = Array.isArray(raw) ? raw : DEFAULT_ROUTES;
  return source
    .map((route, index) => ({
      id: String(route?.id ?? `route-${index + 1}`).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || `route-${index + 1}`,
      title: String(route?.title ?? `路线 ${index + 1}`).slice(0, 40),
      target: String(route?.target ?? '').slice(0, 40),
      threshold: Math.round(clampNumber(route?.threshold, -10000, 10000, 50)),
      ending: String(route?.ending ?? '').slice(0, 500),
      // 进了某条线，别的线就锁上 —— 真 gal 的路线锁定
      locked: route?.locked === true,
      lockedBy: String(route?.lockedBy ?? '').slice(0, 40),
    }))
    .filter((route) => route.id && route.title)
    .slice(0, 20);
}

/**
 * 进入一条路线：它自己解锁，别的线锁上（谁锁的说得清）。
 * 名字对不上就原样返回 —— 剧本里写了不存在的线，界面上会如实提示。
 */
export function enterRoute(routes, name) {
  const list = normaliseRoutes(routes);
  const key = String(name ?? '').trim();
  if (!key) return list;
  const hit = list.find((route) => route.id === key || route.title === key) ?? null;
  if (!hit) return list;
  return list.map((route) =>
    route.id === hit.id
      ? { ...route, locked: false, lockedBy: '' }
      : { ...route, locked: true, lockedBy: hit.title },
  );
}

/** 手动把一条线放出来（比如想回去看别的线）。 */
export function unlockRoute(routes, id) {
  const key = String(id ?? '').trim();
  return normaliseRoutes(routes).map((route) => (route.id === key ? { ...route, locked: false, lockedBy: '' } : route));
}

function affectionValue(worldState = {}, target = '') {
  const affection = worldState?.affection && typeof worldState.affection === 'object' ? worldState.affection : {};
  if (target) {
    const value = affection[target];
    return Number.isFinite(Number(value)) ? Number(value) : 0;
  }
  const values = Object.values(affection).map((value) => Number(value)).filter((value) => Number.isFinite(value));
  return values.length ? Math.max(...values) : 0;
}

export function normaliseEndings(raw) {
  return (Array.isArray(raw) ? raw : [])
    .map((item) => ({
      routeId: String(item?.routeId ?? '').slice(0, 40),
      title: String(item?.title ?? '').slice(0, 40),
      ending: String(item?.ending ?? '').slice(0, 500),
      at: item?.at ?? null,
    }))
    .filter((item) => item.routeId)
    .slice(-50);
}

/**
 * 当前好感度 → 哪些路线解锁、哪条已经走到结局。
 * 好感度取 `worldState.affection`：路线指定了 target 就只看那个角色，否则取最高的一条。
 */
export function evaluateRoutes({ routes = DEFAULT_ROUTES, worldState = {}, endings = [] } = {}) {
  const list = normaliseRoutes(routes);
  const recorded = normaliseEndings(endings);
  const byRoute = new Map(recorded.map((item) => [item.routeId, item]));
  const items = list.map((route) => {
    const current = affectionValue(worldState, route.target);
    const reached = byRoute.get(route.id) ?? null;
    return {
      ...route,
      current,
      thresholdMet: current >= route.threshold,
      unlocked: !route.locked && current >= route.threshold,
      reached: Boolean(reached),
      reachedAt: reached?.at ?? null,
      ending: route.ending || reached?.ending || '',
    };
  });
  return {
    affection: { max: affectionValue(worldState), byCharacter: { ...(worldState?.affection ?? {}) } },
    items,
    unlocked: items.filter((item) => item.unlocked).map((item) => item.id),
    entered: items.find((item) => !item.locked && item.lockedBy === '' && list.some((other) => other.lockedBy === item.title))?.id ?? null,
    endings: items.filter((item) => item.reached).map((item) => ({ routeId: item.id, title: item.title, ending: item.ending, at: item.reachedAt })),
  };
}

/** 记录一个已触发的结局（同一个路线只留最新一条）。 */
export function recordEnding(list, entry, at = null) {
  const cleaned = normaliseEndings(list).filter((item) => item.routeId !== entry?.routeId);
  cleaned.push({ routeId: entry?.routeId ?? '', title: entry?.title ?? '', ending: entry?.ending ?? '', at: at ?? new Date().toISOString() });
  return normaliseEndings(cleaned);
}

// ------------------------------------------------------------------ 合并 / 默认

// ------------------------------------------------ 播放手感 / 名单 / 解锁 / 存档
//
// 这几样都是"演出这台机器自己的设置"，和转场 / BGM / 路线一样挂在
// `chat.settings.show` 上：不进表、不加迁移。

const CAST_KINDS = ['backgrounds', 'portraits', 'cg', 'bgm', 'sfx'];

/** 名字 → 素材：背景 / 立绘（角色@表情）/ CG / BGM / 音效，一张名字表管全部。 */
export function normaliseCast(raw = {}) {
  const out = {};
  for (const kind of CAST_KINDS) {
    const table = raw?.[kind] && typeof raw[kind] === 'object' ? raw[kind] : {};
    const clean = {};
    for (const [name, assetId] of Object.entries(table)) {
      const label = String(name ?? '').trim().slice(0, 60);
      const id = assetIdOrNull(assetId);
      if (label && id) clean[label] = id;
      else if (label && assetId === null) clean[label] = null;
    }
    out[kind] = clean;
  }
  return out;
}

export const DEFAULT_PLAYBACK = {
  textSpeed: 28, // 每个字的毫秒数；0 = 瞬间显示
  autoDelay: 1600, // 自动播放时一句话停多久
  skipUnread: false, // 跳过时是否连没看过的也跳
  skipAfterChoices: false,
  hideAfterRead: false,
};

export function normalisePlayback(raw = {}) {
  return {
    textSpeed: Math.round(clampNumber(raw.textSpeed, 0, 200, DEFAULT_PLAYBACK.textSpeed)),
    autoDelay: Math.round(clampNumber(raw.autoDelay, 300, 8000, DEFAULT_PLAYBACK.autoDelay)),
    skipUnread: raw.skipUnread === true,
    skipAfterChoices: raw.skipAfterChoices === true,
    hideAfterRead: raw.hideAfterRead === true,
  };
}

/** CG 长廊的解锁记录：播到那条 `[CG: …]` 才写一条进来。 */
export function normaliseUnlocks(raw) {
  return (Array.isArray(raw) ? raw : [])
    .map((item) => ({
      name: String(item?.name ?? '').trim().slice(0, 60),
      messageId: item?.messageId ? String(item.messageId) : null,
      at: item?.at ?? null,
    }))
    .filter((item) => item.name)
    .slice(-500);
}

/** 解锁一张 CG：幂等（同一张只留一条，保留最早解锁的时间）。 */
export function unlockCg(list, entry, at = null) {
  const name = String(entry?.name ?? '').trim().slice(0, 60);
  const current = normaliseUnlocks(list);
  if (!name) return current;
  if (current.some((item) => item.name === name)) return current;
  return normaliseUnlocks([
    ...current,
    { name, messageId: entry?.messageId ?? null, at: at ?? new Date().toISOString() },
  ]);
}

export function isUnlocked(list, name) {
  const key = String(name ?? '').trim();
  if (!key) return false;
  return normaliseUnlocks(list).some((item) => item.name === key);
}

/** 存档槽：槽号 + 演到第几句 + 当时的台词 / 场景 / 背景图（当缩略图用）。 */
export function normaliseSaves(raw) {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const slot = Math.round(Number(item?.slot));
    if (!Number.isFinite(slot) || slot < 1 || slot > 99 || seen.has(slot)) continue;
    seen.add(slot);
    out.push({
      slot,
      label: String(item?.label ?? '').slice(0, 60),
      lineIndex: Math.max(0, Math.round(clampNumber(item?.lineIndex, 0, 1000000, 0))),
      messageId: item?.messageId ? String(item.messageId) : null,
      name: String(item?.name ?? '').slice(0, 60),
      text: String(item?.text ?? '').slice(0, 300),
      scene: String(item?.scene ?? '').slice(0, 60),
      shotAssetId: assetIdOrNull(item?.shotAssetId),
      at: item?.at ?? null,
    });
  }
  return out.sort((a, b) => a.slot - b.slot).slice(0, 99);
}

/** 写一个存档槽（同槽覆盖）。 */
export function writeSave(list, entry, at = null) {
  const slot = Math.round(Number(entry?.slot));
  if (!Number.isFinite(slot) || slot < 1 || slot > 99) return normaliseSaves(list);
  const rest = normaliseSaves(list).filter((item) => item.slot !== slot);
  return normaliseSaves([
    ...rest,
    { ...entry, slot, at: at ?? new Date().toISOString() },
  ]);
}

export function dropSave(list, slot) {
  const key = Math.round(Number(slot));
  if (!Number.isFinite(key)) return normaliseSaves(list);
  return normaliseSaves(list).filter((item) => item.slot !== key);
}

export function defaultShowSettings() {
  return {
    transition: normaliseTransition({}),
    audio: normaliseAudio({}),
    routes: normaliseRoutes(null),
    endings: [],
    playback: normalisePlayback({}),
    cast: normaliseCast({}),
    unlocks: [],
    saves: [],
  };
}

/** 把 `chat.settings.show` 规范化；坏数据一律退回默认，不让设置页打不开。 */
export function normaliseShowSettings(raw) {
  const base = defaultShowSettings();
  if (!raw || typeof raw !== 'object') return base;
  return {
    transition: normaliseTransition(raw.transition ?? {}),
    audio: normaliseAudio(raw.audio ?? {}),
    routes: Array.isArray(raw.routes) ? normaliseRoutes(raw.routes) : base.routes,
    endings: normaliseEndings(raw.endings),
    playback: normalisePlayback(raw.playback ?? {}),
    cast: normaliseCast(raw.cast ?? {}),
    unlocks: normaliseUnlocks(raw.unlocks ?? []),
    saves: normaliseSaves(raw.saves ?? []),
  };
}

/** 只合并 patch 里出现的字段（设置面板就是这样一处一处改的）。 */
export function mergeShowSettings(current, patch = {}) {
  const base = normaliseShowSettings(current);
  if (!patch || typeof patch !== 'object') return base;
  const next = { ...base };
  if (patch.transition !== undefined) next.transition = normaliseTransition({ ...base.transition, ...patch.transition });
  if (patch.audio !== undefined) next.audio = normaliseAudio({ ...base.audio, ...patch.audio });
  if (patch.routes !== undefined) next.routes = normaliseRoutes(patch.routes);
  if (patch.endings !== undefined) next.endings = normaliseEndings(patch.endings);
  if (patch.playback !== undefined) next.playback = normalisePlayback({ ...base.playback, ...patch.playback });
  if (patch.cast !== undefined) {
    // 名单是按名字一处一处改的：`{ cg: { 初雪: 'a1' } }` 只动这一条。
    const merged = { ...base.cast };
    for (const kind of CAST_KINDS) {
      if (patch.cast?.[kind] === undefined) continue;
      const incoming = {};
      for (const [name, assetId] of Object.entries(patch.cast[kind] ?? {})) {
        const label = String(name ?? '').trim().slice(0, 60);
        if (!label) continue;
        incoming[label] = assetId === null ? null : assetIdOrNull(assetId);
      }
      merged[kind] = { ...merged[kind], ...incoming };
    }
    next.cast = normaliseCast(merged);
  }
  if (patch.unlocks !== undefined) next.unlocks = normaliseUnlocks(patch.unlocks);
  if (patch.saves !== undefined) next.saves = normaliseSaves(patch.saves);
  return next;
}

export function transitions() {
  return TRANSITIONS.map((item) => ({ ...item }));
}

export function routeKinds() {
  return ROUTE_KINDS.map((item) => ({ ...item }));
}

export { assetIdOrNull };
