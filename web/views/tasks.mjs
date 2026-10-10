/**
 * 任务中心：一页看完后台在跑什么。
 *
 * 三块数据：
 *   正在跑 / 最近出图  ← comfy_runs（能取消、能重试）
 *   最近干的活        ← tasks 表（备份 / 恢复 / 清理 / 导入）
 *   定时任务          ← scheduler（各自记着"上次跑成没"）
 */

import { h } from '../core/dom.mjs';
import { get, post } from '../core/api.mjs';
import { panel, table, loading, errorBox, emptyState } from '../ui/components.mjs';
import { toast, toastError } from '../ui/toast.mjs';

const COMFY_TERMINAL = new Set(['done', 'error', 'cancelled']);
const COMFY_LABEL = { queued: '排队中', running: '出图中', done: '完成', error: '失败', cancelled: '已取消' };
const TASK_LABEL = { running: '在跑', done: '完成', error: '失败' };

function statusChipClass(status) {
  if (status === 'done') return 'chip ready';
  if (status === 'error') return 'chip error';
  if (status === 'running' || status === 'queued') return 'chip partial';
  return 'chip';
}

function shortTime(value) {
  return String(value ?? '').slice(0, 19).replace('T', ' ');
}

export function createTasksView(module) {
  const el = h('div', { class: 'view' });
  const liveHost = h('div', {});
  const tasksHost = h('div', {});
  const scheduledHost = h('div', {});

  async function cancelRun(run) {
    try {
      await post(`/api/comfy/runs/${run.id}/cancel`, {});
      toast('已请求取消');
      await refresh();
    } catch (err) {
      toastError(err);
    }
  }

  async function rerun(run) {
    try {
      await post(`/api/comfy/runs/${run.id}/rerun`, {});
      toast('重新提交了');
      await refresh();
    } catch (err) {
      toastError(err);
    }
  }

  async function clearFinished() {
    try {
      const result = await post('/api/tasks/clear', {});
      toast(`清掉了 ${result.removed ?? 0} 条记录`);
      await refresh();
    } catch (err) {
      toastError(err);
    }
  }

  function renderLive(comfy) {
    const running = comfy.filter((run) => !COMFY_TERMINAL.has(run.status));
    const recent = comfy.filter((run) => COMFY_TERMINAL.has(run.status)).slice(0, 8);
    const row = (run, canAct) => {
      const total = Number(run.progressMax ?? 0);
      const done = Number(run.progress ?? 0);
      const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
      return [
        run.workflowName ?? run.kind ?? '出图',
        h('span', { class: statusChipClass(run.status) }, COMFY_LABEL[run.status] ?? run.status),
        total > 0 ? `${percent}%（${done}/${total}）` : run.status === 'error' ? run.error ?? '失败' : '—',
        shortTime(run.createdAt),
        canAct
          ? h(
              'div',
              { style: { display: 'flex', gap: '6px' } },
              run.status === 'queued' || run.status === 'running'
                ? h('button', { class: 'btn small', onclick: () => void cancelRun(run) }, '取消')
                : null,
              run.status === 'error'
                ? h('button', { class: 'btn small primary', onclick: () => void rerun(run) }, '重试')
                : null,
            )
          : '',
      ];
    };
    liveHost.replaceChildren(
      panel(
        '出图队列',
        running.length ? `${running.length} 个在跑` : '现在没有在跑的',
        running.length
          ? table(['工作流', '状态', '进度', '开始时间', ''], running.map((run) => row(run, true)))
          : emptyState({ icon: '🎨', title: '出图队列是空的', desc: '在对话里出图时，这里会显示进度；失败能直接重试。' }),
        recent.length
          ? h(
              'div',
              { style: { marginTop: '14px' } },
              h('div', { class: 'panel-note', style: { marginBottom: '6px' } }, '最近出图'),
              table(['工作流', '状态', '进度 / 原因', '时间', ''], recent.map((run) => row(run, true))),
            )
          : null,
      ),
    );
  }

  function renderTasks(payload) {
    const tasks = payload.tasks ?? [];
    tasksHost.replaceChildren(
      panel(
        '最近干的活',
        tasks.length ? `${tasks.length} 条 · 在跑 ${payload.running ?? 0}，失败 ${payload.failed ?? 0}` : '',
        h(
          'div',
          { style: { marginBottom: '10px' } },
          h('button', { class: 'btn', onclick: () => void clearFinished() }, '清空已结束的记录'),
        ),
        tasks.length
          ? table(
              ['活儿', '状态', '结果 / 原因', '开始', '结束'],
              tasks.map((task) => [
                task.title,
                h('span', { class: statusChipClass(task.status) }, TASK_LABEL[task.status] ?? task.status),
                task.error ? task.error : task.detail ?? '—',
                shortTime(task.startedAt),
                task.finishedAt ? shortTime(task.finishedAt) : '—',
              ]),
            )
          : emptyState({ icon: '🧰', title: '还没有记录', desc: '做一次备份、导入或清理，这里就会留下一条。' }),
      ),
    );
  }

  function renderScheduled(scheduled) {
    scheduledHost.replaceChildren(
      panel(
        '定时任务',
        scheduled.length ? `${scheduled.length} 条` : '',
        scheduled.length
          ? table(
              ['任务', '上次跑', '结果', '下次跑'],
              scheduled.map((task) => [
                task.label ?? task.id,
                shortTime(task.lastRunAt) || '还没跑过',
                h('span', { class: statusChipClass(task.lastStatus === 'error' ? 'error' : task.lastStatus === 'done' ? 'done' : '') }, task.lastError ?? task.lastResult ?? task.lastStatus ?? '—'),
                shortTime(task.nextRunAt) || '—',
              ]),
            )
          : emptyState({ icon: '⏰', title: '没有定时任务', desc: '在「工具箱 → 定时任务」里加一条，就会出现在这儿。' }),
      ),
    );
  }

  async function refresh() {
    try {
      const payload = await get('/api/tasks');
      renderLive(payload.comfy ?? []);
      renderTasks(payload);
      renderScheduled(payload.scheduled ?? []);
    } catch (err) {
      tasksHost.replaceChildren(panel('任务中心', null, errorBox(err, { onRetry: refresh })));
      toastError(err);
    }
  }

  async function mount() {
    liveHost.append(loading());
    tasksHost.append(loading());
    scheduledHost.append(loading());
    await refresh();
  }

  el.append(
    panel(module.title, module.summary, h('div', { class: 'panel-note' }, '出图能取消 / 重试；备份、导入这些干完就留一条记录。')),
    liveHost,
    tasksHost,
    scheduledHost,
  );
  return { el, mount };
}
