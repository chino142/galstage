/**
 * 卡编辑器：按字段表生成表单，绑定真实的角色卡数据。
 *
 * 能做：逐字段编辑并保存（每次保存留一版）、版本历史与回滚、收藏、
 *       换头像（PNG）、导出 PNG / JSON、删除。
 * 卡片来源：工作台里从列表点"编辑"通过 ctx.params.cardId 传进来；
 * 没有指定就显示一个选择器。
 */

import { h, statusChip } from '../core/dom.mjs';
import { get, put, post, del } from '../core/api.mjs';
import { panel, field, tabs, errorBox, emptyState } from '../ui/components.mjs';
import { openModal, confirmDialog } from '../ui/modal.mjs';
import { toast, toastError } from '../ui/toast.mjs';
import { openTextOutput } from '../ui/output.mjs';
import { t } from '../core/i18n.mjs';
import { createCardExtrasPanel } from './card-extras.mjs';
import { createCardChatsSection, openCardChat } from './card-chats.mjs';

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}

async function downloadExport(id, format, name) {
  const res = await fetch(`/api/characters/${id}/export?format=${format}`);
  if (!res.ok) throw new Error(`导出失败（${res.status}）`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: `${name}.${format === 'png' ? 'png' : 'json'}` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function createCardEditorView(module, ctx) {
  const el = h('div', { class: 'view' });
  const headerHost = h('div', {});
  const tabsHost = h('div', {});
  const body = h('div', {});

  let fields = [];
  let groups = [];
  let card = null;
  let controls = new Map();

  el.append(headerHost, tabsHost, body);

  // ---------------------------------------------------------------- 控制件

  function controlFor(item, value) {
    switch (item.type) {
      case 'text':
        return h('textarea', { rows: 6, placeholder: `${item.label}……` }, value ?? '');
      case 'list':
        return h('textarea', { rows: 4, placeholder: '一行一条' }, Array.isArray(value) ? value.join('\n') : '');
      case 'object':
        return h('textarea', { rows: 6, class: 'mono' }, value === undefined || value === null ? '' : JSON.stringify(value, null, 2));
      default:
        return h('input', { type: 'text', value: value ?? '' });
    }
  }

  function readControl(item, node) {
    if (item.type === 'list') {
      return String(node.value ?? '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    }
    if (item.type === 'object') {
      const text = node.value.trim();
      if (!text) return null;
      return JSON.parse(text); // 解析失败由调用方捕获并提示
    }
    return node.value;
  }

  // ---------------------------------------------------------------- 渲染

  function renderHeader() {
    const avatar = h(
      'div',
      { class: 'avatar-box' },
      card.avatarAssetId
        ? h('img', { src: `/api/characters/${card.id}/avatar?t=${Date.now()}`, alt: '' })
        : card.data?.extensions?.st_cover
          // 从平台导入的卡：封面常常不是 PNG（转不了卡头像），当年存进了素材库
          ? h('img', { src: `/api/assets/${encodeURIComponent(String(card.data.extensions.st_cover))}/file`, alt: '' })
          : h('div', { class: 'placeholder' }, '🃏'),
    );
    const avatarInput = h('input', {
      type: 'file',
      accept: 'image/png',
      style: { display: 'none' },
      onchange: async () => {
        const file = avatarInput.files?.[0];
        if (!file) return;
        try {
          await put(`/api/characters/${card.id}`, { avatar: await fileToBase64(file) });
          toast('头像已更新');
          await loadCard(card.id);
        } catch (err) {
          toastError(err);
        }
      },
    });

    headerHost.replaceChildren(
      panel(
        card.name,
        null,
        h(
          'div',
          { class: 'editor-head' },
          avatar,
          h(
            'div',
            { style: { flex: '1', minWidth: '220px' } },
            h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } }, statusChip('partial'), h('span', { class: 'panel-note' }, `${card.specVersion?.toUpperCase()} · ${card.versionCount ?? 0} 个版本 · 更新于 ${(card.updatedAt ?? '').slice(0, 19).replace('T', ' ')}`)),
            h('div', { class: 'chip-row', style: { marginTop: '8px' } }, (card.tags ?? []).map((tag) => h('span', { class: 'chip small' }, tag))),
          ),
          h(
            'div',
            { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
            h('button', { class: 'btn primary', onclick: () => save() }, '💾 保存'),
            h('button', { class: 'btn', onclick: () => showVersions() }, '🕘 版本历史'),
            h('button', { class: 'btn', onclick: () => toggleFavorite() }, card.favorite ? '★ 已收藏' : '☆ 收藏'),
            h('button', { class: 'btn', onclick: () => avatarInput.click() }, '🖼 换头像'),
            h('button', { class: 'btn', onclick: () => downloadExport(card.id, 'png', card.name).catch(toastError) }, '导出 PNG'),
            h('button', { class: 'btn', onclick: () => downloadExport(card.id, 'json', card.name).catch(toastError) }, '导出 JSON'),
            h('button', { class: 'btn', onclick: () => cardToScript(card) }, '🎬 一条龙：世界书 + 剧本'),
            h('button', { class: 'btn danger', onclick: () => removeCard() }, '删除'),
            avatarInput,
          ),
        ),
      ),
    );
  }

  function renderTabs() {
    const bar = tabs(groups, (id) => renderGroup(id));
    tabsHost.replaceChildren(h('div', { style: { marginTop: '14px' } }, bar.el));
    renderGroup(groups[0]?.id);
  }

  function renderGroup(groupId) {
    if (!card) return;
    const group = groups.find((item) => item.id === groupId);
    const list = fields.filter((item) => item.group === groupId && item.type !== 'image');
    controls = new Map();

    const nodes = list.map((item) => {
      const value = item.key === 'name' ? card.data.name : card.data[item.key];
      const node = controlFor(item, value);
      controls.set(item.key, node);
      const hint = `${item.spec === 'all' ? 'V1 / V2 / V3 通用' : item.spec.toUpperCase()} · ${item.path}`;
      return field(item.label, node, hint);
    });

    const chats = createCardChatsSection(card, ctx);
    void chats.refresh();
    body.replaceChildren(
      panel(
        group?.title ?? groupId,
        `${list.length} 个字段`,
        group?.summary ? h('div', { class: 'panel-note', style: { marginBottom: '14px' } }, group.summary) : null,
        nodes.length ? nodes : emptyState({ icon: '🌾', title: '这个分组没有可编辑的字段' }),
        h('div', { style: { display: 'flex', gap: '8px', marginTop: '6px' } },
          h('button', { class: 'btn primary', onclick: () => save() }, '保存这一版'),
          h('button', { class: 'btn', onclick: () => showVersions() }, '版本历史')),
      ),
      createCardExtrasPanel(card),
      chats.el,
    );
  }

  // ---------------------------------------------------------------- 动作

  function collect() {
    const data = { ...card.data };
    for (const item of fields) {
      if (item.type === 'image' || !controls.has(item.key)) continue;
      data[item.key] = readControl(item, controls.get(item.key));
    }
    if (!String(data.name ?? '').trim()) data.name = card.name;
    return data;
  }

  async function save() {
    let data;
    try {
      data = collect();
    } catch (err) {
      toast(`JSON 字段填错了：${err.message}`, { tone: 'error', duration: 4200 });
      return;
    }
    try {
      const updated = await put(`/api/characters/${card.id}`, { data, name: data.name, note: '编辑保存' });
      card = updated;
      renderHeader();
      renderTabs();
      toast('已保存（留了一个版本）');
    } catch (err) {
      toastError(err);
    }
  }

  /**
   * 一条龙（蓝图 3.2）：这张卡 → 该进世界书的设定 + 分场剧本。
   * 走的是写卡助手的技能机制（服务端 /api/creative/card-to-script → script.fromCard）。
   */
  function cardToScript(target) {
    const actsInput = h('input', { type: 'number', value: '3', min: '1', max: '8' });
    const saveInput = h('input', { type: 'checkbox', checked: true });
    openModal({
      title: '角色卡 → 世界书 → 剧本',
      body: h(
        'div',
        {},
        field('分几幕', actsInput, '1 ~ 8'),
        h('label', { class: 'switch-row' }, saveInput, h('span', {}, '顺手把抽出的设定存成一本世界书')),
        h('div', { class: 'hint' }, '先整理"模型容易忘但剧情需要"的设定（人物、地点、规则），再排出分场剧本与关键节拍。'),
      ),
      actions: [
        { label: t('btn.cancel') },
        {
          label: '开始生成',
          primary: true,
          onClick: async () => {
            try {
              const result = await post('/api/creative/card-to-script', {
                characterId: target.id,
                acts: Number(actsInput.value) || 3,
                saveWorldbook: saveInput.checked,
              });
              const entries = (result.worldbook ?? []).map(
                (entry) => `### ${entry.comment || entry.name || ''}\n关键词：${(entry.keys ?? []).join('、')}\n${entry.content}`,
              );
              const text = [
                result.title ? `# ${result.title}` : '',
                result.logline ? `> ${result.logline}` : '',
                result.script || '',
                entries.length ? `\n\n---\n\n## 世界书条目（${entries.length}）\n\n${entries.join('\n\n')}` : '',
              ]
                .filter(Boolean)
                .join('\n');
              openTextOutput({
                title: result.title || `${target.name} 的剧本`,
                text,
                filename: `${result.title || target.name || 'script'}.md`,
                meta: h(
                  'div',
                  { class: 'output-meta' },
                  `世界书 ${result.worldbook?.length ?? 0} 条 · 场次 ${result.scenes?.length ?? 0}` +
                    (result.savedWorldbook ? ` · 已存进《${result.savedWorldbook.name}》（${result.savedWorldbook.added} 条）` : ''),
                ),
              });
              if (result.savedWorldbook) toast(`世界书《${result.savedWorldbook.name}》已保存`);
            } catch (err) {
              toastError(err);
              return false; // 失败时保留弹窗
            }
          },
        },
      ],
    });
  }

  async function toggleFavorite() {
    try {
      card = await put(`/api/characters/${card.id}`, { favorite: !card.favorite });
      renderHeader();
    } catch (err) {
      toastError(err);
    }
  }

  async function removeCard() {
    const ok = await confirmDialog({ title: '删除角色卡', message: `确定删掉「${card.name}」吗？`, confirmLabel: '删除' });
    if (!ok) return;
    try {
      await del(`/api/characters/${card.id}`);
      toast('已删除');
      card = null;
      await mount();
    } catch (err) {
      toastError(err);
    }
  }

  async function showVersions() {
    let versions;
    try {
      versions = await get(`/api/characters/${card.id}/versions`);
    } catch (err) {
      toastError(err);
      return;
    }
    const list = versions.items.map((version) =>
      h(
        'div',
        { class: 'version-row' },
        h('div', {}, h('div', { style: { fontWeight: '600' } }, version.note || '（无备注）'), h('div', { class: 'panel-note' }, `${(version.createdAt ?? '').slice(0, 19).replace('T', ' ')} · ${version.data?.name ?? ''}`)),
        h('button', {
          class: 'btn small',
          onclick: async () => {
            const ok = await confirmDialog({ title: '回滚版本', message: '当前内容会先自动留一版，再回到这个版本。', confirmLabel: '回滚' });
            if (!ok) return;
            try {
              card = await post(`/api/characters/${card.id}/versions/${version.id}/restore`, {});
              toast('已回滚');
              renderHeader();
              renderTabs();
            } catch (err) {
              toastError(err);
            }
          },
        }, '回滚到这一版'),
      ),
    );
    openModal({
      title: `版本历史 · ${card.name}`,
      width: '620px',
      body: h('div', { class: 'version-list' }, list.length ? list : emptyState({ icon: '🕘', title: '还没有版本' })),
    });
  }

  // ---------------------------------------------------------------- 选择器 / 装载

  async function showPicker() {
    headerHost.replaceChildren(panel('卡编辑器', null, h('div', { class: 'panel-note' }, '从下面选一张卡来编辑；新建 / 导入在上面「我的角色卡」那一块。')));
    tabsHost.replaceChildren();
    body.replaceChildren(emptyState({ icon: '🃏', title: '读取卡列表……' }));
    try {
      const data = await get('/api/characters?limit=200');
      body.replaceChildren(
        panel(
          '选择要编辑的卡',
          `${data.total} 张`,
          data.items.length
            ? h('div', { class: 'picker-list' }, data.items.map((item) => h('button', { class: 'picker-item', onclick: () => loadCard(item.id) }, `${item.favorite ? '★ ' : ''}${item.name}`, h('span', { class: 'panel-note' }, `${item.specVersion?.toUpperCase()} · ${(item.data?.description ?? '').slice(0, 30)}`))))
            : emptyState({ icon: '🃏', title: '卡库是空的', desc: '先去上面「我的角色卡」导入或新建一张。' }),
        ),
      );
    } catch (err) {
      body.replaceChildren(panel('选择要编辑的卡', null, errorBox(err, { onRetry: () => void showPicker() })));
    }
  }

  async function loadCard(id) {
    try {
      const loaded = await get(`/api/characters/${id}`);
      card = loaded;
      renderHeader();
      renderTabs();
    } catch (err) {
      card = null;
      headerHost.replaceChildren(panel('卡编辑器', null, errorBox(err, { onRetry: () => void showPicker() })));
      tabsHost.replaceChildren();
      body.replaceChildren();
    }
  }

  async function mount() {
    try {
      const data = await get('/api/characters/fields');
      fields = data.items;
      groups = data.groups ?? [];
    } catch (err) {
      body.replaceChildren(panel('卡编辑器', null, errorBox(err)));
      return;
    }
    const cardId = ctx.params?.cardId;
    if (cardId) return loadCard(cardId);
    return showPicker();
  }

  return { el, mount };
}
