/**
 * 玩卡区四个视图（对话 / 群聊 / 场景状态 / 叙事）共用的零件。
 *
 * 这里只放"和界面拼装有关"的东西：拉对话列表、画一条消息、开一个输入弹窗、
 * 起一次 SSE。业务判断都在服务端，前端不做二次逻辑。
 */

import { h } from '../core/dom.mjs';
import { get, post, streamPost } from '../core/api.mjs';
import { openModal } from '../ui/modal.mjs';
import { field, emptyState } from '../ui/components.mjs';
import { toast } from '../ui/toast.mjs';
import { t } from '../core/i18n.mjs';

export async function fetchChats({ group = null, search = '', characterId = null } = {}) {
  const params = new URLSearchParams();
  if (group !== null) params.set('group', String(group));
  if (search) params.set('search', search);
  if (characterId) params.set('characterId', String(characterId));
  const query = params.toString();
  const data = await get(`/api/chats${query ? `?${query}` : ''}`);
  return data.items ?? [];
}

/** 卡库列表（读不到就返回空，别让对话框打不开）。 */
export async function loadLibraryCards() {
  try {
    const data = await get('/api/characters?limit=300');
    return data.items ?? [];
  } catch {
    return [];
  }
}

/**
 * "从卡库选一张"的下拉。选中的是 characterId，卡数据由服务端补；
 * 选空表示走手动填的临时卡。onPick(null) 表示切回手动。
 */
export function libraryCardSelect(cards, { onPick = null, noneLabel = '手动填（不用卡库）' } = {}) {
  const select = h(
    'select',
    {},
    h('option', { value: '' }, noneLabel),
    cards.map((card) => h('option', { value: card.id }, card.favorite ? `★ ${card.name}` : card.name)),
  );
  select.addEventListener('change', () => onPick?.(cards.find((card) => card.id === select.value) ?? null));
  return select;
}

export function formatTime(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return sameDay
    ? date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function roleClass(role) {
  if (role === 'user') return 'user';
  if (role === 'system' || role === 'narrator') return 'system';
  return 'char';
}

/**
 * 这轮是不是被"回复上限"硬截断的。
 * 三家的写法不一样：OpenAI 系 finish_reason='length'，Anthropic stop_reason='max_tokens'，
 * Gemini finishReason='MAX_TOKENS'。统一小写后判断。
 */
export function truncatedByLimit(message) {
  const finish = String(message?.extra?.finish ?? '').trim().toLowerCase();
  return finish === 'length' || finish === 'max_tokens' || finish === 'max_output_tokens';
}

/**
 * 消息上绑的图片就是素材库里的 assetId（见 server/runtime.mjs 的 attachImages）。
 * 统一在这里拼地址，别的地方不要自己写 `/api/assets/...`。
 *
 * 有意偏离：SillyTavern 直接在消息里存 base64 / 相对路径，我们把字节放在素材库、
 * 消息只存 id，所以同一张图被多条消息引用时只落一份。
 */
export function assetFileUrl(assetId) {
  return `/api/assets/${encodeURIComponent(String(assetId))}/file`;
}

/** 消息 extra.images 既可能是 id 字符串，也可能是 { assetId } 对象，统一取 id。 */
export function messageImageIds(message) {
  const raw = message?.extra?.images;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => (typeof entry === 'string' ? entry : entry?.assetId ?? entry?.id ?? null))
    .filter((id) => id !== null && id !== undefined && String(id).length);
}

/** 点开大图。缩略图进不去的地方都在这里看。 */
export function openImageViewer(assetId, { name = '', alt = '出图' } = {}) {
  const src = assetFileUrl(assetId);
  openModal({
    title: name || '图片',
    width: 'min(940px, 94vw)',
    body: h(
      'div',
      { class: 'image-viewer' },
      h('img', { class: 'image-viewer-img', src, alt }),
      h(
        'div',
        { class: 'image-viewer-foot' },
        h('span', { class: 'hint' }, name || ''),
        h('a', { class: 'btn', href: src, target: '_blank', rel: 'noreferrer', download: '' }, '在新标签打开 / 另存'),
      ),
    ),
  });
}

/** 找到这张图是哪次出的（用来重出 / 改提示词）。 */
async function runForImage(assetId) {
  return get(`/api/comfy/runs/by-asset/${encodeURIComponent(assetId)}`);
}

/** 双击 = 拿同一份工作流重出一张（种子自动换）。 */
async function rerunImage(assetId, label) {
  try {
    const found = await runForImage(assetId);
    await post(`/api/comfy/runs/${found.run.id}/rerun`, {});
    toast(`正在重出：${label}`);
  } catch (err) {
    toast(String(err?.message ?? err), { tone: 'warn', duration: 4200 });
  }
}

/** 长按 / 点 ✎ = 改提示词再重出。 */
async function editAndRerunImage(assetId, label) {
  let found = null;
  try {
    found = await runForImage(assetId);
  } catch (err) {
    toast(String(err?.message ?? err), { tone: 'warn', duration: 4200 });
    return;
  }
  let result = null;
  const input = h('textarea', { rows: 5, value: found.positive ?? '' });
  openModal({
    title: `改提示词重出 · ${label}`,
    body: h(
      'div',
      {},
      h('div', { class: 'hint', style: { marginBottom: '6px' } }, '这是当时那张图的正向提示词。改完「重出」会换一个种子重新画一张。'),
      field('正向提示词', input),
    ),
    actions: [
      { label: '取消', onClick: () => { result = null; } },
      { label: '重出', primary: true, onClick: () => { result = input.value; } },
    ],
    onClose: () => {
      if (result === null) return;
      post(`/api/comfy/runs/${found.run.id}/rerun`, { prompt: result })
        .then(() => toast('正在按新提示词重出'))
        .catch((err) => toast(String(err?.message ?? err), { tone: 'warn', duration: 4200 }));
    },
  });
}

/** 长按（触屏）/ 按住（鼠标）：550ms 算长按；触发后把紧随其后的那次点击吞掉。 */
function attachLongPress(el, onLong) {
  if (!el?.addEventListener) return;
  let timer = null;
  let fired = false;
  el.addEventListener('pointerdown', () => {
    fired = false;
    timer = setTimeout(() => {
      fired = true;
      onLong();
    }, 550);
  });
  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  el.addEventListener('pointerup', cancel);
  el.addEventListener('pointerleave', cancel);
  el.addEventListener('pointercancel', cancel);
  el.addEventListener(
    'click',
    (event) => {
      if (!fired) return;
      event.preventDefault();
      event.stopPropagation();
      fired = false;
    },
    true,
  );
}

/** 缩略图一排。撑不破气泡：固定高、可横向滚动。点开大图 / 双击重出 / 长按改提示词。 */
function imageStrip(message) {
  const ids = messageImageIds(message);
  if (!ids.length) return null;
  return h(
    'div',
    { class: 'msg-images' },
    ids.map((id, index) => {
      const label = `${message.name || '角色'} 的图 ${index + 1}`;
      const open = h(
        'button',
        {
          class: 'msg-thumb',
          title: '点开看大图 · 双击重出 · 长按改提示词',
          onclick: () => openImageViewer(id, { name: label }),
          ondblclick: () => void rerunImage(id, label),
        },
        h('img', { src: assetFileUrl(id), alt: '出图', loading: 'lazy' }),
      );
      attachLongPress(open, () => void editAndRerunImage(id, label));
      return h(
        'div',
        { class: 'msg-thumb-wrap' },
        open,
        h(
          'button',
          {
            class: 'msg-thumb-edit',
            title: '改提示词重出',
            onclick: (event) => {
              event.stopPropagation();
              void editAndRerunImage(id, label);
            },
          },
          '✎',
        ),
      );
    }),
  );
}

function isPendingRun(run) {
  // pending-client 也算"还没出完"：浏览器直连模式下它在等前端来领。
  return run?.status === 'queued' || run?.status === 'running' || run?.status === 'pending-client';
}

export function hasPendingRuns(runs) {
  return Array.isArray(runs) && runs.some(isPendingRun);
}

/**
 * 出图状态条：排队 / 进度 / 失败原因。done 的图已经在缩略图里，不再重复。
 * `onRunAction(action, run)` 由视图决定怎么处理（目前只有"重试"）。
 */
function runStatusStrip(runs, { onRunAction = null } = {}) {
  const list = Array.isArray(runs) ? runs.filter((run) => isPendingRun(run) || run.status === 'error') : [];
  if (!list.length) return null;
  return h(
    'div',
    { class: 'msg-runs' },
    list.map((run) => {
      if (isPendingRun(run)) {
        const percent = Number.isFinite(Number(run.percent)) ? Math.max(0, Math.min(100, Math.round(Number(run.percent)))) : null;
        return h(
          'div',
          { class: 'msg-run' },
          h('span', { class: 'chip partial small' }, run.status === 'pending-client' ? '待浏览器出图…' : run.status === 'queued' ? '出图排队中…' : '出图中…'),
          h('div', { class: 'msg-run-bar' }, h('div', { class: 'msg-run-fill', style: { width: `${percent === null ? 8 : Math.max(8, percent)}%` } })),
          h('span', { class: 'hint' }, percent === null ? (run.workflowName ?? '') : `${percent}%`),
        );
      }
      return h(
        'div',
        { class: 'msg-run msg-run-error' },
        h('span', { class: 'chip error small' }, '出图失败'),
        h('span', { class: 'msg-run-reason' }, run.error || 'ComfyUI 没给出原因，去「工具箱 → ComfyUI」看看连接状态'),
        onRunAction ? h('button', { class: 'link-btn', onclick: () => onRunAction('retry', run) }, t('btn.retry')) : null,
      );
    }),
  );
}

/**
 * 一条消息。`onAction(action, message)` 由视图处理按钮。
 * `live: true` 时是流式中的临时气泡，不显示按钮。
 * `runs` 是这条消息绑定的出图记录（`GET /api/comfy/runs?chatId=`），用来显示进度与失败原因。
 */
/**
 * 思考块拆分。这是 core/play/reasoning.mjs 的前端精简版 ——
 * 前端不 import core/，所以规则留一份；改规则记得两边一起改。
 */
function splitThinking(text) {
  let content = String(text ?? '');
  let reasoning = '';
  for (const [open, close] of [[/<think(?:ing)?>/i, /<\/think(?:ing)?>/i], [/<reasoning>/i, /<\/reasoning>/i], [/<analysis>/i, /<\/analysis>/i]]) {
    const start = content.search(open);
    if (start === -1) continue;
    const after = content.slice(start).replace(open, '');
    const end = after.search(close);
    reasoning += (reasoning ? '\n' : '') + (end === -1 ? after : after.slice(0, end)).trim();
    content = (content.slice(0, start) + (end === -1 ? '' : after.slice(end).replace(close, ''))).trim();
  }
  if (!reasoning) {
    const lines = content.split('\n');
    if (lines.length >= 2 && /^(?:思考过程|推理过程|内心思考|thinking|reasoning)\s*[:：]\s*/i.test(lines[0].trim())) {
      const rest = lines.slice(1);
      const end = rest.findIndex((line) => /^(?:正式回复|回复|正文|answer|output)\s*[:：]\s*/i.test(line.trim()));
      if (end !== -1) {
        reasoning = rest.slice(0, end).join('\n').trim();
        content = rest.slice(end).map((line) => line.replace(/^(?:正式回复|回复|正文|answer|output)\s*[:：]\s*/i, '')).join('\n').trim();
      }
    }
  }
  return { reasoning: reasoning.trim(), content: content.trim() };
}

/**
 * 正文的「展示糖」。
 *
 * 酒馆把消息当 HTML 渲染，所以预设作者会往正文里塞 `<details><summary>` 折叠、
 * 以及 `<game>` / `<background>` 这类包装标签。我们这边正文是纯文本，直接显示就会
 * 看到一堆标签源码。这里把**认识**的标签变成真元素，不认识的标签原样留着
 * （宁可显示出来，也不吃掉用户的内容）。
 */
const WRAPPER_TAG_LINE = /^\s*<\/?(?:game|g|background|bg|story|正文)\s*>\s*$/i;

export function displayParts(text) {
  const source = String(text ?? '');
  const parts = [];
  const pushText = (chunk) => {
    const cleaned = chunk
      .split('\n')
      .filter((line) => !WRAPPER_TAG_LINE.test(line))
      .join('\n')
      .replace(/^\n+|\n+$/g, '');
    if (cleaned.trim()) parts.push(cleaned);
  };

  const pushOptions = (blockBody) => {
    const items = [...String(blockBody).matchAll(/<option\b[^>]*>([\s\S]*?)<\/option>/gi)]
      .map((item) => item[1].replace(/<[^>]*>/g, ' ').trim())
      .filter(Boolean);
    if (!items.length) return;
    parts.push(h('div', { style: { marginTop: '6px', opacity: '0.9' } }, '可选的行动：'));
    parts.push(h('div', {}, ...items.map((item, index) => h('div', {}, `${index + 1}. ${item}`))));
  };

  const pushFold = (title, bodyText) => {
    parts.push(
      h(
        'details',
        { class: 'msg-thinking' },
        h('summary', {}, title || '详情'),
        String(bodyText ?? '').trim()
          ? h('div', { style: { whiteSpace: 'pre-wrap', opacity: '0.85', marginTop: '4px' } }, String(bodyText).trim())
          : null,
      ),
    );
  };
  const strip = (html) => String(html ?? '').replace(/<[^>]*>/g, '').trim();

  const pushDetails = (inner) => {
    const summary = /<summary\b[^>]*>([\s\S]*?)<\/summary>/i.exec(inner);
    if (!summary) return pushFold('详情', strip(inner));
    const bodyText = inner.slice(0, summary.index) + inner.slice(summary.index + summary[0].length);
    pushFold(strip(summary[1]), strip(bodyText));
  };

  // 一条正则认三种块，按出现顺序处理。
  // 裸 <summary> 也要认：预设的"小总结"在**存下来的正文**里就是一个裸的 summary，
  // 只有走到显示正则那一步才会被包成 <details>（而那条我们这条消息里用不上）。
  const pattern = /<details\b[^>]*>([\s\S]*?)<\/details>|<options\b[^>]*>([\s\S]*?)<\/options>|<summary\b[^>]*>([\s\S]*?)<\/summary>/gi;
  let last = 0;
  let match;
  while ((match = pattern.exec(source))) {
    pushText(source.slice(last, match.index));
    if (match[2] !== undefined) pushOptions(match[2]);
    else if (match[3] !== undefined) pushFold('摘要', strip(match[3]));
    else pushDetails(match[1]);
    last = match.index + match[0].length;
  }
  pushText(source.slice(last));
  return parts.length ? parts : [source];
}

export function messageBubble(message, { onAction = null, live = false, showModel = true, runs = [], onRunAction = null } = {}) {
  const cls = roleClass(message.role);
  const badges = [];
  if (message.isSystem) badges.push(h('span', { class: 'chip stub' }, '只展示不发送'));
  if (message.hidden) badges.push(h('span', { class: 'chip stub' }, '隐藏'));
  if (message.role === 'narrator') badges.push(h('span', { class: 'chip partial' }, '旁白'));
  // 被回复上限截断的：以前一点提示都没有，用户只会觉得"模型写一半停了"
  const truncated = truncatedByLimit(message);
  if (truncated) badges.push(h('span', { class: 'chip partial' }, '被截断'));

  const meta = [];
  if (message.tokens) meta.push(`≈${message.tokens} tok`);
  if (showModel && message.model) meta.push(message.model);
  if (!live) meta.push(formatTime(message.createdAt));

  // "只改显示"的正则脚本结果存在 extra.displayContent，渲染优先用它（进提示词的还是 content）。
  // displayContent 是"只改显示"的正则跑出来的。预设里有一条会把 <options> 渲染成
  // **一整份 HTML 文档**（实测 68 KB）——那是给"把消息当 HTML 渲染"的客户端看的，
  // 我们显示不了，老数据落到这里就会看到一堆源码。看到整份 HTML 就退回原文。
  const displayContent = String(message.extra?.displayContent ?? '');
  const useDisplay = displayContent && !/<!DOCTYPE\s+html|<html[\s>]/i.test(displayContent);
  const raw = String((useDisplay ? displayContent : '') || message.content || '');
  const parsed = splitThinking(raw);
  // 思维链有两个来源：正文里带的标签（老写法 / 预设），以及生成时单独存进 extra.reasoning 的
  // （提供方给的和 <think_nya~> 这类标签摘出来的）。两个都显示，默认折起来。
  const reasoning = [parsed.reasoning, String(message.extra?.reasoning ?? '')].filter(Boolean).join('\n\n').trim();
  // 思维链的中文译文（extra.reasoningZh）：有译文就默认显示译文，"看原文"能切回英文/原文。
  const reasoningZh = String(message.extra?.reasoningZh ?? '').trim();
  const content = parsed.content;
  const body = h('div', { class: 'msg-body' });
  if (reasoning) {
    // 思考过程默认折叠：调参数时想看，平时只关心正文。它不进上下文（生成时已经摘掉了）。
    const blocks = [];
    if (reasoningZh) {
      const zhBox = h('div', { class: 'msg-thinking-zh', style: { whiteSpace: 'pre-wrap', marginTop: '4px' } }, reasoningZh);
      const rawBox = h(
        'div',
        { style: { whiteSpace: 'pre-wrap', opacity: '0.6', marginTop: '4px', display: 'none' } },
        reasoning,
      );
      const toggle = h(
        'button',
        {
          class: 'link-btn',
          onclick: () => {
            const showingZh = zhBox.style.display !== 'none';
            zhBox.style.display = showingZh ? 'none' : '';
            rawBox.style.display = showingZh ? '' : 'none';
            toggle.textContent = showingZh ? '看译文' : '看原文';
          },
        },
        '看原文',
      );
      blocks.push(zhBox, rawBox, h('div', { style: { marginTop: '6px' } }, toggle));
    } else {
      blocks.push(h('div', { style: { whiteSpace: 'pre-wrap', opacity: '0.75', marginTop: '4px' } }, reasoning));
      if (onAction) {
        blocks.push(
          h(
            'div',
            { style: { marginTop: '6px' } },
            h('button', { class: 'link-btn', onclick: () => onAction('translate-thinking', message) }, '🌐 译成中文'),
          ),
        );
      }
    }
    body.append(
      h(
        'details',
        { class: 'msg-thinking' },
        h('summary', {}, `思考过程（${reasoning.length} 字${reasoningZh ? ' · 已译中文' : ''}，点开看；不进上下文）`),
        ...blocks,
      ),
    );
  }
  // 工具调用：这一轮模型调了哪些工具、参数是什么。预设把「工具调用即正文」打开时
  // （extra.toolCallsHidden），正文本身就是那次调用，不再重复摆一块。
  const toolRounds = Array.isArray(message.extra?.toolCalls) ? message.extra.toolCalls : [];
  if (toolRounds.length && !message.extra?.toolCallsHidden) {
    const lines = [];
    for (const round of toolRounds) {
      for (const call of round?.calls ?? []) {
        const args = call?.arguments && Object.keys(call.arguments).length ? JSON.stringify(call.arguments) : '（无参数）';
        lines.push(`${call?.name ?? '工具'}  ${args}`);
      }
    }
    if (lines.length) {
      body.append(
        h(
          'details',
          { class: 'msg-thinking' },
          h('summary', {}, `工具调用（${lines.length} 次，点开看；结果已经回填给模型）`),
          h('div', { style: { whiteSpace: 'pre-wrap', opacity: '0.75', marginTop: '4px' } }, lines.join('\n')),
        ),
      );
    }
  }
  // 正文里的展示标签（<details> 折叠、<game> 包装）转成真元素，别让用户看到标签源码
  body.append(h('div', {}, ...displayParts(content)));
  const swipes = Array.isArray(message.swipes) ? message.swipes : [];
  const swipeId = Number(message.swipeId ?? 0) || 0;
  const bubble = h(
    'article',
    { class: `msg ${cls}${live ? ' live' : ''}`, dataset: { messageId: message.id ?? '' } },
    h(
      'div',
      { class: 'msg-head' },
      h('span', { class: 'msg-name' }, message.name || (cls === 'user' ? '我' : cls === 'system' ? '旁白' : '角色')),
      ...badges,
      h('span', { class: 'msg-meta' }, meta.join(' · ')),
    ),
    body,
    truncated
      ? h(
          'div',
          { class: 'msg-warn' },
          '这条是被「回复上限」截断的（模型的结束原因是 length）。把输入框上方的「回复上限」调大，再点重新生成就能写完。',
        )
      : null,
    live ? null : imageStrip(message),
    live ? null : runStatusStrip(runs, { onRunAction }),
    !live && onAction && swipes.length > 1
      ? h(
          'div',
          { class: 'msg-swipes' },
          h('button', { class: 'link-btn', title: '上一版', onclick: () => onAction('swipe-prev', message) }, '◀'),
          h('span', { class: 'panel-note' }, `${Math.min(swipeId + 1, swipes.length)} / ${swipes.length}`),
          h('button', { class: 'link-btn', title: '下一版', onclick: () => onAction('swipe-next', message) }, '▶'),
        )
      : null,
  );

  if (!live && onAction) {
    const actions = [
      ['copy', t('btn.copy')],
      ['edit', t('btn.edit')],
      ['insert', t('btn.insert')],
      ['delete', t('btn.delete')],
      ['system', message.isSystem ? t('btn.unsystem') : t('btn.system')],
      ['hide', message.hidden ? t('btn.unhide') : t('btn.hide')],
      ['bookmark', '书签'],
    ];
    if (message.role === 'assistant') {
      actions.unshift(['new-swipe', '再来一版']);
      actions.unshift(['continue', t('btn.continue')]);
      actions.unshift(['regenerate', t('btn.regenerate')]);
    }
    bubble.append(
      h(
        'div',
        { class: 'msg-actions' },
        actions.map(([action, label]) =>
          h('button', { class: 'link-btn', onclick: () => onAction(action, message) }, label),
        ),
      ),
    );
  }
  return bubble;
}

export function emptyChatState(text = '还没有对话', action = null) {
  return emptyState({ icon: '💬', title: text, desc: '新建一个，或者导入酒馆的 JSONL 存档。', action });
}

/** 选一个对话。返回 { el, value }，切换时回调。 */
export function chatSelector(chats, { value = null, onChange, label = '对话' } = {}) {
  const select = h(
    'select',
    {
      onchange: (event) => onChange?.(event.target.value),
    },
    chats.length
      ? chats.map((chat) => h('option', { value: chat.id, selected: chat.id === value }, `${chat.isGroup ? '👥 ' : '💬 '}${chat.title}`))
      : h('option', { value: '' }, '（没有对话）'),
  );
  if (value) select.value = value;
  return { el: field(label, select), select };
}

/** 一个带多行输入的弹窗，返回 Promise<string|null>。 */
export function textPrompt({ title = '输入', label = '', value = '', placeholder = '', confirmLabel = '保存', extra = null } = {}) {
  return new Promise((resolve) => {
    let result = null;
    const textarea = h('textarea', { rows: 8, placeholder }, value);
    openModal({
      title,
      body: h('div', {}, label ? h('div', { class: 'hint', style: { marginBottom: '6px' } }, label) : null, textarea, extra),
      actions: [
        { label: '取消', onClick: () => { result = null; } },
        {
          label: confirmLabel,
          primary: true,
          onClick: () => {
            result = textarea.value;
          },
        },
      ],
      onClose: () => resolve(result),
    });
    setTimeout(() => textarea.focus(), 30);
  });
}

/** 一次 SSE 生成。返回事件列表，同时逐条回调。 */
export async function streamTurn(path, body, { onEvent = null, signal } = {}) {
  const events = [];
  await streamPost(
    path,
    body,
    (event, data) => {
      events.push({ event, data });
      onEvent?.(event, data);
    },
    { signal },
  );
  return events;
}

export function costText(cost) {
  if (cost === null || cost === undefined) return '未配置单价';
  return `¥${Number(cost).toFixed(4)}`;
}

/** 状态面板里的键值编辑表格：改一个键就回调一次。 */
export function kvEditor(obj, { onChange, keyPlaceholder = '键', valuePlaceholder = '值' } = {}) {
  const rows = h('div', { class: 'kv-editor' });
  const entries = Object.entries(obj ?? {});
  for (const [key, value] of entries) {
    rows.append(
      h(
        'div',
        { class: 'kv-row' },
        h('span', { class: 'mono' }, key),
        h('span', {}, String(value)),
        h('button', { class: 'link-btn', onclick: () => onChange?.('remove', key) }, '删'),
      ),
    );
  }
  const keyInput = h('input', { placeholder: keyPlaceholder });
  const valueInput = h('input', { placeholder: valuePlaceholder });
  rows.append(
    h(
      'div',
      { class: 'kv-row' },
      keyInput,
      valueInput,
      h(
        'button',
        {
          class: 'btn',
          onclick: () => {
            const key = keyInput.value.trim();
            if (!key) return;
            const raw = valueInput.value;
            const numeric = Number(raw);
            onChange?.('set', key, raw !== '' && Number.isFinite(numeric) ? numeric : raw);
            keyInput.value = '';
            valueInput.value = '';
          },
        },
        '加',
      ),
    ),
  );
  return rows;
}

export { post, toast };
