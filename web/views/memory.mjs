/**
 * 记忆：小总结 / 大总结 / 结构化档案。
 * 按对话看记忆，能生成、编辑、钉住、删除；下面还有一条按时间排的时间线与热度。
 */

import { h, statusChip } from '../core/dom.mjs';
import { get, post, put, del } from '../core/api.mjs';
import { panel, table, emptyState, errorBox, field, kv } from '../ui/components.mjs';
import { openModal, confirmDialog } from '../ui/modal.mjs';
import { toast, toastError } from '../ui/toast.mjs';

export function createMemoryView(module, ctx) {
  const el = h('div', { class: 'view' });
  const host = h('div', {});
  const state = { chats: [], chatId: '', items: [], profiles: [], layers: [], sort: 'time' };

  el.append(
    panel(
      module.title,
      null,
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } }, statusChip(module.status), h('span', { class: 'panel-note' }, module.summary)),
    ),
    host,
  );

  async function refresh() {
    try {
      if (!state.layers.length) state.layers = (await get('/api/memory/layers')).items;
      if (!state.chats.length) state.chats = (await get('/api/chats')).items;
      if (!state.chatId && state.chats.length) state.chatId = state.chats[0].id;
      if (state.chatId) {
        const [memories, profiles] = await Promise.all([
          get(`/api/memory?chatId=${encodeURIComponent(state.chatId)}&limit=500${state.sort === 'heat' ? '&sort=heat' : ''}`),
          get(`/api/memory/profiles?chatId=${encodeURIComponent(state.chatId)}`),
        ]);
        state.items = memories.items;
        state.profiles = profiles.items;
      }
      render();
    } catch (err) {
      host.replaceChildren(panel('记忆', null, errorBox(err, { onRetry: () => void refresh() })));
    }
  }

  function render() {
    const chatSelect = h(
      'select',
      { onchange: (event) => { state.chatId = event.target.value; void refresh(); } },
      state.chats.length
        ? state.chats.map((chat) => h('option', { value: chat.id, selected: chat.id === state.chatId }, `${chat.title}${chat.messageCount !== undefined ? `（${chat.messageCount} 条）` : ''}`))
        : h('option', { value: '' }, '还没有对话'),
    );

    const byLayer = (layer) => state.items.filter((item) => item.layer === layer);
    const heatBar = (heat) =>
      h(
        'div',
        { class: 'heat-bar', title: `热度 ${Number(heat ?? 0).toFixed(2)}` },
        h('div', { class: 'heat-fill', style: { width: `${Math.round(Math.max(0, Math.min(1, Number(heat ?? 0))) * 100)}%` } }),
        h('span', { class: 'heat-num' }, Number(heat ?? 0).toFixed(2)),
      );
    const sortSelect = h(
      'select',
      {
        onchange: (event) => {
          state.sort = event.target.value;
          void refresh();
        },
      },
      h('option', { value: 'time', selected: state.sort === 'time' }, '按时间'),
      h('option', { value: 'heat', selected: state.sort === 'heat' }, '按热度'),
    );
    const memoryTable = (items, layer) =>
      items.length
        ? table(
            ['标题', '内容', '热度', '状态', '时间', '操作'],
            items.map((item) => [
              h('div', {}, h('div', { style: { fontWeight: '600' } }, item.pinned ? `📌 ${item.title || item.id}` : item.title || item.id), item.coversFrom ? h('div', { class: 'panel-note', style: { fontSize: '12px' } }, `覆盖 ${item.coversFrom} → ${item.coversTo}`) : null),
              h('div', { style: { maxWidth: '380px' } }, item.content.slice(0, 120)),
              heatBar(item.heat),
              item.pinned ? '已钉住' : '自动',
              (item.updatedAt ?? '').slice(0, 19).replace('T', ' '),
              h('div', { style: { display: 'flex', gap: '6px' } },
                h('button', { class: 'btn small', onclick: () => editMemory(item) }, '编辑'),
                h('button', { class: 'btn small', onclick: async () => { await put(`/api/memory/${item.id}`, { pinned: !item.pinned }); await refresh(); } }, item.pinned ? '取消钉住' : '钉住'),
                h('button', { class: 'btn small danger', onclick: async () => {
                  if (!(await confirmDialog({ title: '删除记忆', message: '确定删掉这条记忆吗？', confirmLabel: '删除' }))) return;
                  await del(`/api/memory/${item.id}`); await refresh();
                } }, '删除')),
            ]),
          )
        : h('div', { class: 'panel-note' }, layer === 'profile' ? '还没有结构化档案' : '还没有记忆，点上面的按钮生成一条试试');

    host.replaceChildren(
      panel(
        '记忆范围',
        null,
        kv([['对话', state.chats.length], ['小总结', byLayer('small').length], ['大总结', byLayer('large').length], ['档案', byLayer('profile').length]]),
        h('div', { style: { marginTop: '12px' } }, field('选一个对话', chatSelect)),
        h('div', { style: { marginTop: '8px' } }, field('排序', sortSelect, '按热度看"哪些记忆更该被想起来"')),
        h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
          h('button', { class: 'btn primary', onclick: () => generateSmall() }, '生成小总结'),
          h('button', { class: 'btn', onclick: () => generateLarge() }, '生成大总结'),
          h('button', { class: 'btn', onclick: () => rebuild() }, '重算记忆'),
          h('button', { class: 'btn', onclick: () => writeMemory() }, '手写一条')),
      ),
      panel('小总结', `${byLayer('small').length} 条`, memoryTable(byLayer('small'), 'small')),
      panel('大总结', `${byLayer('large').length} 条`, memoryTable(byLayer('large'), 'large')),
      panel('结构化档案', `${state.profiles.length} 条`, memoryTable(state.profiles, 'profile')),
      timelinePanel(),
    );
  }

  /** 时间线：把这条对话的记忆按发生顺序排开，每条带热度。 */
  function timelinePanel() {
    const items = [...state.items].sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')));
    if (!items.length) {
      return panel('时间线', '0 条', emptyState({ icon: '🕰️', title: '还没有记忆', desc: '生成一条小总结，时间线上就会出现一个点。' }));
    }
    return panel(
      '时间线',
      `${items.length} 条`,
      h(
        'div',
        { class: 'memory-timeline' },
        items.map((item) =>
          h(
            'div',
            {
              class: 'timeline-row',
              style: { cursor: item.coversFrom ? 'pointer' : 'default' },
              title: item.coversFrom ? '跳到这段对话' : '',
              onclick: () => {
                if (item.coversFrom && state.chatId) ctx.navigate?.('chat', `${state.chatId}:${item.coversFrom}`);
              },
            },
            h('span', { class: 'timeline-dot' }),
            h('span', { class: 'timeline-time mono' }, String(item.createdAt ?? '').slice(0, 16).replace('T', ' ')),
            h('span', { class: `chip small ${item.layer === 'large' ? 'partial' : item.layer === 'profile' ? 'stub' : 'ready'}` }, item.layer === 'large' ? '大总结' : item.layer === 'profile' ? '档案' : '小总结'),
            h('span', { class: 'timeline-title' }, `${item.pinned ? '📌 ' : ''}${item.title || item.id}`),
            h(
              'span',
              { class: 'heat-bar heat-bar-inline', title: `热度 ${Number(item.heat ?? 0).toFixed(2)}` },
              h('span', { class: 'heat-fill', style: { width: `${Math.round(Math.max(0, Math.min(1, Number(item.heat ?? 0))) * 100)}%` } }),
            ),
            item.coversFrom ? h('span', { class: 'panel-note' }, `${item.coversFrom} → ${item.coversTo ?? ''}`) : null,
            item.coversFrom ? h('span', { class: 'link-btn' }, '跳到这条') : null,
          ),
        ),
      ),
    );
  }

  async function generateSmall() {
    if (!state.chatId) return toast('先去玩卡区建一个对话', { tone: 'warn' });
    try {
      const result = await post('/api/memory/summarize/small', { chatId: state.chatId, size: 20 });
      toast(`总结了 ${result.covered} 条消息`);
      await refresh();
    } catch (err) {
      toastError(err);
    }
  }

  async function generateLarge() {
    if (!state.chatId) return toast('先去玩卡区建一个对话', { tone: 'warn' });
    try {
      await post('/api/memory/summarize/large', { chatId: state.chatId });
      toast('大总结已生成');
      await refresh();
    } catch (err) {
      toastError(err);
    }
  }

  async function rebuild() {
    if (!state.chatId) return;
    try {
      const result = await post('/api/memory/rebuild', { chatId: state.chatId, batches: 3, messagesPerBatch: 20 });
      toast(`重算完成，生成 ${result.created.length} 条`);
      await refresh();
    } catch (err) {
      toastError(err);
    }
  }

  function writeMemory() {
    const title = h('input', { type: 'text', placeholder: '标题' });
    const content = h('textarea', { rows: 4, placeholder: '这一条记忆的内容' });
    openModal({
      title: '手写一条记忆',
      body: h('div', {}, field('标题', title), field('内容', content)),
      actions: [
        { label: '取消' },
        { label: '保存', primary: true, onClick: async () => {
          try {
            await post('/api/memory/summarize/small', { chatId: state.chatId, title: title.value, content: content.value });
            await refresh();
          } catch (err) { toastError(err); return false; }
          return true;
        } },
      ],
    });
  }

  function editMemory(item) {
    const title = h('input', { type: 'text', value: item.title ?? '' });
    const content = h('textarea', { rows: 6 }, item.content ?? '');
    openModal({
      title: '编辑记忆',
      width: '620px',
      body: h('div', {}, field('标题', title), field('内容', content)),
      actions: [
        { label: '取消' },
        { label: '保存', primary: true, onClick: async () => {
          try {
            await put(`/api/memory/${item.id}`, { title: title.value, content: content.value });
            await refresh();
          } catch (err) { toastError(err); return false; }
          return true;
        } },
      ],
    });
  }

  void ctx;
  return { el, mount: refresh };
}
