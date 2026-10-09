/**
 * 提示词 X 光机：每轮真正发出去的提示词快照。
 * 能按段展开、看到 token 与来源，也能"手动踢掉一段"再算一遍 token。
 */

import { h, statusChip } from '../core/dom.mjs';
import { get, post, del } from '../core/api.mjs';
import { panel, table, emptyState, errorBox } from '../ui/components.mjs';
import { openModal, confirmDialog } from '../ui/modal.mjs';
import { toast, toastError } from '../ui/toast.mjs';

export function createXrayView(module, ctx) {
  const el = h('div', { class: 'view' });
  const listHost = h('div', {});
  const detailHost = h('div', {});
  const state = { items: [], current: null };

  el.append(
    panel(
      module.title,
      null,
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } }, statusChip(module.status), h('span', { class: 'panel-note' }, module.summary)),
      h('div', { style: { marginTop: '12px' } }, h('button', { class: 'btn', onclick: () => void refresh() }, '刷新')),
    ),
    listHost,
    detailHost,
  );

  async function refresh() {
    try {
      const data = await get('/api/xray?limit=50');
      state.items = data.items;
      renderList();
      if (state.items.length) await open(state.current?.id ?? state.items[0].id);
      else detailHost.replaceChildren();
    } catch (err) {
      listHost.replaceChildren(panel('提示词快照', null, errorBox(err, { onRetry: () => void refresh() })));
    }
  }

  function renderList() {
    listHost.replaceChildren(
      panel(
        '提示词快照',
        `${state.items.length} 份`,
        state.items.length
          ? table(['时间', '对话', '模型', '段落', 'token', '操作'], state.items.map((item) => [
              (item.createdAt ?? '').slice(0, 19).replace('T', ' '),
              h('span', { class: 'mono' }, item.chatId ?? '—'),
              item.model ?? '—',
              item.sections.length,
              item.tokens.total,
              h('div', { style: { display: 'flex', gap: '6px' } },
                h('button', { class: 'btn small', onclick: () => open(item.id) }, '查看'),
                h('button', { class: 'btn small danger', onclick: async () => {
                  if (!(await confirmDialog({ title: '删除快照', message: '确定删掉这份提示词快照吗？', confirmLabel: '删除' }))) return;
                  await del(`/api/xray/${item.id}`);
                  if (state.current?.id === item.id) state.current = null;
                  await refresh();
                } }, '删除')),
            ]))
          : emptyState({ icon: '🔍', title: '还没有提示词快照', desc: '去玩卡区聊一句，这里就会记下那一轮真正发出去的内容。' }),
      ),
    );
  }

  async function open(id) {
    try {
      const snapshot = await get(`/api/xray/${id}`);
      state.current = snapshot;
      renderDetail();
    } catch (err) {
      detailHost.replaceChildren(panel('提示词详情', null, errorBox(err)));
    }
  }

  function renderDetail() {
    const snapshot = state.current;
    if (!snapshot) {
      detailHost.replaceChildren();
      return;
    }
    const drop = new Set();
    const rows = snapshot.sections.map((section) =>
      h('div', { class: 'reason-row' },
        h('label', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
          h('input', { type: 'checkbox', onchange: (event) => { if (event.target.checked) drop.add(section.id); else drop.delete(section.id); } }),
          h('span', {}, `${section.title} `, h('span', { class: 'mono panel-note' }, section.id))),
        h('span', { class: 'panel-note' }, `${section.role} · ${section.tokens} tok · ${section.source}`)),
    );

    detailHost.replaceChildren(
      panel(
        `快照 · ${(snapshot.createdAt ?? '').slice(0, 19).replace('T', ' ')}`,
        `合计 ${snapshot.tokens.total} token`,
        h('div', { class: 'panel-note' }, `对话 ${snapshot.chatId ?? '—'} · 模型 ${snapshot.model ?? '—'}`),
        h('div', { class: 'reason-list', style: { marginTop: '10px' } }, rows),
        snapshot.notes?.length ? h('div', { class: 'panel-note', style: { marginTop: '8px' } }, `备注：${snapshot.notes.join('　')}`) : null,
        h('div', { style: { marginTop: '10px', display: 'flex', gap: '8px', flexWrap: 'wrap' } },
          h('button', { class: 'btn', onclick: () => openModal({ title: '原样快照', width: '760px', body: h('pre', { class: 'text-preview' }, snapshot.text || '（空）'), actions: [{ label: '关闭' }] }) }, '看完整文本'),
          h('button', { class: 'btn primary', onclick: async () => {
            try {
              const kicked = await post('/api/prompts/preview', { sections: snapshot.sections, dropSections: [...drop], messages: [] });
              // 用原快照的文本，把踢掉的段落内容抠出来 —— 比只显示 system 更像"重发一次的样子"
              let previewText = snapshot.text;
              for (const section of snapshot.sections) {
                if (drop.has(section.id) && section.content) previewText = previewText.split(section.content).join('【已踢掉这一段】');
              }
              openModal({
                title: drop.size ? `踢掉 ${drop.size} 段后再发一次（预览）` : '原样再发一次（预览）',
                width: '760px',
                body: h('div', {}, h('div', { class: 'panel-note', style: { marginBottom: '8px' } }, `token：${snapshot.tokens.total} → ${kicked.tokens.total}`), h('pre', { class: 'text-preview' }, previewText || '（空）')),
                actions: [{ label: '关闭' }],
              });
              toast(`踢掉后 ${kicked.tokens.total} token（原 ${snapshot.tokens.total}）`);
            } catch (err) { toastError(err); }
          } }, '踢掉勾选的段，重发一次看看')),
      ),
    );
  }

  void ctx;
  return { el, mount: refresh };
}
