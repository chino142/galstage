/**
 * 坑本页：把"想开的坑"记下来，想开的时候一键开演变成角色卡。
 *
 * 数据来自 /api/plans（服务见 core/plans/service.mjs）：标题 / 简介 / 标签 / 备注 / 状态，
 * 开演之后会记下转成了哪张卡，记录不删 —— 回头看得见自己攒了多少坑。
 */

import { h } from '../core/dom.mjs';
import { get, post, put, del } from '../core/api.mjs';
import { panel, field, loading, errorBox, emptyState } from '../ui/components.mjs';
import { toast, toastError } from '../ui/toast.mjs';

// 跟 core/plans/service.mjs 的 PLAN_STATUSES 保持一致（前端不引核心代码，这里抄一份）
const PLAN_STATUSES = [
  { id: 'idea', title: '只是个想法' },
  { id: 'drafting', title: '在写设定' },
  { id: 'ready', title: '可以开演' },
  { id: 'archived', title: '搁下了' },
];

const statusTitle = (id) => PLAN_STATUSES.find((item) => item.id === id)?.title ?? id;

export function createPlansView(module) {
  const el = h('div', { class: 'view' });
  const formHost = h('div', {});
  const listHost = h('div', {});
  const state = { status: '', items: [] };

  const filterRow = h('div', { class: 'chip-row' });

  async function refresh() {
    try {
      const params = state.status ? `?status=${encodeURIComponent(state.status)}` : '';
      const data = await get(`/api/plans${params}`);
      state.items = data.items ?? [];
      renderList();
    } catch (err) {
      listHost.replaceChildren(panel('坑本', null, errorBox(err, { onRetry: refresh })));
      toastError(err);
    }
  }

  function renderFilters() {
    filterRow.replaceChildren(
      h(
        'button',
        {
          class: `chip-btn${state.status === '' ? ' active' : ''}`,
          onclick: () => {
            state.status = '';
            renderFilters();
            void refresh();
          },
        },
        '全部',
      ),
      ...PLAN_STATUSES.map((item) =>
        h(
          'button',
          {
            class: `chip-btn${state.status === item.id ? ' active' : ''}`,
            onclick: () => {
              state.status = item.id;
              renderFilters();
              void refresh();
            },
          },
          item.title,
        ),
      ),
    );
  }

  async function setStatus(plan, status) {
    try {
      await put(`/api/plans/${plan.id}`, { status });
      toast(`《${plan.title}》→ ${statusTitle(status)}`);
      await refresh();
    } catch (err) {
      toastError(err);
    }
  }

  async function promote(plan) {
    try {
      const result = await post(`/api/plans/${plan.id}/promote`, {});
      toast(`《${plan.title}》开演了，已经建好角色卡`);
      await refresh();
      return result?.card ?? null;
    } catch (err) {
      toastError(err);
      return null;
    }
  }

  async function remove(plan) {
    if (!confirm(`把「${plan.title}」从坑本里删掉？`)) return;
    try {
      await del(`/api/plans/${plan.id}`);
      toast('已删除');
      await refresh();
    } catch (err) {
      toastError(err);
    }
  }

  function planCard(plan) {
    const select = h(
      'select',
      { class: 'chip-btn', title: '状态' },
      PLAN_STATUSES.map((item) => h('option', { value: item.id }, item.title)),
    );
    select.value = plan.status;
    select.addEventListener('change', () => void setStatus(plan, select.value));

    return h(
      'div',
      { class: 'tile' },
      h('div', { class: 'tile-title' }, h('span', {}, '🌱'), plan.title),
      plan.summary ? h('div', { class: 'tile-desc', style: { marginBottom: '6px' } }, plan.summary) : null,
      plan.tags?.length ? h('div', { class: 'chip-row', style: { marginBottom: '6px' } }, plan.tags.map((tag) => h('span', { class: 'chip small' }, tag))) : null,
      plan.note ? h('div', { class: 'panel-note', style: { marginBottom: '6px', whiteSpace: 'pre-wrap' } }, plan.note) : null,
      h(
        'div',
        { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' } },
        select,
        h('button', { class: 'btn small primary', onclick: () => void promote(plan) }, '▶ 开演'),
        plan.cardId ? h('span', { class: 'chip small' }, '已建卡') : null,
        h('button', { class: 'btn small danger', onclick: () => void remove(plan) }, '删除'),
      ),
    );
  }

  function renderList() {
    listHost.replaceChildren(
      panel(
        '记着的坑',
        state.items.length ? `${state.items.length} 个` : '',
        h('div', { style: { marginBottom: '12px' } }, filterRow),
        state.items.length
          ? h('div', { class: 'grid' }, state.items.map(planCard))
          : emptyState({ icon: '🌱', title: '坑本还是空的', desc: '上面写一个想开的设定，攒着，想开的时候一键开演。' }),
      ),
    );
  }

  function renderForm() {
    const title = h('input', { type: 'text', placeholder: '比如：雨夜书店的狐狸老板娘' });
    const summary = h('input', { type: 'text', placeholder: '一句话简介' });
    const tags = h('input', { type: 'text', placeholder: '标签，用逗号分隔：狐狸,书店,治愈' });
    const note = h('textarea', { rows: '3', placeholder: '备注：设定、关系、想演什么桥段…' });

    async function submit() {
      const name = title.value.trim();
      if (!name) {
        toast('先写个标题', { tone: 'warn' });
        title.focus?.();
        return;
      }
      try {
        await post('/api/plans', {
          title: name,
          summary: summary.value.trim(),
          tags: tags.value.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean),
          note: note.value.trim(),
          status: 'idea',
        });
        toast(`记下了：${name}`);
        title.value = '';
        summary.value = '';
        tags.value = '';
        note.value = '';
        await refresh();
      } catch (err) {
        toastError(err);
      }
    }

    formHost.replaceChildren(
      panel(
        '记一个新坑',
        module.title,
        h(
          'div',
          { style: { display: 'grid', gap: '10px' } },
          field('标题', title),
          field('一句话简介', summary),
          field('标签', tags),
          field('备注', note),
          h('div', {}, h('button', { class: 'btn primary', onclick: () => void submit() }, '＋ 记下来')),
        ),
      ),
    );
  }

  async function mount() {
    renderForm();
    renderFilters();
    listHost.append(loading());
    await refresh();
  }

  el.append(formHost, listHost);
  return { el, mount };
}
