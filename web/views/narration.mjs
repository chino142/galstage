/**
 * 玩卡区 · 叙事控制。
 *
 * 候选行动（点一下就等于我发了那句话）、导演模式（旁白 / 导演指令 / 场外括号）、
 * 分支与存档（任意一条消息都能开一条独立发展的线）。
 */

import { h, statusChip } from '../core/dom.mjs';
import { get, post, put, del } from '../core/api.mjs';
import { panel, emptyState, errorBox, loading } from '../ui/components.mjs';
import { toast, toastError } from '../ui/toast.mjs';
import { fetchChats, streamTurn } from './playing-common.mjs';

export function createNarrationView(module, ctx = {}) {
  const el = h('div', { class: 'view' });
  const body = h('div', {});
  let chats = [];
  let chatId = null;
  let data = null; // { messages, options, branches }

  el.append(
    panel(
      module.title,
      null,
      h('div', { class: 'panel-note' }, module.summary),
      h('div', { style: { marginTop: '12px' } }, statusChip(module.status)),
    ),
    body,
  );

  async function refresh(preferred) {
    try {
      chats = await fetchChats();
    } catch (err) {
      body.replaceChildren(panel('叙事控制', null, errorBox(err, { onRetry: () => refresh() })));
      return;
    }
    if (!chats.length) {
      body.replaceChildren(panel('叙事控制', null, emptyState({ icon: '🎬', title: '还没有对话', desc: '先去「对话」建一个。' })));
      return;
    }
    await select(preferred ?? chatId ?? chats[0].id);
  }

  async function select(id) {
    chatId = id;
    body.replaceChildren(loading());
    try {
      const [messages, options, modes, chapters, endings, events] = await Promise.all([
        get(`/api/chats/${id}/messages`),
        get(`/api/narration/${id}/latest`),
        get('/api/narration/modes'),
        get(`/api/narration/${id}/chapters`).catch(() => ({ items: [] })),
        get(`/api/narration/${id}/endings`).catch(() => ({ items: [], routes: [] })),
        get(`/api/narration/${id}/events`).catch(() => null),
      ]);
      data = {
        messages: messages.items ?? [],
        options: options.options ?? [],
        modes: modes.items ?? [],
        chapters: chapters.items ?? [],
        endings: endings.items ?? [],
        routes: endings.routes ?? [],
        events,
        chat: chats.find((item) => item.id === id) ?? null,
      };
    } catch (err) {
      body.replaceChildren(panel('叙事控制', null, errorBox(err, { onRetry: () => refresh() })));
      return;
    }
    render();
  }

  async function generateOptions() {
    try {
      const result = await post(`/api/narration/${chatId}/options`, { count: 4 });
      data.options = result.items;
      data.chat = data.chat ?? chats.find((item) => item.id === chatId);
      render();
      toast(`生成了 ${result.items.length} 个候选行动（${result.source === 'model' ? '模型给的' : '兜底模板'}）`);
    } catch (err) {
      toastError(err);
    }
  }

  async function pickOption(option) {
    try {
      await streamTurn(`/api/chats/${chatId}/send`, { text: option.text });
      await select(chatId);
    } catch (err) {
      toastError(err);
    }
  }

  async function sendDirector(directorInput, modeSelect) {
    try {
      const result = await post(`/api/narration/${chatId}/director`, { text: directorInput.value, mode: modeSelect.value });
      directorInput.value = '';
      if (result.message) toast('已作为旁白插入');
      else toast('导演指令会只影响下一轮');
      await select(chatId);
    } catch (err) {
      toastError(err);
    }
  }

  async function makeBranch(messageSelect, labelInput) {
    try {
      const created = await post(`/api/narration/${chatId}/branch`, { messageId: messageSelect.value || null, label: labelInput.value });
      toast(`分支建好了：${created.title}`);
      chats = await fetchChats();
      await select(created.id);
    } catch (err) {
      toastError(err);
    }
  }

  function render() {
    const picker = h(
      'select',
      { onchange: (event) => select(event.target.value) },
      chats.map((item) => h('option', { value: item.id, selected: item.id === chatId }, `${item.isGroup ? '👥 ' : '💬 '}${item.title}`)),
    );

    const candidates = data.messages.filter((message) => message.role !== 'system').slice(-30);
    const messageSelect = h(
      'select',
      {},
      candidates.map((message) =>
        h('option', { value: message.id }, `#${message.seq} ${message.name || message.role}：${String(message.content).slice(0, 24)}`),
      ),
    );
    // 默认从最新一条往前分，符合"刚刚那段我想换个走向"的直觉。
    if (candidates.length) messageSelect.value = candidates[candidates.length - 1].id;
    const labelInput = h('input', { placeholder: '分支备注，例如：如果当时拒绝' });
    const directorInput = h('textarea', { rows: 3, placeholder: '以旁白 / 导演的身份插一句，指定剧情走向…' });
    const modeSelect = h(
      'select',
      {},
      data.modes.map((mode) => h('option', { value: mode.id, title: mode.summary }, `${mode.title} —— ${mode.summary}`)),
    );

    body.replaceChildren(
      panel('选一个对话', null, h('div', { class: 'field' }, h('label', {}, '对话'), picker)),
      panel(
        '候选行动',
        '点一下就等于我发了那句话',
        h(
          'div',
          { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '10px' } },
          data.options.length
            ? data.options.map((option) => h('button', { class: 'btn option-btn', onclick: () => pickOption(option) }, option.text))
            : h('span', { class: 'hint' }, '还没有候选行动，点「生成」让模型给几个。'),
        ),
        h('button', { class: 'btn primary', onclick: () => generateOptions() }, '✨ 生成候选行动'),
      ),
      panel(
        '导演模式',
        '旁白会留在历史里；导演指令只影响下一轮',
        h('div', { class: 'field' }, h('label', {}, '身份'), modeSelect),
        h('div', { class: 'field' }, h('label', {}, '要说的话'), directorInput),
        h('button', { class: 'btn primary', onclick: () => sendDirector(directorInput, modeSelect) }, '插入'),
      ),
      panel(
        '分支与存档',
        '任意一条消息都能开一条独立发展的线',
        h('div', { class: 'field' }, h('label', {}, '从哪条消息开始分'), messageSelect),
        h('div', { class: 'field' }, h('label', {}, '备注'), labelInput),
        h('button', { class: 'btn primary', onclick: () => makeBranch(messageSelect, labelInput) }, '开分支'),
        h('div', { class: 'hint', style: { marginTop: '10px' } }, '分支是复制一份新的对话（保留到选定消息为止），原来的线不受影响。'),
      ),
      chaptersPanel(candidates),
      endingsPanel(),
      eventsPanel(),
    );
  }

  // ---------------------------------------------------------------- 加分项：章节 / 结局 / 随机事件

  async function addChapter(titleInput, summaryInput, messageSelect) {
    const title = titleInput.value.trim();
    if (!title) return toast('给这一章起个名字', { tone: 'warn' });
    try {
      const result = await post(`/api/narration/${chatId}/chapters`, { title, summary: summaryInput.value.trim(), messageId: messageSelect.value || null });
      data.chapters = result.items;
      render();
      toast(`已记录章节：${title}`);
    } catch (err) {
      toastError(err);
    }
  }

  async function removeChapter_(chapterId, title) {
    try {
      await del(`/api/narration/${chatId}/chapters/${encodeURIComponent(chapterId)}`);
      const result = await get(`/api/narration/${chatId}/chapters`);
      data.chapters = result.items;
      render();
      toast(`已删除章节：${title}`);
    } catch (err) {
      toastError(err);
    }
  }

  function chaptersPanel(candidates) {
    const titleInput = h('input', { placeholder: '章节名，例如 第二章 雪夜相遇' });
    const summaryInput = h('input', { placeholder: '一句话摘要（可留空）' });
    const messageSelect = h('select', {}, candidates.map((message) => h('option', { value: message.id }, `#${message.seq} ${message.name || message.role}：${String(message.content).slice(0, 24)}`)));
    if (candidates.length) messageSelect.value = candidates[candidates.length - 1].id;
    return panel(
      '章节管理',
      `${data.chapters?.length ?? 0} 章`,
      (data.chapters ?? []).length
        ? h(
            'div',
            {},
            ...(data.chapters ?? []).map((chapter) =>
              h(
                'div',
                { class: 'tile', style: { marginBottom: '8px' } },
                h('div', { class: 'tile-title' }, chapter.title, h('span', { class: 'chip partial' }, `#${chapter.startIndex + 1} 起 · ${chapter.count} 条`)),
                chapter.summary ? h('div', { class: 'panel-note' }, chapter.summary) : null,
                h(
                  'div',
                  { style: { display: 'flex', gap: '8px', marginTop: '6px' } },
                  chapter.messageId
                    ? h('button', { class: 'btn', onclick: () => ctx.navigate?.('chat', `${chatId}:${chapter.messageId}`) }, '跳到这条')
                    : null,
                  h('button', { class: 'link-btn', onclick: () => removeChapter_(chapter.id, chapter.title) }, '删掉'),
                ),
              ),
            ),
          )
        : emptyState({ icon: '📖', title: '还没有分章', desc: '下面选一条消息，给它起个章节名。' }),
      h('div', { class: 'field' }, h('label', {}, '章节名'), titleInput),
      h('div', { class: 'field' }, h('label', {}, '摘要'), summaryInput),
      h('div', { class: 'field' }, h('label', {}, '从这条消息开始'), messageSelect),
      h('button', { class: 'btn primary', onclick: () => addChapter(titleInput, summaryInput, messageSelect) }, '＋ 记一章'),
    );
  }

  async function recordEnding_(route) {
    try {
      const result = await post(`/api/narration/${chatId}/endings`, { routeId: route.id, title: route.title, ending: route.ending });
      data.endings = result.items;
      render();
      toast(`已收进结局图鉴：${route.title}`);
    } catch (err) {
      toastError(err);
    }
  }

  function endingsPanel() {
    const routes = data.routes ?? [];
    const collected = new Map((data.endings ?? []).map((item) => [item.routeId, item]));
    return panel(
      '结局收集',
      `${collected.size} / ${routes.length || '—'}`,
      routes.length
        ? h(
            'div',
            {},
            ...routes.map((route) =>
              h(
                'div',
                { class: 'tile', style: { marginBottom: '8px' } },
                h('div', { class: 'tile-title' }, route.title, collected.has(route.id) ? h('span', { class: 'chip ready' }, '已收藏') : h('span', { class: 'chip planned' }, '未收集')),
                route.ending ? h('div', { class: 'panel-note' }, route.ending) : null,
                collected.has(route.id)
                  ? h('div', { class: 'hint' }, `记录于 ${String(collected.get(route.id).at ?? '').slice(0, 19)}`)
                  : h('button', { class: 'btn', style: { marginTop: '6px' }, onclick: () => recordEnding_(route) }, '记下这个结局'),
              ),
            ),
          )
        : emptyState({ icon: '🏁', title: '还没有定义路线', desc: '去「演出层 → 好感度与路线」加几条，这里就能收集结局。' }),
    );
  }

  async function saveEvents(patch) {
    try {
      const result = await put(`/api/narration/${chatId}/events`, patch);
      data.events = result;
      render();
      return result;
    } catch (err) {
      toastError(err);
      return data.events;
    }
  }

  async function rollEvent() {
    try {
      const result = await post(`/api/narration/${chatId}/events/roll`, {});
      if (result.fired) toast(`这次会触发：${result.event.title}`);
      else toast(`这次没触发（概率 ${Math.round((result.chance ?? 0) * 100)}%）`);
    } catch (err) {
      toastError(err);
    }
  }

  function eventsPanel() {
    const settings = data.events?.settings ?? { enabled: false, chance: 0.15, events: [] };
    const enabled = h('input', { type: 'checkbox' });
    enabled.checked = Boolean(settings.enabled);
    enabled.addEventListener('change', (event) => saveEvents({ enabled: event.target.checked }));
    const chance = h('input', { type: 'range', min: '0', max: '1', step: '0.05', style: { width: '160px' } });
    chance.value = String(settings.chance ?? 0.15);
    chance.addEventListener('change', (event) => saveEvents({ chance: Number(event.target.value) }));
    return panel(
      '随机事件',
      `${settings.events?.length ?? 0} 个事件`,
      h('div', { class: 'field' }, h('label', {}, '开启（每次我发言后按概率插一条旁白）'), enabled),
      h('div', { class: 'field' }, h('label', {}, `触发概率 ${Math.round((settings.chance ?? 0) * 100)}%`), chance),
      h(
        'div',
        {},
        ...(settings.events ?? []).map((event) => h('div', { class: 'tile', style: { marginBottom: '6px' } }, h('div', { class: 'tile-title' }, event.title, h('span', { class: 'chip partial' }, `权重 ${event.weight}`)), h('div', { class: 'panel-note' }, event.prompt))),
      ),
      h('button', { class: 'btn', style: { marginTop: '8px' }, onclick: () => rollEvent() }, '🎲 试掷一次'),
    );
  }

  async function mount() {
    await refresh();
  }

  return { el, mount };
}
