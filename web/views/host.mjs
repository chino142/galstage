/**
 * 主机管理（多用户模式下的管理员视图）。
 *
 * 能做的：开账号、停用 / 启用、重置口令、删除账号（可选连数据一起删）、卸载租户、看占用。
 * 不能做的：看别人的对话内容 —— 那些在各自的租户数据目录里，主机进程不碰。
 */

import { h, statusChip } from '../core/dom.mjs';
import { api, get, post } from '../core/api.mjs';
import { panel, field, table, errorBox, loading, emptyState } from '../ui/components.mjs';
import { confirmDialog } from '../ui/modal.mjs';
import { toast, toastError } from '../ui/toast.mjs';

function formatBytes(bytes) {
  const value = Number(bytes ?? 0);
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let index = 0;
  let size = value;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size >= 10 || index === 0 ? Math.round(size) : size.toFixed(1)} ${units[index]}`;
}

function formatTime(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function createHostView(module, ctx) {
  const el = h('div', { class: 'view' });
  const host = h('div', {});
  const state = { info: null, withDisk: false };

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
      state.info = await get(`/api/host/info${state.withDisk ? '?disk=1' : ''}`);
      render();
    } catch (err) {
      host.replaceChildren(panel('主机管理', null, errorBox(err, { onRetry: () => refresh() })));
    }
  }

  function addAccountForm() {
    const name = h('input', { placeholder: '账号名（小写字母、数字、- _）' });
    const password = h('input', { type: 'password', placeholder: '初始口令（至少 8 位）' });
    const role = h('select', {}, [h('option', { value: 'user' }, '成员'), h('option', { value: 'admin' }, '管理员')]);
    const note = h('input', { placeholder: '备注（给谁用的，可选）' });
    return h(
      'div',
      {},
      h(
        'div',
        { style: { display: 'grid', gap: '10px', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' } },
        field('账号', name),
        field('初始口令', password),
        field('角色', role),
        field('备注', note),
      ),
      h(
        'button',
        {
          class: 'btn primary',
          style: { marginTop: '10px' },
          onclick: async () => {
            try {
              await post('/api/host/users', { name: name.value.trim(), password: password.value, role: role.value, note: note.value.trim() });
              toast(`账号 ${name.value.trim()} 建好了，把口令给他`);
              await refresh();
            } catch (err) {
              toastError(err);
            }
          },
        },
        '建账号',
      ),
    );
  }

  function accountsPanel() {
    const items = state.info.accounts ?? [];
    const rows = items.map((account) => [
      h('div', {}, h('div', { style: { fontWeight: '600' } }, account.name), account.note ? h('div', { class: 'panel-note', style: { fontSize: '12px' } }, account.note) : null),
      account.role === 'admin' ? '管理员' : '成员',
      account.disabled ? h('span', { class: 'chip error small' }, '已停用') : h('span', { class: 'chip ready small' }, '正常'),
      formatTime(account.lastLoginAt),
      formatTime(account.createdAt),
      h(
        'div',
        { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
        h(
          'button',
          {
            class: 'btn small',
            onclick: async () => {
              const value = prompt(`给 ${account.name} 设一个新口令（至少 8 位）`);
              if (!value) return;
              try {
                await post(`/api/host/users/${encodeURIComponent(account.name)}`, { password: value });
                toast('口令已重置，别忘了告诉他');
              } catch (err) {
                toastError(err);
              }
            },
          },
          '重置口令',
        ),
        h(
          'button',
          {
            class: 'btn small',
            onclick: async () => {
              try {
                await post(`/api/host/users/${encodeURIComponent(account.name)}`, { disabled: !account.disabled });
                toast(account.disabled ? '已启用' : '已停用（在线的会话会被踢下线）');
                await refresh();
              } catch (err) {
                toastError(err);
              }
            },
          },
          account.disabled ? '启用' : '停用',
        ),
        h(
          'button',
          {
            class: 'btn small danger',
            onclick: async () => {
              const confirm = await confirmDialog({
                title: `删除账号 ${account.name}`,
                message: `要删掉账号 ${account.name} 吗？它的数据目录会保留（之后可以再删）。想连数据一起删，确认后再勾"连数据一起删"。`,
                confirmLabel: '删账号',
              });
              if (!confirm) return;
              const purge = await confirmDialog({
                title: '连数据一起删？',
                message: `「确定」= 账号和它所有对话 / 卡 / 素材一起删掉，不可恢复。「取消」= 只删账号，数据目录留着。`,
                confirmLabel: '连数据一起删',
                cancelLabel: '只删账号',
              });
              try {
                const result = await api(`/api/host/users/${encodeURIComponent(account.name)}`, { method: 'DELETE', body: { confirm: true, purge } });
                toast(result?.purged ? '账号和数据都删了' : '账号删了，数据目录留着');
                await refresh();
              } catch (err) {
                toastError(err);
              }
            },
          },
          '删除',
        ),
      ),
    ]);

    return panel(
      '账号',
      `${items.length} 个`,
      items.length ? table(['账号', '角色', '状态', '上次登录', '创建时间', '操作'], rows) : emptyState({ icon: '👥', title: '还没有账号' }),
      h('div', { style: { marginTop: '16px' } }, h('div', { class: 'hint' }, '加一个朋友：'), addAccountForm()),
    );
  }

  function tenantsPanel() {
    const items = state.info.tenants ?? [];
    const rows = items.map((tenant) => [
      h('div', { class: 'mono' }, tenant.name),
      tenant.loaded ? h('span', { class: 'chip ready small' }, '在跑') : h('span', { class: 'chip stub small' }, '未载入'),
      formatTime(tenant.lastUsed),
      state.withDisk ? formatBytes(tenant.bytes) : '—',
      tenant.loaded
        ? h(
            'button',
            {
              class: 'btn small',
              onclick: async () => {
                try {
                  await post(`/api/host/tenants/${encodeURIComponent(tenant.name)}/unload`, {});
                  toast('卸载了，下次他访问会重新载入');
                  await refresh();
                } catch (err) {
                  toastError(err);
                }
              },
            },
            '卸载',
          )
        : null,
    ]);
    return panel(
      '租户数据',
      `${items.length} 份`,
      h(
        'div',
        { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
        h('button', { class: 'btn small', onclick: async () => { state.withDisk = !state.withDisk; await refresh(); } }, state.withDisk ? '不统计磁盘' : '统计磁盘占用'),
        h('span', { class: 'hint' }, '每个人的对话 / 卡 / 素材都在自己的目录里，主机只负责把它们交给对应的人。'),
      ),
      items.length ? table(['账号', '状态', '最近访问', '磁盘占用', '操作'], rows) : emptyState({ icon: '🗂️', title: '还没有租户数据' }),
    );
  }

  function render() {
    const info = state.info;
    host.replaceChildren(
      panel(
        '服务总览',
        `v${info.version}`,
        h(
          'div',
          { class: 'kv' },
          h('dt', {}, '模式'),
          h('dd', {}, '多用户（一个网址 + 登录，每人一个数据目录）'),
          h('dt', {}, '主目录'),
          h('dd', { class: 'mono' }, info.hostRoot),
          h('dt', {}, '启动时间'),
          h('dd', {}, formatTime(info.startedAt)),
          h('dt', {}, '在线会话'),
          h('dd', {}, String(info.sessions?.sessions ?? 0)),
          h('dt', {}, '已载入租户'),
          h('dd', {}, (info.loaded ?? []).join('、') || '—'),
          h('dt', {}, '插件'),
          h('dd', {}, (info.plugins ?? []).length ? info.plugins.map((item) => `${item.name}@${item.version}`).join('、') : '—'),
        ),
      ),
      accountsPanel(),
      tenantsPanel(),
    );
  }

  async function mount() {
    host.replaceChildren(loading());
    try {
      await refresh();
    } catch (err) {
      host.replaceChildren(panel('主机管理', null, errorBox(err, { onRetry: () => mount() })));
    }
  }

  void ctx;
  return { el, mount };
}
