/**
 * 备份与维护页（蓝图 3.2）：
 *   数据统计 → 一键备份 / 恢复 → 数据体检与清理。
 *
 * 恢复是破坏性操作，界面上必须点两次（第一次进入"确认"状态，第二次才真发请求），
 * 和服务端"破坏性操作要确认"的约定保持一致。
 */

import { h } from '../core/dom.mjs';
import { get, post, put, del } from '../core/api.mjs';
import { panel, field, loading, errorBox, emptyState, table, kv } from '../ui/components.mjs';
import { toast, toastError } from '../ui/toast.mjs';

export function createBackupView(module) {
  const el = h('div', { class: 'view' });
  const statsHost = h('div', {});
  const backupHost = h('div', {});
  const exportHost = h('div', {});
  const scanHost = h('div', {});

  const labelInput = h('input', { type: 'text', placeholder: '备份备注（可留空）' });
  const autoToggle = h('input', { type: 'checkbox' });
  const keepInput = h('input', { type: 'text', placeholder: '保留份数' });
  const scanTargets = new Map();
  let pendingRestore = null;

  el.append(
    panel(module.title, null, h('span', { class: 'panel-note' }, module.summary)),
    statsHost,
    backupHost,
    exportHost,
    scanHost,
  );

  /**
   * 加密导出 / 导入：口令只有你自己知道，导出的 .stbk 主机管理员也解不开。
   * 这是"多用户模式下数据在你手里"的兑现方式：随时能带走一份完整的、加密的自己的数据。
   */
  function renderExport() {
    const password = h('input', { type: 'password', placeholder: '一个只有你知道的口令（至少 8 位）', autocomplete: 'new-password' });
    const confirm = h('input', { type: 'password', placeholder: '再输一次', autocomplete: 'new-password' });
    const importPassword = h('input', { type: 'password', placeholder: '那份备份的口令', autocomplete: 'off' });
    const fileInput = h('input', { type: 'file', accept: '.stbk,.bin,application/octet-stream' });
    exportHost.replaceChildren(
      panel(
        '加密备份（带走你的全部数据）',
        '只有这个口令能解开',
        h(
          'div',
          {},
          h('div', { class: 'panel-note' }, '导出的是一个 `.stbk` 文件：整个数据目录（对话、角色卡、世界书、素材、设置）打成一个包，再用你给的口令加密。口令不落盘，所以主机管理员也打不开。'),
          h('div', { style: { marginTop: '10px', display: 'grid', gap: '10px', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' } }, field('导出口令', password), field('确认口令', confirm)),
          h('button', { class: 'btn primary', style: { marginTop: '10px' }, onclick: () => exportEncrypted(password.value, confirm.value) }, '⬇ 导出加密备份'),
        ),
      ),
      panel(
        '从加密备份恢复',
        '会先自动备份当前数据',
        h('div', { class: 'field' }, h('label', {}, '选 .stbk 文件'), fileInput),
        h('div', { class: 'field' }, h('label', {}, '口令'), importPassword),
        h(
          'button',
          {
            class: 'btn',
            style: { marginTop: '10px' },
            onclick: () => importEncrypted(fileInput.files?.[0] ?? null, importPassword.value),
          },
          '从备份恢复',
        ),
        h('div', { class: 'hint', style: { marginTop: '6px' } }, '恢复会覆盖当前数据（恢复前会自动留一份现在的备份）。'),
      ),
    );
  }

  async function exportEncrypted(password, confirm) {
    if (!password || password !== confirm) {
      toast('两次口令不一样', { tone: 'warn' });
      return;
    }
    try {
      const response = await fetch('/api/maintenance/export-encrypted', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passphrase: password, label: '加密导出' }),
      });
      if (!response.ok) {
        let message = `导出失败（${response.status}）`;
        try {
          message = (await response.json())?.error?.message ?? message;
        } catch {
          // 保留默认文案
        }
        throw new Error(message);
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = h('a', { href: url, download: `silver-tavern-backup-${new Date().toISOString().slice(0, 10)}.stbk` });
      document.body.append(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast('加密备份已下载，口令自己收好');
      await refreshBackups();
    } catch (err) {
      toastError(err);
    }
  }

  function toBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunk = 0x8000;
    for (let index = 0; index < bytes.length; index += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(index, index + chunk));
    }
    return btoa(binary);
  }

  async function importEncrypted(file, password) {
    if (!file) {
      toast('先选一个 .stbk 文件', { tone: 'warn' });
      return;
    }
    if (!password) {
      toast('要填那份备份的口令', { tone: 'warn' });
      return;
    }
    try {
      const buffer = await file.arrayBuffer();
      const result = await post('/api/maintenance/import-encrypted', {
        passphrase: password,
        data: toBase64(buffer),
        label: `从 ${file.name} 恢复`,
      });
      toast(`恢复了 ${result.tables} 张表（恢复前自动留了 ${result.safetyBackup ?? '无'}）`);
      await refreshAll();
    } catch (err) {
      toastError(err);
    }
  }

  function renderStats(payload) {
    const items = payload.items ?? [];
    statsHost.replaceChildren(
      panel(
        '数据统计',
        `${payload.raw?.messages ?? 0} 条消息`,
        kv(items.map((item) => [item.label, String(item.value)])),
      ),
    );
  }

  function renderBackups(payload) {
    const items = payload.items ?? [];
    autoToggle.checked = payload.autoBackupOnStart !== false;
    keepInput.value = String(payload.keep ?? 10);

    backupHost.replaceChildren(
      panel(
        '备份',
        `${items.length} 份`,
        h('div', { class: 'panel-note' }, `备份目录：${payload.directory ?? '（未启用）'}（想放同步盘就改「设置 → 备份目录」）。备份是一个 zip：数据库快照 + 素材 + manifest，可以整个拷走。`),
        h(
          'div',
          { style: { display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'end', marginTop: '10px' } },
          field('备注', labelInput),
          h('button', { class: 'btn primary', onclick: () => createBackup() }, '立即备份'),
        ),
        h(
          'div',
          { style: { display: 'flex', gap: '14px', flexWrap: 'wrap', alignItems: 'end', marginTop: '12px' } },
          field('启动时自动备份', autoToggle),
          field('自动备份保留份数', keepInput, '0 表示不清理'),
          h('button', { class: 'btn', onclick: saveAutoSettings }, '保存设置'),
        ),
        items.length
          ? table(
              ['名字', '类型', '时间', '体积', '内容', ''],
              items.map((item) => [
                h('span', { class: 'mono' }, item.name),
                item.kindTitle ?? item.kind,
                String(item.createdAt ?? '').slice(0, 19).replace('T', ' '),
                item.sizeText ?? '',
                `${item.stats?.chats ?? 0} 对话 / ${item.stats?.messages ?? 0} 消息 / ${item.assetFiles ?? 0} 素材`,
                h(
                  'div',
                  { style: { display: 'flex', gap: '6px' } },
                  h('button', { class: 'btn', onclick: () => askRestore(item) }, pendingRestore === item.name ? '确认恢复' : '恢复'),
                  h('button', { class: 'btn', onclick: () => removeBackup(item) }, '删除'),
                ),
              ]),
            )
          : emptyState({ icon: '🧰', title: '还没有备份', desc: '点上面的「立即备份」留一份。' }),
      ),
    );
  }

  function askRestore(item) {
    if (pendingRestore === item.name) {
      pendingRestore = null;
      void restoreBackup(item);
      return;
    }
    pendingRestore = item.name;
    toast(`再点一次「确认恢复」就会用「${item.name}」覆盖当前数据（会先自动留一份现在的）`);
    void refreshBackups();
  }

  async function createBackup() {
    try {
      const made = await post('/api/maintenance/backup', { label: labelInput.value.trim() || '手动备份' });
      labelInput.value = '';
      toast(`已备份：${made.name}（${made.sizeText ?? ''}）`);
      await refreshBackups();
      await refreshStats();
    } catch (err) {
      toastError(err);
    }
  }

  async function restoreBackup(item) {
    try {
      const result = await post('/api/maintenance/restore', { name: item.name });
      toast(`已恢复：${result.tables} 张表、${result.files?.written ?? 0} 个素材（恢复前自动留了 ${result.safetyBackup}）`);
      await refreshAll();
    } catch (err) {
      toastError(err);
    }
  }

  async function removeBackup(item) {
    try {
      await del(`/api/maintenance/backups/${item.name}`);
      toast('已删除备份');
      await refreshBackups();
    } catch (err) {
      toastError(err);
    }
  }

  async function saveAutoSettings() {
    try {
      const keep = Number(keepInput.value.trim() || '0');
      await put('/api/settings', { 'data.autoBackupOnStart': Boolean(autoToggle.checked), 'data.autoBackupKeep': keep });
      toast('已保存');
      await refreshBackups();
    } catch (err) {
      toastError(err);
    }
  }

  function renderScan(scan) {
    scanTargets.clear();
    const issueRows = (scan.issues ?? []).map((issue) => [
      issue.title,
      String(issue.count ?? 0),
      issue.summary ?? '',
      h('span', { class: `chip ${issue.count ? 'partial' : 'ready'}` }, issue.count ? '有问题' : '干净'),
    ]);
    const targetsBox = h(
      'div',
      { style: { marginTop: '12px' } },
      ...(scan.targets ?? []).map((target) => {
        const box = h('input', { type: 'checkbox', checked: Boolean(target.default) });
        scanTargets.set(target.id, box);
        return h('label', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '6px' } }, box, h('span', {}, `${target.title} —— ${target.summary}`));
      }),
      h('div', { style: { display: 'flex', gap: '8px', marginTop: '10px' } }, h('button', { class: 'btn primary', onclick: runCleanup }, '清理勾选的项'), h('button', { class: 'btn', onclick: refreshScan }, '重新体检')),
      h('div', { class: 'panel-note', style: { marginTop: '8px' } }, '清理前会自动留一份备份。清理只动上面查出来的东西，不会顺手删别的。'),
    );

    scanHost.replaceChildren(
      panel(
        '数据体检',
        scan.scannedAt ? `扫描于 ${String(scan.scannedAt).slice(11, 19)}` : null,
        issueRows.length ? table(['检查项', '数量', '说明', ''], issueRows) : emptyState({ icon: '🧾', title: '还没有体检结果' }),
        targetsBox,
      ),
    );
  }

  async function runCleanup() {
    try {
      const targets = [...scanTargets.entries()].filter(([, box]) => box.checked).map(([id]) => id);
      if (!targets.length) {
        toastError(new Error('先勾一项要清理的内容'));
        return;
      }
      const result = await post('/api/maintenance/cleanup', { targets });
      const total = Object.values(result.removed ?? {}).reduce((sum, value) => sum + Number(value ?? 0), 0);
      toast(`清理了 ${total} 项，释放 ${result.bytesText ?? '0 B'}（清理前备份：${result.safetyBackup ?? '无'}）`);
      await refreshAll();
    } catch (err) {
      toastError(err);
    }
  }

  async function refreshStats() {
    const payload = await get('/api/maintenance/stats');
    renderStats(payload);
  }

  async function refreshBackups() {
    const payload = await get('/api/maintenance/backups');
    renderBackups(payload);
  }

  async function refreshScan() {
    const payload = await post('/api/maintenance/scan', {});
    renderScan(payload);
  }

  async function refreshAll() {
    await Promise.all([refreshStats(), refreshBackups()]);
    await refreshScan();
  }

  async function mount() {
    statsHost.append(loading());
    backupHost.append(loading());
    renderExport();
    scanHost.append(loading());
    try {
      await refreshAll();
    } catch (err) {
      scanHost.replaceChildren(panel('数据体检', null, errorBox(err, { onRetry: mount })));
    }
  }

  return { el, mount };
}
