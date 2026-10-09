/**
 * 工具箱 · 定时任务（蓝图 3.2「扩展性」）。
 *
 * 每天 / 每周自动：备份、清理（体检 + 清理失效数据）、给指定对话写小 / 大总结。
 * 任务清单与"上次跑的时间"存在服务端（app_meta），所以重启后不会把同一个时间点跑两遍。
 * 这里只负责开关、时间与"上次 / 下次运行"的显示，还有"立刻跑一遍"。
 */

import { h, statusChip } from '../core/dom.mjs';
import { get, post, put, del } from '../core/api.mjs';
import { panel, field, loading, errorBox, emptyState } from '../ui/components.mjs';
import { toast, toastError } from '../ui/toast.mjs';

function formatDateTime(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function pad(num) {
  return String(num).padStart(2, '0');
}

export function createSchedulerView(module) {
  const el = h('div', { class: 'view' });
  const listHost = h('div', {});
  const formHost = h('div', {});

  let data = { items: [], kinds: [], frequencies: [], weekdays: [] };
  let chats = [];
  let editingId = null;
  let busy = false;

  const kindSelect = h('select', {});
  const everySelect = h('select', {});
  const timeInput = h('input', { type: 'time', value: '04:00' });
  const weekdaySelect = h('select', {});
  const chatSelect = h('select', {});
  const levelSelect = h('select', {}, [h('option', { value: 'small' }, '小总结（最近一段对话）'), h('option', { value: 'large' }, '大总结（把已有小总结并成档案）')]);
  const enabledInput = h('input', { type: 'checkbox' });
  const labelInput = h('input', { placeholder: '留空就自动起名' });
  const kindField = field('做什么', kindSelect);
  const everyField = field('频率', everySelect);
  const timeField = field('时间', timeInput, '服务器本地时间');
  const weekdayField = field('星期几', weekdaySelect);
  const chatField = field('对话', chatSelect, '到点后给这个对话补一段总结');
  const levelField = field('总结类型', levelSelect);

  el.append(
    panel(
      module.title,
      null,
      h('div', { class: 'panel-note' }, module.summary),
      h('div', { style: { marginTop: '12px' } }, statusChip(module.status)),
    ),
    panel('任务', null, listHost),
    panel('新建 / 编辑', null, formHost),
  );

  function timeParts() {
    const [hour, minute] = String(timeInput.value || '04:00').split(':');
    return { atHour: Number(hour) || 0, atMinute: Number(minute) || 0 };
  }

  function renderForm() {
    const editing = editingId ? data.items.find((item) => item.id === editingId) : null;
    const kind = kindSelect.value;
    weekdayField.style.display = everySelect.value === 'weekly' ? '' : 'none';
    chatField.style.display = kind === 'summarize' ? '' : 'none';
    levelField.style.display = kind === 'summarize' ? '' : 'none';

    formHost.replaceChildren(
      h(
        'div',
        {},
        h(
          'div',
          { style: { display: 'grid', gap: '10px', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' } },
          kindField,
          everyField,
          timeField,
          weekdayField,
          levelField,
          chatField,
        ),
        h('div', { style: { marginTop: '10px' } }, field('名字（可选）', labelInput)),
        h('label', { class: 'switch-row', style: { marginTop: '6px' } }, enabledInput, h('span', {}, '启用这条任务')),
        h(
          'div',
          { style: { marginTop: '10px', display: 'flex', gap: '8px' } },
          h('button', { class: 'btn primary', onclick: () => saveTask() }, editing ? '保存修改' : '新建任务'),
          editing
            ? h('button', { class: 'btn', onclick: () => { editingId = null; resetForm(); renderForm(); renderList(); } }, '取消编辑')
            : null,
        ),
        editing ? h('div', { class: 'hint' }, `正在编辑：${editing.label}`) : null,
      ),
    );
  }

  function resetForm() {
    kindSelect.value = data.kinds[0]?.id ?? 'backup';
    everySelect.value = 'daily';
    timeInput.value = '04:00';
    weekdaySelect.value = '1';
    levelSelect.value = 'small';
    enabledInput.checked = false;
    labelInput.value = '';
  }

  function fillForm(task) {
    editingId = task.id;
    kindSelect.value = task.kind;
    everySelect.value = task.every;
    timeInput.value = `${pad(task.atHour)}:${pad(task.atMinute)}`;
    weekdaySelect.value = String(task.weekday ?? 1);
    levelSelect.value = task.level ?? 'small';
    if (task.chatId) chatSelect.value = task.chatId;
    enabledInput.checked = Boolean(task.enabled);
    labelInput.value = task.label ?? '';
    renderForm();
  }

  async function saveTask() {
    if (busy) return;
    busy = true;
    try {
      const { atHour, atMinute } = timeParts();
      const base = {
        kind: kindSelect.value,
        every: everySelect.value,
        atHour,
        atMinute,
        weekday: Number(weekdaySelect.value),
        enabled: enabledInput.checked,
        label: labelInput.value.trim(),
        chatId: kindSelect.value === 'summarize' ? chatSelect.value : undefined,
        level: levelSelect.value,
      };
      if (editingId) await put(`/api/scheduler/${editingId}`, base);
      else await post('/api/scheduler', base);
      toast(editingId ? '任务已更新' : '任务已创建');
      editingId = null;
      resetForm();
      await refresh();
    } catch (err) {
      toastError(err);
    } finally {
      busy = false;
    }
  }

  async function toggleTask(task) {
    try {
      await put(`/api/scheduler/${task.id}`, { enabled: !task.enabled });
      await refresh();
    } catch (err) {
      toastError(err);
    }
  }

  async function removeTask(task) {
    try {
      await del(`/api/scheduler/${task.id}`);
      toast('任务已删除');
      await refresh();
    } catch (err) {
      toastError(err);
    }
  }

  async function runNow(task) {
    try {
      const result = await post(`/api/scheduler/${task.id}/run`, {});
      const tone = result?.lastStatus === 'error' ? 'warn' : 'info';
      toast(`${task.label}：${result?.lastResult ?? result?.lastStatus ?? '已执行'}`, { tone });
      await refresh();
    } catch (err) {
      toastError(err);
    }
  }

  function taskCard(task) {
    const tone = task.lastStatus === 'error' ? 'error' : task.lastStatus === 'ok' ? 'ready' : task.lastStatus === 'skipped' ? 'partial' : 'stub';
    return h(
      'div',
      { class: 'tile', style: { marginBottom: '10px' } },
      h(
        'div',
        { class: 'tile-title' },
        task.label,
        h('span', { class: 'chip' }, task.kindTitle ?? task.kind),
        h('span', { class: `chip ${task.enabled ? 'ready' : 'stub'}` }, task.enabled ? '已启用' : '已停用'),
      ),
      h('div', { class: 'mono tile-desc' }, task.frequency),
      h(
        'div',
        { class: 'panel-note' },
        `上次：${formatDateTime(task.lastRunAt)}${task.lastStatus ? ` · ${task.lastStatus}` : ''}${task.lastResult ? ` · ${task.lastResult}` : ''}`,
      ),
      h('div', { class: 'panel-note' }, task.nextRunAt ? `下次：${formatDateTime(task.nextRunAt)}` : '下次：—'),
      h(
        'div',
        { style: { marginTop: '8px', display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' } },
        h('button', { class: 'btn', onclick: () => toggleTask(task) }, task.enabled ? '停用' : '启用'),
        h('button', { class: 'btn', onclick: () => runNow(task) }, '立刻跑一遍'),
        h('button', { class: 'btn', onclick: () => fillForm(task) }, '编辑'),
        h('button', { class: 'btn', onclick: () => removeTask(task) }, '删除'),
        task.lastError ? h('span', { class: `chip ${tone}` }, task.lastError) : null,
      ),
    );
  }

  function renderList() {
    if (!data.items.length) {
      listHost.replaceChildren(emptyState({ icon: '⏰', title: '还没有定时任务', desc: '用下面的表单建一条，或者直接把默认的"每天自动备份"打开。' }));
      return;
    }
    listHost.replaceChildren(...data.items.map((task) => taskCard(task)));
  }

  async function loadChats() {
    try {
      chats = (await get('/api/chats')).items ?? [];
    } catch {
      chats = [];
    }
    chatSelect.replaceChildren(
      chats.length
        ? chats.map((chat) => h('option', { value: chat.id }, `${chat.isGroup ? '👥 ' : '💬 '}${chat.title}`))
        : h('option', { value: '' }, '（还没有对话）'),
    );
  }

  async function refresh() {
    const payload = await get('/api/scheduler');
    data = payload;
    kindSelect.replaceChildren(...(payload.kinds ?? []).map((kind) => h('option', { value: kind.id }, kind.title)));
    everySelect.replaceChildren(...(payload.frequencies ?? []).map((freq) => h('option', { value: freq.id }, freq.title)));
    weekdaySelect.replaceChildren(...(payload.weekdays ?? []).map((day) => h('option', { value: String(day.id) }, day.title)));
    if (!kindSelect.value) kindSelect.value = payload.kinds?.[0]?.id ?? 'backup';
    if (!everySelect.value) everySelect.value = 'daily';
    renderList();
    renderForm();
  }

  async function mount() {
    listHost.replaceChildren(loading());
    formHost.replaceChildren(loading());
    kindSelect.addEventListener('change', renderForm);
    everySelect.addEventListener('change', renderForm);
    try {
      await loadChats();
      resetForm();
      await refresh();
    } catch (err) {
      listHost.replaceChildren(errorBox(err, { onRetry: () => mount() }));
      formHost.replaceChildren();
    }
  }

  return { el, mount };
}
