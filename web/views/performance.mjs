/**
 * 玩卡区 · 演出层（蓝图 2.5）—— 按"真 galgame"的排版和手感做。
 *
 * 排版照抄 Ren'Py 默认 GUI（业界事实标准，也是绝大多数商业 gal 的骨架）：
 *   全屏 16:9 舞台 → 背景铺满 / 立绘压在下缘 / 底部**整宽**对话框（约画面 1/4 高）
 *   名字牌凸在对话框左上角；正文左下对齐；对话框右下角 ▽ 一闪一闪提示"点击继续"
 *   对话框正下方一排小字快速菜单：回退 履历 跳过 自动 存档 快存 快读 设置 隐藏 菜单
 *   选项是画面正中的一列按钮（不塞进对话框里）
 *
 * 交互也照抄：
 *   左键 / 空格 / 回车 = 推进（打字没完先补全）；按住 Ctrl = 快进
 *   滚轮上 = 回退一句、滚轮下 = 前进一句；Esc / 右键 = 菜单；H / 中键 = 隐藏界面
 *
 * 剧本就是对话本身 —— 人写、AI 写、群聊里几个 AI 一起写都行；
 * 舞台指示写在消息里（语法见 core/staging/script.mjs：`[场景: …]`、`[CG: …]` 等）。
 * 图仍然是 ComfyUI 出的，这里只负责"什么时候切到哪一张"。
 */

import { h, statusChip } from '../core/dom.mjs';
import { get, post, put, del } from '../core/api.mjs';
import { panel, field, errorBox, loading, emptyState } from '../ui/components.mjs';
import { toast, toastError } from '../ui/toast.mjs';
import { openImageViewer } from './playing-common.mjs';

const QUICK_SLOT = 99;
const SLOT_GRID = [1, 2, 3, 4, 5, 6, 7, 8, 9];
const POSITION_CLASS = { left: 'pos-left', center: 'pos-center', right: 'pos-right' };

const MENU_TABS = [
  { id: 'history', title: '履历' },
  { id: 'save', title: '存档' },
  { id: 'load', title: '读档' },
  { id: 'prefs', title: '设置' },
  { id: 'gallery', title: 'CG 回廊' },
  { id: 'music', title: 'BGM / 音效' },
  { id: 'routes', title: '好感度与路线' },
  { id: 'cast', title: '素材绑定' },
  { id: 'transition', title: '转场' },
  { id: 'tools', title: '工具' },
];

function formatTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const pad = (num) => String(num).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function createPerformanceView(module, ctx) {
  const el = h('div', { class: 'view' });
  const host = h('div', {});

  const state = {
    chats: [],
    chatId: '',
    data: null,
    frames: [],
    line: 0,
    typed: '',
    typeTimer: null,
    auto: false,
    autoTimer: null,
    skip: false,
    skipTimer: null,
    hidden: false,
    menuTab: null,
    showingOptions: false,
    busy: false,
    imageAssets: [],
    audioAssets: [],
    unlocked: new Set(),
    endingHit: null,
    routeEntered: null,
    bgm: { active: 'a', id: null, timer: null },
    sfxAudio: null,
    fxTimer: null,
    cardTimer: null,
    dom: null,
  };

  /** BGM 用两条声道轮着放，切曲就是一条淡出、另一条淡入（crossfade）。 */
  const makeChannel = () => {
    const element = new Audio();
    element.loop = true;
    element.volume = 0;
    return element;
  };
  const bgmChannels = typeof Audio === 'function' ? { a: makeChannel(), b: makeChannel() } : null;
  if (typeof Audio === 'function') state.sfxAudio = new Audio();

  const assetUrl = (assetId) => `/api/assets/${encodeURIComponent(String(assetId))}/file`;

  // ------------------------------------------------------------------ 基础取值

  function currentFrame() {
    return state.frames[state.line] ?? null;
  }

  function playback() {
    return state.data?.playback ?? { textSpeed: 28, autoDelay: 1600 };
  }

  function isTyping() {
    return Boolean(state.typeTimer);
  }

  // ------------------------------------------------------------------ 声音

  function currentBgmAssetId() {
    const frame = currentFrame();
    const fromScript = frame?.stage?.bgm;
    if (fromScript?.stop) return null;
    if (fromScript?.assetId) return fromScript.assetId;
    return state.data?.audio?.resolved?.assetId ?? null;
  }

  function bgmTargetVolume() {
    const audio = state.data?.show?.audio ?? {};
    if (audio.muted) return 0;
    return Math.max(0, Math.min(1, Number(audio.volume ?? 0.6)));
  }

  /** 换曲：旧的一路淡出、新的一路淡入。assetId 传 null 就是淡出停掉。 */
  function fadeBgm(assetId, { fade = 800 } = {}) {
    if (!bgmChannels) return;
    const target = assetId ? bgmTargetVolume() : 0;
    const currentKey = state.bgm.active;
    const current = bgmChannels[currentKey];
    const otherKey = currentKey === 'a' ? 'b' : 'a';
    const other = bgmChannels[otherKey];

    if (state.bgm.timer) {
      clearInterval(state.bgm.timer);
      state.bgm.timer = null;
    }

    // 同一首：只把音量调到位，不重放
    if (assetId && state.bgm.id === assetId && current.getAttribute?.('src')) {
      current.volume = target;
      if (target > 0) current.play?.().catch(() => {});
      else current.pause?.();
      return;
    }
    if (!assetId && !state.bgm.id) return;

    if (assetId && target > 0) {
      other.src = assetUrl(assetId);
      other.volume = 0;
      other.play?.().catch(() => { /* 浏览器自动播放限制：点一下舞台就会开始 */ });
    }

    const startVolume = Number(current.volume) || 0;
    const steps = Math.max(1, Math.round(fade / 40));
    let step = 0;
    state.bgm.timer = setInterval(() => {
      if (!el.isConnected) {
        clearInterval(state.bgm.timer);
        state.bgm.timer = null;
        return;
      }
      step += 1;
      const ratio = Math.min(1, step / steps);
      current.volume = Math.max(0, startVolume * (1 - ratio));
      if (assetId) other.volume = target * ratio;
      if (ratio < 1) return;
      clearInterval(state.bgm.timer);
      state.bgm.timer = null;
      current.pause?.();
      current.removeAttribute?.('src');
      current.volume = 0;
      if (assetId) {
        state.bgm.active = otherKey;
        state.bgm.id = assetId;
      } else {
        state.bgm.id = null;
      }
    }, 40);
  }

  /** 音量 / 静音改了：正在淡入淡出就不抢，否则立刻生效。 */
  function applyBgmVolume() {
    if (!bgmChannels || state.bgm.timer) return;
    const target = bgmTargetVolume();
    const active = bgmChannels[state.bgm.active];
    if (!active.getAttribute?.('src')) return;
    active.volume = target;
    if (target > 0) active.play?.().catch(() => {});
    else active.pause?.();
  }

  /** 按当前设置与这一幕，把 BGM 放起来 / 换掉 / 静音。 */
  function applyAudio() {
    if (bgmChannels) {
      const assetId = currentBgmAssetId();
      if (state.bgm.id === assetId) applyBgmVolume();
      else fadeBgm(assetId, { fade: assetId ? 900 : 600 });
    }
    paintBadge();
  }

  function playSfx(assetId) {
    if (!state.sfxAudio || !assetId) return;
    state.sfxAudio.src = assetUrl(assetId);
    state.sfxAudio.volume = Math.max(0, Math.min(1, Number(state.data?.show?.audio?.volume ?? 0.6)));
    state.sfxAudio.play?.().catch(() => {});
  }

  /** 转场：给舞台加一个类，动画播完摘掉（CSS 里定义）。 */
  function playTransition(effect, durationMs) {
    if (!effect || effect === 'none') return;
    const stageEl = state.dom?.stage;
    if (!stageEl?.classList) return;
    const cls = `stage-fx-${effect}`;
    const duration = Math.max(200, Number(durationMs) || 700);
    stageEl.style?.setProperty?.('--st-fx-duration', `${duration}ms`);
    stageEl.classList.add(cls);
    if (state.fxTimer) clearTimeout(state.fxTimer);
    state.fxTimer = setTimeout(() => {
      stageEl.classList.remove(cls);
      state.fxTimer = null;
    }, duration);
  }

  // ------------------------------------------------------------------ 服务端

  async function refreshAssets() {
    try {
      const [images, audios] = await Promise.all([
        get('/api/assets?kind=image&limit=200'),
        get('/api/assets?kind=audio&limit=200'),
      ]);
      state.imageAssets = images?.items ?? [];
      state.audioAssets = audios?.items ?? [];
    } catch {
      state.imageAssets = [];
      state.audioAssets = [];
    }
  }

  async function saveShow(patch) {
    try {
      const result = await put(`/api/staging/${state.chatId}/show`, patch);
      const show = result.show;
      state.data.show = show;
      state.data.playback = show.playback;
      state.data.cast = show.cast;
      state.data.saves = show.saves;
      state.data.unlocks = show.unlocks;
      state.unlocked = new Set((show.unlocks ?? []).map((item) => item.name));
      applyAudio();
      return show;
    } catch (err) {
      toastError(err);
      return null;
    }
  }

  /** 解锁一张 CG —— 故事真的演到那儿了才调。 */
  async function unlockCg(cg) {
    if (!cg?.name || state.unlocked.has(cg.name)) return;
    state.unlocked.add(cg.name);
    try {
      await post(`/api/staging/${state.chatId}/unlocks`, { name: cg.name, messageId: cg.messageId ?? null });
      toast(`CG 已收进回廊：${cg.name}`);
    } catch {
      state.unlocked.delete(cg.name);
    }
  }

  async function noteEnding(ending) {
    if (!ending?.name || state.endingHit === ending.name) return;
    state.endingHit = ending.name;
    const route = (state.data?.routes?.items ?? []).find((item) => item.title === ending.name);
    if (route) {
      try {
        state.data.routes = await post(`/api/staging/${state.chatId}/endings`, { routeId: route.id });
      } catch (err) {
        toastError(err);
      }
    }
    toast(`到达结局：${ending.name}`, { tone: 'info', duration: 5000 });
  }

  /** 剧本章节标题卡：黑底一行字淡入淡出（真 gal 的章节过场）。 */
  function showTitleCard(text) {
    const dom = state.dom;
    if (!dom?.titlecard || !text) return;
    dom.titlecard.textContent = text;
    dom.titlecard.classList.add('show');
    if (state.cardTimer) clearTimeout(state.cardTimer);
    state.cardTimer = setTimeout(() => {
      dom.titlecard.classList.remove('show');
      state.cardTimer = null;
    }, 2200);
  }

  /** 剧本写 [路线: 恋人线] → 进这条线，别的线锁上。 */
  async function enterRouteByName(name) {
    const key = String(name ?? '').trim();
    if (!key || state.routeEntered === key) return;
    const hit = (state.data?.show?.routes ?? []).find((item) => item.id === key || item.title === key) ?? null;
    if (!hit) {
      toast(`剧本里写了 [路线: ${key}]，但还没有这条路线`, { tone: 'warn', duration: 5000 });
      return;
    }
    state.routeEntered = key;
    showTitleCard(hit.title);
    try {
      state.data.routes = await post(`/api/staging/${state.chatId}/routes/enter`, { name: hit.id });
      const locked = (state.data.routes.items ?? []).filter((item) => item.locked).length;
      toast(locked ? `进入「${hit.title}」——其它 ${locked} 条线已锁定` : `进入「${hit.title}」`, { duration: 4000 });
    } catch (err) {
      toastError(err);
    }
  }

  // ------------------------------------------------------------------ 舞台状态

  function charNode(character) {
    const classes = `gal-char ${POSITION_CLASS[character.position] ?? 'pos-center'} size-${character.size ?? 'medium'}`;
    if (character.assetId) {
      return h(
        'button',
        {
          class: classes,
          dataset: { name: character.name },
          title: `${character.name}${character.emotion ? ` · ${character.emotion}` : ''}`,
          onclick: (event) => { event.stopPropagation(); openImageViewer(character.assetId, { name: character.name }); },
        },
        h('img', { src: assetUrl(character.assetId), alt: character.name }),
      );
    }
    return h(
      'div',
      { class: `${classes} gal-char-empty`, dataset: { name: character.name }, title: '这个名字还没绑立绘' },
      h('span', {}, `${character.name}${character.emotion ? `\n${character.emotion}` : ''}`),
    );
  }

  function paintText() {
    const dom = state.dom;
    if (!dom) return;
    const frame = currentFrame();
    if (!frame) {
      dom.text.textContent = '';
      dom.next.hidden = true;
      return;
    }
    dom.text.textContent = state.typed;
    const complete = state.typed.length >= String(frame.text ?? '').length;
    dom.next.hidden = !complete;
  }

  function paintBadge() {
    const dom = state.dom;
    if (!dom) return;
    const frame = currentFrame();
    const parts = [];
    if (frame?.scene) parts.push(frame.scene);
    const bgm = frame?.stage?.bgm;
    if (bgm && !bgm.stop && bgm.name) parts.push(`♪ ${bgm.name}`);
    else if (bgm?.stop) parts.push('♪ 停');
    else if (state.data?.audio?.resolved?.assetId) parts.push(`♪ ${state.data.audio.resolved.reason ?? '默认'}`);
    dom.badge.textContent = parts.join(' · ');
    dom.progress.textContent = state.frames.length ? `${state.line + 1} / ${state.frames.length}` : '';
    dom.skipBadge.hidden = !state.skip;
    dom.autoBadge.hidden = !state.auto;
  }

  function renderChoices() {
    const dom = state.dom;
    if (!dom) return;
    const options = state.data?.options ?? [];
    const show = Boolean(state.showingOptions && options.length);
    dom.choices.hidden = !show;
    if (!show) {
      dom.choices.replaceChildren();
      return;
    }
    dom.choices.replaceChildren(
      ...options.map((option) =>
        h(
          'button',
          {
            class: 'gal-choice',
            onclick: (event) => {
              event.stopPropagation();
              void pickOption(option);
            },
          },
          option.text,
        ),
      ),
    );
  }

  function paintStage() {
    const dom = state.dom;
    if (!dom) return;
    const frame = currentFrame();
    const stageInfo = frame?.stage ?? { background: null, characters: [] };

    const bg = stageInfo.background;
    if (bg?.assetId) {
      const src = assetUrl(bg.assetId);
      if (dom.bg.getAttribute('src') !== src) dom.bg.src = src;
      dom.bg.hidden = false;
      dom.bgEmpty.hidden = true;
    } else {
      dom.bg.hidden = true;
      dom.bgEmpty.hidden = false;
      dom.bgEmpty.textContent = bg?.name
        ? `「${bg.name}」还没绑背景图 —— 去「菜单 → 素材绑定」挂一张`
        : '（这一幕还没有背景）';
    }

    const wanted = stageInfo.characters ?? [];
    const key = wanted.map((item) => `${item.key}:${item.assetId ?? ''}:${item.position}:${item.size ?? 'medium'}`).join('|');
    if (dom.charsKey !== key) {
      dom.charsKey = key;
      dom.chars.replaceChildren(...wanted.map((item) => charNode(item)));
    }
    // 谁在说话谁亮，其他人压暗（真 gal 的常规演出），不重建节点所以不会重播进场动画
    const speaker = frame?.name ?? '';
    for (const node of dom.chars.children) {
      const isSpeaker = Boolean(speaker) && node.dataset?.name === speaker;
      node.classList.toggle('speaking', isSpeaker);
      node.classList.toggle('dim', Boolean(speaker) && !isSpeaker);
    }

    // CG 是舞台的一层：文字翻页时它不消失，换场景或 [CG: -] 才收
    const stageCg = stageInfo.cg ?? null;
    dom.cg.hidden = !stageCg;
    if (stageCg) {
      const src = stageCg.assetId ? assetUrl(stageCg.assetId) : '';
      if (src && dom.cgImg.getAttribute('src') !== src) dom.cgImg.src = src;
      dom.cgImg.hidden = !stageCg.assetId;
      dom.cgName.textContent = stageCg.assetId ? stageCg.name : `「${stageCg.name}」还没绑图`;
    }
    const named = Boolean(frame && !frame.silent && frame.name);
    dom.namebox.textContent = named ? frame.name : '';
    dom.namebox.hidden = !named;
    dom.win.classList.toggle('narration', Boolean(frame) && !named);
    paintText();
    renderChoices();
    paintBadge();
  }

  // ------------------------------------------------------------------ 播放控制

  function startTyping({ quiet = false } = {}) {
    if (state.typeTimer) {
      clearInterval(state.typeTimer);
      state.typeTimer = null;
    }
    const frame = currentFrame();
    const full = String(frame?.text ?? '');
    const speed = Number(playback().textSpeed ?? 28);
    if (!full || speed <= 0 || state.skip) {
      state.typed = full;
      paintText();
      if (!quiet) afterTyped();
      return;
    }
    state.typed = '';
    paintText();
    let index = 0;
    state.typeTimer = setInterval(() => {
      if (!el.isConnected) {
        clearInterval(state.typeTimer);
        state.typeTimer = null;
        return;
      }
      index += 1;
      state.typed = full.slice(0, index);
      paintText();
      if (index >= full.length) {
        clearInterval(state.typeTimer);
        state.typeTimer = null;
        if (!quiet) afterTyped();
      }
    }, speed);
  }

  function finishTyping({ quiet = false } = {}) {
    if (state.typeTimer) {
      clearInterval(state.typeTimer);
      state.typeTimer = null;
    }
    const frame = currentFrame();
    state.typed = String(frame?.text ?? '');
    paintText();
    if (!quiet) afterTyped();
  }

  function afterTyped() {
    if (state.skip) queueSkip();
    else if (state.auto) scheduleAuto();
  }

  function scheduleAuto() {
    if (state.autoTimer) clearTimeout(state.autoTimer);
    state.autoTimer = null;
    if (!state.auto) return;
    const delay = Math.max(300, Number(playback().autoDelay ?? 1600));
    state.autoTimer = setTimeout(() => {
      state.autoTimer = null;
      if (!el.isConnected || !state.auto) return;
      if (state.menuTab) { scheduleAuto(); return; }
      advance();
    }, delay);
  }

  function queueSkip() {
    if (state.skipTimer) {
      clearTimeout(state.skipTimer);
      state.skipTimer = null;
    }
    if (!state.skip) return;
    state.skipTimer = setTimeout(skipStep, 50);
  }

  function skipStep() {
    state.skipTimer = null;
    if (!el.isConnected || !state.skip) return;
    if (state.menuTab) { queueSkip(); return; }
    if (state.showingOptions) { setSkip(false); return; }
    if (isTyping()) finishTyping({ quiet: true });
    if (state.line >= state.frames.length - 1) {
      setSkip(false);
      toast('已经跳到最新一句了', { tone: 'info' });
      return;
    }
    gotoLine(state.line + 1, { quiet: true });
    queueSkip();
  }

  function setAuto(on) {
    state.auto = Boolean(on);
    if (state.autoTimer) {
      clearTimeout(state.autoTimer);
      state.autoTimer = null;
    }
    if (state.auto) {
      setSkip(false);
      if (!isTyping()) scheduleAuto();
    }
    paintBadge();
  }

  function setSkip(on) {
    state.skip = Boolean(on);
    if (state.skipTimer) {
      clearTimeout(state.skipTimer);
      state.skipTimer = null;
    }
    if (state.skip) {
      setAuto(false);
      skipStep();
    }
    paintBadge();
  }

  function toggleHidden() {
    state.hidden = !state.hidden;
    state.dom?.shell?.classList.toggle('ui-hidden', state.hidden);
  }

  /** 演出推进：打字没完先补全，然后下一句。 */
  function advance() {
    if (state.menuTab) return;
    const frame = currentFrame();
    if (frame && state.typed.length < String(frame.text ?? '').length) {
      finishTyping();
      return;
    }
    if (state.showingOptions) return;
    if (state.line >= state.frames.length - 1) {
      setAuto(false);
      toast('已经是最后一句了', { tone: 'info' });
      return;
    }
    gotoLine(state.line + 1);
  }

  /** 回退一句（gal 的 rollback）。 */
  function step(delta) {
    if (state.menuTab) return;
    const target = state.line + delta;
    if (target < 0) {
      toast('已经是第一句了', { tone: 'info' });
      return;
    }
    if (target > state.frames.length - 1) {
      toast('已经是最后一句了', { tone: 'info' });
      return;
    }
    setAuto(false);
    gotoLine(target);
  }

  function applyEffects(frame) {
    const fx = frame?.effect ?? {};
    if (fx.transition?.effect) playTransition(fx.transition.effect, fx.transition.durationMs ?? 700);
    for (const item of fx.sfx ?? []) if (item.assetId) playSfx(item.assetId);
    if (fx.bgmChanged) applyAudio();
    if (fx.cg?.name) void unlockCg(fx.cg);
    if (fx.ending?.name) void noteEnding(fx.ending);
    if (fx.chapter?.name) showTitleCard(fx.chapter.name);
    if (fx.route?.name) void enterRouteByName(fx.route.name);
  }

  function gotoLine(index, { quiet = false } = {}) {
    if (!state.frames.length) return;
    let target = Math.max(0, Math.min(state.frames.length - 1, index));
    let guard = 0;
    // 只有舞台指示、没有台词的那种"指令行"：效果照做，然后自动往下一句走。
    while (guard < 3000) {
      guard += 1;
      const frame = state.frames[target];
      if (!frame) break;
      applyEffects(frame);
      if (!frame.silent) break;
      if (target >= state.frames.length - 1) break;
      target += 1;
    }
    state.line = target;
    state.showingOptions = target === state.frames.length - 1 && (state.data?.options?.length ?? 0) > 0;
    paintStage();
    startTyping({ quiet });
  }

  async function pickOption(option) {
    if (state.busy) return;
    state.busy = true;
    try {
      await post(`/api/chats/${state.chatId}/send`, { text: option.text });
      toast('已发送，等回复');
      await loadStage({ keepLine: 'end' });
    } catch (err) {
      toastError(err);
    } finally {
      state.busy = false;
    }
  }

  // ------------------------------------------------------------------ 存档

  async function writeSlot(slot) {
    const frame = currentFrame();
    if (!frame) return toast('还没有可存的画面', { tone: 'warn' });
    try {
      const result = await put(`/api/staging/${state.chatId}/saves`, {
        slot,
        label: state.data?.title ?? '',
        lineIndex: state.line,
        messageId: frame.messageId,
        name: frame.name,
        text: String(frame.text ?? '').slice(0, 120),
        scene: frame.scene ?? '',
        shotAssetId: frame.stage?.background?.assetId ?? null,
      });
      state.data.saves = result.saves;
      toast(slot === QUICK_SLOT ? '已快速存档' : `已存到第 ${slot} 槽`);
      renderMenuBody();
    } catch (err) {
      toastError(err);
    }
  }

  async function removeSlot(slot) {
    try {
      const result = await del(`/api/staging/${state.chatId}/saves/${slot}`);
      state.data.saves = result.saves;
      renderMenuBody();
    } catch (err) {
      toastError(err);
    }
  }

  function readSlot(entry) {
    if (!entry) return toast('这个槽位是空的', { tone: 'warn' });
    closeMenu();
    gotoLine(entry.lineIndex);
    toast(`读档：${entry.scene || '—'} · 第 ${entry.lineIndex + 1} 句`);
  }

  async function quickSave() {
    await writeSlot(QUICK_SLOT);
  }

  function quickLoad() {
    const entry = (state.data?.saves ?? []).find((item) => item.slot === QUICK_SLOT);
    readSlot(entry);
  }

  // ------------------------------------------------------------------ 菜单

  function openMenu(tab) {
    if (!state.dom) return;
    state.menuTab = tab ?? 'save';
    setAuto(false);
    setSkip(false);
    state.dom.menu.overlay.hidden = false;
    for (const button of state.dom.menu.nav.children) {
      button.classList.toggle('active', button.dataset.tab === state.menuTab);
    }
    renderMenuBody();
  }

  function closeMenu() {
    state.menuTab = null;
    if (state.dom?.menu) {
      state.dom.menu.overlay.hidden = true;
      state.dom.menu.body.replaceChildren();
    }
  }

  function renderMenuBody() {
    const dom = state.dom;
    if (!dom?.menu || !state.menuTab) return;
    const builders = {
      history: historyTab,
      save: () => slotsTab('save'),
      load: () => slotsTab('load'),
      prefs: prefsTab,
      gallery: galleryTab,
      music: musicTab,
      routes: routesTab,
      cast: castTab,
      transition: transitionTab,
      tools: toolsTab,
    };
    dom.menu.body.replaceChildren(builders[state.menuTab]?.() ?? emptyState({ icon: '🎬', title: '还没有内容' }));
  }

  function historyTab() {
    const played = state.frames.slice(0, state.line + 1);
    if (!played.length) return emptyState({ icon: '📜', title: '还没有台词' });
    return h(
      'div',
      { class: 'gal-log' },
      ...played.map((frame, index) =>
        h(
          'div',
          { class: `gal-log-row${index === state.line ? ' current' : ''}`, onclick: () => { closeMenu(); gotoLine(index); } },
          h('div', { class: 'gal-log-name' }, frame.silent ? '（演出）' : frame.name),
          h('div', { class: 'gal-log-text' }, frame.text || `（舞台指示：${(frame.markers ?? []).map((marker) => marker.type).join(' / ') || '无'}）`),
        ),
      ),
    );
  }

  function slotNode(slot, entry, mode) {
    const shot = entry?.shotAssetId ? assetUrl(entry.shotAssetId) : null;
    const node = h(
      'button',
      { class: `gal-slot${entry ? ' filled' : ''}`, onclick: () => (mode === 'save' ? void writeSlot(slot) : readSlot(entry)) },
      h('div', { class: 'gal-slot-thumb' }, shot ? h('img', { src: shot, alt: '' }) : h('span', {}, slot === QUICK_SLOT ? '快存' : `第 ${slot} 槽`)),
      h('div', { class: 'gal-slot-title' }, slot === QUICK_SLOT ? '快速存档' : `存档 ${slot}`),
      h('div', { class: 'gal-slot-meta' }, entry ? `${entry.scene || '—'} · ${formatTime(entry.at)}` : '空'),
      entry?.text ? h('div', { class: 'gal-slot-text' }, entry.text) : null,
    );
    if (entry) {
      node.append(
        h(
          'span',
          { class: 'gal-slot-del', title: '删除这个存档', onclick: (event) => { event.stopPropagation(); void removeSlot(slot); } },
          '✕',
        ),
      );
    }
    return node;
  }

  function slotsTab(mode) {
    const saves = new Map((state.data?.saves ?? []).map((item) => [item.slot, item]));
    return h(
      'div',
      { class: 'gal-tab' },
      h('div', { class: 'gal-note' }, mode === 'save' ? '点一个槽位写入（同槽覆盖）；「快存」在快速菜单里。' : '点一个槽位回到那一刻。'),
      h('div', { class: 'gal-slots' }, ...[QUICK_SLOT, ...SLOT_GRID].map((slot) => slotNode(slot, saves.get(slot), mode))),
    );
  }

  function slider(label, { min, max, step, value, format, onInput, onChange }) {
    const input = h('input', { type: 'range', min: String(min), max: String(max), step: String(step) });
    input.value = String(value);
    const readout = h('span', { class: 'gal-slider-value' }, format ? format(Number(input.value)) : String(input.value));
    input.addEventListener('input', (event) => {
      readout.textContent = format ? format(Number(event.target.value)) : String(event.target.value);
      onInput?.(Number(event.target.value));
    });
    input.addEventListener('change', (event) => onChange?.(Number(event.target.value)));
    return h('div', { class: 'gal-slider' }, h('div', { class: 'gal-slider-label' }, h('span', {}, label), readout), input);
  }

  function prefsTab() {
    const pb = playback();
    const audio = state.data?.show?.audio ?? {};
    const toggle = (label, checked, onChange, hint = null) => {
      const input = h('input', { type: 'checkbox' });
      input.checked = Boolean(checked);
      input.addEventListener('change', (event) => onChange(event.target.checked));
      return field(label, input, hint);
    };
    return h(
      'div',
      { class: 'gal-tab' },
      h('div', { class: 'gal-section-title' }, '文字'),
      slider('文字速度', {
        min: 0, max: 120, step: 2, value: pb.textSpeed,
        format: (value) => (value === 0 ? '瞬间显示' : `${value} ms/字`),
        onInput: (value) => { state.data.playback.textSpeed = value; },
        onChange: (value) => void saveShow({ playback: { textSpeed: value } }),
      }),
      slider('自动播放间隔', {
        min: 300, max: 6000, step: 100, value: pb.autoDelay,
        format: (value) => `${(value / 1000).toFixed(1)} 秒`,
        onInput: (value) => { state.data.playback.autoDelay = value; },
        onChange: (value) => void saveShow({ playback: { autoDelay: value } }),
      }),
      h('div', { class: 'gal-section-title' }, '跳过'),
      toggle('跳过没看过的文字', pb.skipUnread, (checked) => void saveShow({ playback: { skipUnread: checked } }), '关着就是"只跳已读"，和真 gal 一样'),
      toggle('选项之后继续跳过', pb.skipAfterChoices, (checked) => void saveShow({ playback: { skipAfterChoices: checked } })),
      h('div', { class: 'gal-section-title' }, '声音'),
      slider('音量', {
        min: 0, max: 1, step: 0.05, value: audio.volume ?? 0.6,
        format: (value) => `${Math.round(value * 100)}%`,
        onInput: (value) => {
          if (state.sfxAudio) state.sfxAudio.volume = value;
          if (state.data?.show?.audio) state.data.show.audio.volume = value;
          applyBgmVolume();
        },
        onChange: (value) => void saveShow({ audio: { volume: value } }),
      }),
      toggle('静音', audio.muted, (checked) => void saveShow({ audio: { muted: checked } })),
      h('div', { class: 'gal-section-title' }, '画面'),
      h('div', { class: 'gal-row' },
        h('button', { class: 'btn', onclick: () => { const box = state.dom?.stage; if (box?.requestFullscreen) void box.requestFullscreen().catch(() => toast('浏览器不让全屏', { tone: 'warn' })); } }, '全屏'),
      ),
      h('div', { class: 'gal-section-title' }, '语音 / 动态（接口留好了，还没接）'),
      h('div', { class: 'gal-note' }, '剧本里写 [语音: 音色名] 已经能认、也不会漏进台词；等「模型接入 → 语音合成」接上，这里会多出音色、音量和"每句自动朗读"。动态立绘同理，素材槽位留着，等有 Live2D / 序列帧的播放通道再开。'),
      h('div', { class: 'gal-note' }, '快捷键：空格 / 回车 / 左键推进 · 按住 Ctrl 快进 · 滚轮上回退 · Esc 或右键开菜单 · H 隐藏界面'),
    );
  }

  function galleryTab() {
    const cgs = state.data?.timeline?.cgs ?? [];
    const unlockedCount = cgs.filter((cg) => state.unlocked.has(cg.name)).length;
    const scriptGrid = cgs.length
      ? h(
          'div',
          { class: 'gal-cg-grid' },
          ...cgs.map((cg) => {
            const open = state.unlocked.has(cg.name);
            return h(
              'button',
              {
                class: `gal-cg-card${open ? '' : ' locked'}`,
                title: open ? cg.name : '还没演到这儿',
                onclick: () => { if (open && cg.assetId) openImageViewer(cg.assetId, { name: cg.name }); },
              },
              h(
                'div',
                { class: 'gal-cg-thumb' },
                cg.assetId
                  ? h('img', { class: open ? '' : 'silhouette', src: assetUrl(cg.assetId), alt: '' })
                  : h('span', {}, open ? '没绑图' : '？'),
              ),
              h('div', { class: 'gal-cg-title' }, open ? cg.name : '？？？'),
            );
          }),
        )
      : emptyState({ icon: '🖼️', title: '剧本里还没有 [CG: …]', desc: '在对话里写一行 [CG: 初雪]，这里就多一张待解锁的格子。' });

    const shots = state.data?.gallery?.items ?? [];
    return h(
      'div',
      { class: 'gal-tab' },
      h('div', { class: 'gal-section-title' }, `剧情 CG（已解锁 ${unlockedCount} / ${cgs.length}）`),
      h('div', { class: 'gal-note' }, '演到那一句才会解锁 —— 没解锁的只给剪影。'),
      scriptGrid,
      h('div', { class: 'gal-section-title' }, `出过的图（${shots.length}）`),
      shots.length
        ? h(
            'div',
            { class: 'gal-cg-grid' },
            ...shots.map((item) =>
              h(
                'button',
                { class: 'gal-cg-card', title: `${item.name}${item.emotion ? ` · ${item.emotion}` : ''}`, onclick: () => openImageViewer(item.assetId, { name: item.name }) },
                h('div', { class: 'gal-cg-thumb' }, h('img', { src: assetUrl(item.assetId), alt: item.name, loading: 'lazy' })),
                h('div', { class: 'gal-cg-title' }, item.kind ?? '图'),
              ),
            ),
          )
        : h('div', { class: 'gal-note' }, '还没有出过图。'),
    );
  }

  function musicTab() {
    const audio = state.data?.show?.audio ?? {};
    const resolved = state.data?.audio?.resolved ?? null;
    const options = () => state.audioAssets.map((asset) => h('option', { value: asset.id }, asset.name ?? asset.id));

    const bgmSelect = h('select', {}, h('option', { value: '' }, '（不放）'), ...options());
    bgmSelect.value = audio.bgm ?? '';
    bgmSelect.addEventListener('change', (event) => void saveShow({ audio: { bgm: event.target.value || null } }));

    const placeInput = h('input', { type: 'text', placeholder: '地点名，比如 旧书馆' });
    placeInput.value = currentFrame()?.scene ?? '';
    const placeSelect = h('select', {}, h('option', { value: '' }, '选一首 BGM…'), ...options());

    const file = h('input', { type: 'file', accept: 'audio/*' });
    file.addEventListener('change', async (event) => {
      const picked = event.target.files?.[0];
      if (!picked) return;
      try {
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result ?? ''));
          reader.onerror = () => reject(new Error('读不了这个文件'));
          reader.readAsDataURL(picked);
        });
        const saved = await post('/api/assets', { data: dataUrl.replace(/^data:[^,]*,/, ''), kind: 'audio', name: picked.name, mime: picked.type || 'audio/mpeg' });
        toast(`已加入音频库：${saved.name ?? picked.name}`);
        await refreshAssets();
        renderMenuBody();
      } catch (err) {
        toastError(err);
      }
    });

    const bindings = Object.entries(audio.bgmByPlace ?? {});
    return h(
      'div',
      { class: 'gal-tab' },
      h('div', { class: 'gal-section-title' }, '背景音乐（BGM）'),
      h('div', { class: 'gal-note' }, resolved?.assetId ? `当前：${resolved.reason}` : '还没配置 BGM'),
      h('div', { class: 'gal-grid2' }, field('默认 BGM', bgmSelect), field('上传音频', file, '进素材库（kind=audio），几张卡可以共用')),
      h('div', { class: 'gal-row' },
        field('场景地点', placeInput),
        field('对应 BGM', placeSelect),
        h('button', {
          class: 'btn',
          onclick: () => {
            const place = placeInput.value.trim();
            if (!place || !placeSelect.value) return toast('先填地点、选一首 BGM', { tone: 'warn' });
            void saveShow({ audio: { bgmByPlace: { ...(audio.bgmByPlace ?? {}), [place]: placeSelect.value } } }).then(() => { toast(`「${place}」的 BGM 已绑定`); renderMenuBody(); });
          },
        }, '按地点绑定'),
        h('button', { class: 'btn', onclick: () => void saveShow({ audio: { bgmByPlace: {} } }).then(() => renderMenuBody()) }, '清空地点绑定'),
      ),
      bindings.length ? h('div', { class: 'gal-note' }, `已绑定地点：${bindings.map(([place]) => place).join(' / ')}`) : null,
      h('div', { class: 'gal-section-title' }, '音效（点一下放一声）'),
      (audio.sfx ?? []).length
        ? h(
            'div',
            { class: 'gal-row' },
            ...(audio.sfx ?? []).map((item) =>
              h('span', { class: 'gal-sfx' },
                h('button', { class: 'btn', onclick: () => playSfx(item.assetId) }, `🔊 ${item.label || '音效'}`),
                h('button', {
                  class: 'link-btn',
                  onclick: () => void saveShow({ audio: { sfx: (audio.sfx ?? []).filter((entry) => entry.assetId !== item.assetId) } }).then(() => renderMenuBody()),
                }, '删'),
              ),
            ),
          )
        : h('div', { class: 'gal-note' }, '还没有音效'),
      h('div', { class: 'gal-row' }, sfxAddRow()),
    );
  }

  function sfxAddRow() {
    const label = h('input', { type: 'text', placeholder: '名字，比如 开门声' });
    const select = h('select', {}, h('option', { value: '' }, '选一段音频…'), ...state.audioAssets.map((asset) => h('option', { value: asset.id }, asset.name ?? asset.id)));
    return h(
      'div',
      { class: 'gal-row' },
      label,
      select,
      h('button', {
        class: 'btn',
        onclick: () => {
          if (!select.value) return toast('先选一段音频', { tone: 'warn' });
          const audio = state.data?.show?.audio ?? {};
          const next = [...(audio.sfx ?? []), { assetId: select.value, label: label.value.trim() || '音效' }];
          void saveShow({ audio: { sfx: next } }).then(() => { toast('音效已加入'); renderMenuBody(); });
        },
      }, '＋ 加音效'),
    );
  }

  function routesTab() {
    const routes = state.data?.routes ?? { items: [], endings: [] };
    const rows = (routes.items ?? []).map((route) => {
      const threshold = h('input', { type: 'number', class: 'gal-num' });
      threshold.value = String(route.threshold);
      threshold.addEventListener('change', () => {
        const next = (state.data?.show?.routes ?? []).map((item) => (item.id === route.id ? { ...item, threshold: Number(threshold.value) } : item));
        void saveShow({ routes: next }).then(() => loadStage({ keepLine: true }));
      });
      return h(
        'div',
        { class: 'gal-route' },
        h('div', { class: 'gal-route-head' },
          h('span', { class: 'gal-route-title' }, route.title),
          route.locked
            ? h('span', { class: 'chip planned', title: route.lockedBy ? `被「${route.lockedBy}」锁住` : '已锁定' }, route.lockedBy ? `被「${route.lockedBy}」锁住` : '已锁定')
            : h('span', { class: `chip ${route.unlocked ? 'ready' : 'planned'}` }, route.unlocked ? '已解锁' : '未解锁'),
          route.reached ? h('span', { class: 'chip ready' }, '已收集结局') : null,
          h('button', {
            class: 'link-btn',
            onclick: () => void saveShow({ routes: (state.data?.show?.routes ?? []).filter((item) => item.id !== route.id) }).then(() => { toast(`已删除路线：${route.title}`); renderMenuBody(); }),
          }, '删掉'),
        ),
        h('div', { class: 'gal-note' }, `当前好感度 ${route.current} · 阈值 ${route.threshold}${route.target ? ` · 只看「${route.target}」` : '（取最高）'}`),
        route.ending ? h('div', { class: 'gal-note' }, route.ending) : null,
        h('div', { class: 'gal-row' },
          h('span', { class: 'gal-note' }, '阈值'),
          threshold,
          h('button', { class: 'btn', onclick: () => void recordEndingFor(route) }, '记下这个结局'),
          h('button', { class: 'btn', onclick: () => void enterRouteFor(route) }, '进这条线'),
          route.locked ? h('button', { class: 'btn', onclick: () => void unlockRouteFor(route) }, '解锁') : null,
        ),
      );
    });

    const title = h('input', { type: 'text', placeholder: '路线名，比如 恋人线' });
    const target = h('input', { type: 'text', placeholder: '只看某个角色（留空 = 取最高）' });
    const threshold = h('input', { type: 'number', placeholder: '60' });
    threshold.value = '60';
    const ending = h('input', { type: 'text', placeholder: '走到这条线时的结局文案' });

    return h(
      'div',
      { class: 'gal-tab' },
      h('div', { class: 'gal-note' }, `最高好感度 ${routes.affection?.max ?? 0} · 已收集结局：${(routes.endings ?? []).map((item) => item.title).join(' / ') || '还没有'}`),
      rows.length ? h('div', {}, ...rows) : emptyState({ icon: '💗', title: '还没有路线', desc: '在下面加一条，好感度到阈值就解锁。' }),
      h('div', { class: 'gal-section-title' }, '加一条路线'),
      h('div', { class: 'gal-grid2' }, field('路线名', title), field('限定角色', target), field('阈值', threshold), field('结局文案', ending)),
      h('button', {
        class: 'btn',
        onclick: () => {
          const name = title.value.trim();
          if (!name) return toast('先给路线起个名字', { tone: 'warn' });
          const next = [
            ...(state.data?.show?.routes ?? []),
            { id: `route-${Date.now().toString(36)}`, title: name, target: target.value.trim(), threshold: Number(threshold.value) || 0, ending: ending.value.trim() },
          ];
          void saveShow({ routes: next }).then(() => { toast(`已添加路线：${name}`); renderMenuBody(); });
        },
      }, '＋ 添加路线'),
    );
  }

  async function recordEndingFor(route) {
    try {
      state.data.routes = await post(`/api/staging/${state.chatId}/endings`, { routeId: route.id });
      toast(`已收进结局图鉴：${route.title}`);
      renderMenuBody();
    } catch (err) {
      toastError(err);
    }
  }

  async function enterRouteFor(route) {
    try {
      state.data.routes = await post(`/api/staging/${state.chatId}/routes/enter`, { name: route.id });
      toast(`进入「${route.title}」——其它线已锁定`);
      renderMenuBody();
    } catch (err) {
      toastError(err);
    }
  }

  async function unlockRouteFor(route) {
    try {
      state.data.routes = await post(`/api/staging/${state.chatId}/routes/${encodeURIComponent(route.id)}/unlock`, {});
      toast(`「${route.title}」已解锁`);
      renderMenuBody();
    } catch (err) {
      toastError(err);
    }
  }

  function castRow(label, kind, name, assets, hint) {
    const table = state.data?.show?.cast?.[kind] ?? {};
    const select = h('select', {}, h('option', { value: '' }, '— 没绑 —'), ...assets.map((asset) => h('option', { value: asset.id }, asset.name ?? asset.id)));
    select.value = table[name] ?? '';
    select.addEventListener('change', () => {
      const value = select.value || null;
      void saveShow({ cast: { [kind]: { [name]: value } } }).then(() => { toast(value ? `已绑定：${name}` : `已解绑：${name}`); loadStage({ keepLine: true, keepAssets: true }); });
    });
    const bound = table[name] ?? null;
    return h(
      'div',
      { class: 'gal-cast-row' },
      h('div', { class: 'gal-cast-name' }, label, hint ? h('span', { class: 'gal-note' }, hint) : null),
      select,
      bound && assets === state.imageAssets
        ? h('button', { class: 'link-btn', onclick: () => openImageViewer(bound, { name }) }, '看')
        : null,
    );
  }

  function castTab() {
    const frames = state.frames;
    const bgNames = [...new Set(frames.map((frame) => frame.stage?.background?.name).filter(Boolean))];
    const charKeys = new Map();
    for (const frame of frames) {
      for (const character of frame.stage?.characters ?? []) {
        if (!charKeys.has(character.key)) charKeys.set(character.key, character);
      }
    }
    const cgNames = [...new Set((state.data?.timeline?.cgs ?? []).map((item) => item.name))];
    const bgmNames = [...new Set(frames.map((frame) => (frame.stage?.bgm && !frame.stage.bgm.stop ? frame.stage.bgm.name : null)).filter(Boolean))];
    const sfxNames = [...new Set(frames.flatMap((frame) => (frame.effect?.sfx ?? []).map((item) => item.name)))];

    const section = (title, rows, hint) =>
      h('div', { class: 'gal-section' }, h('div', { class: 'gal-section-title' }, title), hint ? h('div', { class: 'gal-note' }, hint) : null, rows.length ? h('div', {}, ...rows) : h('div', { class: 'gal-note' }, '这部戏里还没用到。'));

    return h(
      'div',
      { class: 'gal-tab' },
      h('div', { class: 'gal-note' }, '剧本里写的是名字，这里把名字接到 ComfyUI 出好的图上 —— 挂一次，整部戏通用。'),
      section('背景', bgNames.map((name) => castRow(`[场景: ${name}]`, 'backgrounds', name, state.imageAssets))),
      section('立绘 / 表情', [...charKeys.values()].map((character) => castRow(`${character.name}${character.emotion ? ` · ${character.emotion}` : ''}`, 'portraits', character.key, state.imageAssets, `站位 ${character.position}`))),
      section('CG', cgNames.map((name) => castRow(`[CG: ${name}]`, 'cg', name, state.imageAssets))),
      section('BGM', bgmNames.map((name) => castRow(`[BGM: ${name}]`, 'bgm', name, state.audioAssets))),
      section('音效', sfxNames.map((name) => castRow(`[音效: ${name}]`, 'sfx', name, state.audioAssets))),
    );
  }

  function transitionTab() {
    const conf = state.data?.show?.transition ?? {};
    const catalog = state.data?.catalogs?.transitions ?? [{ id: 'none', title: '不转场' }];
    const effectSelect = h('select', {}, ...catalog.map((item) => h('option', { value: item.id }, `${item.title}${item.summary ? ` — ${item.summary}` : ''}`)));
    effectSelect.value = conf.effect ?? 'fade-black';
    effectSelect.addEventListener('change', (event) => void saveShow({ transition: { effect: event.target.value } }));
    return h(
      'div',
      { class: 'gal-tab' },
      h('div', { class: 'gal-note' }, '转场有两种触发：剧本里写 [转场: 黑屏 800]，或者地点 / 时间变了自动放一次。'),
      field('效果', effectSelect),
      slider('时长', {
        min: 200, max: 3000, step: 100, value: conf.durationMs ?? 700,
        format: (value) => `${value} ms`,
        onInput: (value) => { state.data.show.transition.durationMs = value; },
        onChange: (value) => void saveShow({ transition: { durationMs: value } }),
      }),
      (() => {
        const auto = h('input', { type: 'checkbox' });
        auto.checked = conf.onSceneChange !== false;
        auto.addEventListener('change', (event) => void saveShow({ transition: { onSceneChange: event.target.checked } }));
        return field('地点 / 时间变了就自动放一次', auto);
      })(),
      h('button', { class: 'btn', onclick: () => playTransition(conf.effect, conf.durationMs) }, '▶ 试一下'),
    );
  }

  function toolsTab() {
    const frames = state.frames;
    return h(
      'div',
      { class: 'gal-tab' },
      h('div', { class: 'gal-section-title' }, '这部戏'),
      h('div', { class: 'gal-row' },
        h('button', { class: 'btn', onclick: () => { closeMenu(); gotoLine(0); } }, '⏮ 从头演'),
        h('button', { class: 'btn', onclick: () => { closeMenu(); gotoLine(frames.length - 1); } }, '⏭ 跳到最新一句'),
        h('button', { class: 'btn', onclick: () => { closeMenu(); setSkip(true); } }, '⏩ 快进到最新'),
      ),
      h('div', { class: 'gal-section-title' }, '素材与导出'),
      h('div', { class: 'gal-row' },
        h('button', { class: 'btn primary', disabled: state.busy, onclick: () => void generateBackground() }, '🖼 按当前场景出一张背景'),
        h('button', { class: 'btn', onclick: () => void exportRenpy() }, "⬇ 导出 Ren'Py 工程"),
        h('button', { class: 'btn', onclick: () => ctx?.navigate?.('chat') }, '去对话页继续写'),
      ),
      h('div', { class: 'gal-note' }, `背景 ${state.data?.counts?.backgrounds ?? 0} 张 · 立绘 ${state.data?.counts?.portraits ?? 0} 组 · CG ${state.data?.counts?.cgs ?? 0} 张 · 台词 ${frames.length} 句`),
      h('div', { class: 'gal-section-title' }, '怎么让剧本指挥舞台'),
      h('div', { class: 'gal-note', style: { whiteSpace: 'pre-wrap' } }, [
        '[场景: 旧书馆]        切背景',
        '[立绘: 诗音 微笑 左]  出场 / 换表情 / 站位；[立绘: 诗音 -] 退场',
        '[BGM: 雨夜]           换曲（[BGM: 停] 停掉）',
        '[音效: 开门]',
        '[CG: 初雪]            弹全屏 CG，同时解锁回廊',
        '[转场: 黑屏 800]',
        '[结局: 恋人线]',
        '',
        '这些标记人写、AI 写都认；AI 写的时候可以在角色卡的前置词里贴一句"用 [场景: …] 指挥舞台"。',
      ].join('\n')),
    );
  }

  // ------------------------------------------------------------------ 外壳

  function buildShell() {
    const bg = h('img', { class: 'gal-bg', alt: '背景' });
    const bgEmpty = h('div', { class: 'gal-bg-empty' });
    const chars = h('div', { class: 'gal-chars' });
    const cgImg = h('img', { class: 'gal-cg-img', alt: 'CG' });
    const cgName = h('div', { class: 'gal-cg-name' });
    const cg = h(
      'div',
      { class: 'gal-cg', hidden: true },
      h('div', { class: 'gal-cg-inner' }, cgImg, cgName),
    );
    const namebox = h('div', { class: 'gal-namebox' });
    const text = h('div', { class: 'gal-text' });
    const next = h('div', { class: 'gal-next' }, '▼');
    const win = h('div', { class: 'gal-window' }, namebox, text, next);
    const choices = h('div', { class: 'gal-choices', hidden: true });
    const titlecard = h('div', { class: 'gal-titlecard' });
    const badge = h('div', { class: 'gal-badge' });
    const skipBadge = h('div', { class: 'gal-badge gal-flag', hidden: true }, '跳过中 ▸▸▸');
    const autoBadge = h('div', { class: 'gal-badge gal-flag', hidden: true }, '自动播放 ▸');

    const stage = h(
      'div',
      { class: 'gal-stage', tabindex: '0' },
      bg,
      bgEmpty,
      chars,
      cg,
      h('div', { class: 'gal-topbar' }, badge, h('div', { class: 'gal-topright' }, skipBadge, autoBadge)),
      choices,
      titlecard,
      win,
    );

    stage.addEventListener('click', () => advance());
    stage.addEventListener('contextmenu', (event) => { event.preventDefault(); openMenu('save'); });
    stage.addEventListener(
      'wheel',
      (event) => {
        if (!state.frames.length) return;
        event.preventDefault();
        step(event.deltaY < 0 ? -1 : 1);
      },
      { passive: false },
    );
    stage.addEventListener('mousedown', (event) => { if (event.button === 1) { event.preventDefault(); toggleHidden(); } });

    const progress = h('span', { class: 'gal-progress' });
    const quickButtons = [
      ['回退', () => step(-1)],
      ['履历', () => openMenu('history')],
      ['跳过', () => setSkip(!state.skip)],
      ['自动', () => setAuto(!state.auto)],
      ['存档', () => openMenu('save')],
      ['快存', () => void quickSave()],
      ['快读', () => quickLoad()],
      ['设置', () => openMenu('prefs')],
      ['隐藏', () => toggleHidden()],
      ['菜单', () => openMenu('tools')],
    ];
    const quick = h(
      'div',
      { class: 'gal-quick' },
      ...quickButtons.map(([label, fn]) => h('button', { class: 'gal-quick-btn', type: 'button', onclick: (event) => { event.stopPropagation(); fn(); } }, label)),
      progress,
    );

    const nav = h(
      'div',
      { class: 'gal-menu-nav' },
      ...MENU_TABS.map((tab) => h('button', { class: 'gal-menu-tab', dataset: { tab: tab.id }, onclick: () => openMenu(tab.id) }, tab.title)),
    );
    const menuBody = h('div', { class: 'gal-menu-body' });
    const overlay = h(
      'div',
      { class: 'gal-menu', hidden: true, onclick: (event) => { if (event.target === overlay) closeMenu(); } },
      h(
        'div',
        { class: 'gal-menu-panel' },
        h('div', { class: 'gal-menu-head' }, h('span', {}, '菜单'), h('button', { class: 'gal-menu-close', onclick: () => closeMenu() }, '✕')),
        h('div', { class: 'gal-menu-main' }, nav, menuBody),
      ),
    );

    const picker = h(
      'select',
      {
        onchange: (event) => {
          state.chatId = event.target.value;
          void loadStage();
        },
      },
      ...state.chats.map((chat) => h('option', { value: chat.id }, `${chat.isGroup ? '👥 ' : '💬 '}${chat.title}`)),
    );
    picker.value = state.chatId;

    const toolbar = h(
      'div',
      { class: 'gal-toolbar' },
      h('div', { class: 'gal-toolbar-left' }, statusChip(module.status), picker),
      h('div', { class: 'gal-toolbar-right' },
        h('button', { class: 'btn', onclick: () => openMenu('cast') }, '🧩 素材绑定'),
        h('button', { class: 'btn primary', disabled: state.busy, onclick: () => void generateBackground() }, '🖼 出一张背景'),
        h('button', { class: 'btn', onclick: () => void exportRenpy() }, "⬇ Ren'Py"),
      ),
    );

    const shell = h('div', { class: 'gal-shell' }, toolbar, stage, quick, overlay);
    return { shell, stage, win, bg, bgEmpty, chars, cg, cgImg, cgName, namebox, text, next, choices, titlecard, badge, skipBadge, autoBadge, progress, quick, menu: { overlay, nav, body: menuBody } };
  }

  // ------------------------------------------------------------------ 加载

  async function loadStage({ keepLine = false, keepAssets = false } = {}) {
    if (!state.dom) host.replaceChildren(loading());
    try {
      const data = await get(`/api/staging/${state.chatId}`);
      state.data = data;
      state.frames = data.timeline?.frames ?? [];
      state.unlocked = new Set((data.unlocks ?? []).map((item) => item.name));
      state.endingHit = null;
      state.routeEntered = null;
      const last = Math.max(0, state.frames.length - 1);
      const line = keepLine === true ? Math.min(state.line, last) : keepLine === 'end' ? last : 0;

      state.dom = buildShell();
      host.replaceChildren(state.dom.shell);
      state.line = line;
      state.hidden = false;
      paintStage();
      if (!state.frames.length) {
        state.dom.text.textContent = '这条对话还没有可以演的台词：去「对话」页说两句，或者写一段带 [场景: …] 标记的剧本。';
      } else {
        gotoLine(line, { quiet: true });
      }
      applyAudio();
      if (!keepAssets || !state.imageAssets.length) await refreshAssets();
    } catch (err) {
      host.replaceChildren(panel('演出', null, errorBox(err, { onRetry: () => loadStage({ keepLine: true }) })));
      state.dom = null;
    }
  }

  async function generateBackground() {
    if (state.busy) return;
    state.busy = true;
    try {
      const run = await post(`/api/staging/${state.chatId}/generate`, { kind: 'background' });
      toast('已经提交给 ComfyUI，跑完会自动出现在舞台上');
      if (run.status === 'pending-client') {
        const { runClientImage } = await import('../ui/comfy-client.mjs');
        const config = await get('/api/comfy/config').catch(() => null);
        await runClientImage({
          baseUrl: config?.settings?.['comfy.baseUrl'],
          workflowId: run.workflowId,
          runId: run.id,
          chatId: state.chatId,
          messageId: run.messageId ?? null,
          prompt: run.values?.prompt ?? null,
          reason: 'staging',
        });
        await loadStage({ keepLine: true });
        toast('背景好了');
        return;
      }
      for (let i = 0; i < 40; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const one = await get(`/api/comfy/runs/${run.id}`);
        if (one.status === 'done') {
          await loadStage({ keepLine: true });
          toast('背景好了');
          break;
        }
        if (one.status === 'error') {
          toast(one.error ?? '出图失败', { tone: 'warn', duration: 5000 });
          break;
        }
      }
    } catch (err) {
      toastError(err);
    } finally {
      state.busy = false;
    }
  }

  async function exportRenpy() {
    try {
      const response = await fetch(`/api/staging/${state.chatId}/renpy`);
      if (!response.ok) throw new Error(`导出失败（${response.status}）`);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = h('a', { href: url, download: `silver-tavern-renpy-${state.chatId}.zip` });
      document.body.append(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast("Ren'Py 工程已下载（解压后放进 Ren'Py 工程即可跑）");
    } catch (err) {
      toastError(err);
    }
  }

  // ------------------------------------------------------------------ 交互

  function onKeyDown(event) {
    if (!el.isConnected) return;
    if (!state.dom) return;
    const tag = String(event.target?.tagName ?? '').toLowerCase();
    if (['input', 'textarea', 'select'].includes(tag) || event.target?.isContentEditable) return;

    if (state.menuTab) {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeMenu();
      }
      return;
    }

    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      advance();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      openMenu('save');
      return;
    }
    if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
      event.preventDefault();
      step(-1);
      return;
    }
    if (event.key === 'ArrowRight' || event.key === 'PageDown') {
      event.preventDefault();
      step(1);
      return;
    }
    if (event.key === 'h' || event.key === 'H') {
      toggleHidden();
      return;
    }
    if (event.key === 'Control') setSkip(true);
  }

  function onKeyUp(event) {
    if (!el.isConnected) return;
    if (event.key === 'Control' && state.skip) setSkip(false);
  }

  // ------------------------------------------------------------------ 挂载

  async function mount() {
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
    host.replaceChildren(loading());
    try {
      state.chats = (await get('/api/chats')).items ?? [];
      if (!state.chats.length) {
        host.replaceChildren(panel('演出', null, emptyState({ icon: '🎭', title: '还没有对话', desc: '先去「对话」建一个，再回来看演出。' })));
        return;
      }
      if (!state.chatId || !state.chats.some((chat) => chat.id === state.chatId)) {
        state.chatId = state.chats[0].id;
      }
      await refreshAssets();
      await loadStage();
    } catch (err) {
      host.replaceChildren(panel('演出', null, errorBox(err, { onRetry: () => mount() })));
    }
  }

  el.append(host);
  void ctx;
  return { el, mount };
}
