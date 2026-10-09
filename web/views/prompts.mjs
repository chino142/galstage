/**
 * 提示词工作台：阶段表、组装预览（带"踢掉一段"）、预设库、自定义宏、正则脚本。
 */

import { h, statusChip, STATUS_LABEL } from '../core/dom.mjs';
import { get, post, put, del } from '../core/api.mjs';
import { panel, table, emptyState, errorBox, field, kv } from '../ui/components.mjs';
import { openModal, confirmDialog } from '../ui/modal.mjs';
import { toast, toastError } from '../ui/toast.mjs';

function fileToText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'));
    reader.readAsText(file);
  });
}

export function createPromptsView(module, ctx) {
  const el = h('div', { class: 'view' });
  const host = h('div', {});
  let meta = null;
  let cards = [];
  let lastPreview = null;

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
      const [metaRes, cardRes] = await Promise.all([get('/api/prompts/meta'), get('/api/characters?limit=200')]);
      meta = metaRes;
      cards = cardRes.items;
      const [presets, macros, regex] = await Promise.all([get('/api/prompts/presets'), get('/api/prompts/macros'), get('/api/prompts/regex')]);
      host.replaceChildren(
        stagePanel(),
        previewPanel(),
        presetPanel(presets.items),
        macroPanel(macros.items),
        regexPanel(regex.items),
      );
    } catch (err) {
      host.replaceChildren(panel('提示词', null, errorBox(err, { onRetry: () => void refresh() })));
    }
  }

  function stagePanel() {
    return panel(
      '提示词管线',
      `${meta.stages.length} 个阶段，顺序即规格`,
      table(
        ['阶段', '角色', '状态', '说明'],
        meta.stages.map((stage) => [h('span', { class: 'mono' }, stage.id), stage.role, h('span', { class: `chip ${stage.status}` }, STATUS_LABEL[stage.status] ?? stage.status), stage.note]),
      ),
    );
  }

  function previewPanel() {
    const cardSelect = h(
      'select',
      {},
      [h('option', { value: '' }, '（不选卡，用内置默认）'), ...cards.map((card) => h('option', { value: card.id }, card.name))],
    );
    const userText = h('textarea', { rows: 2, placeholder: '可选：模拟一句用户输入，看看世界书 / 历史怎么排……' });
    const out = h('div', {});

    async function run() {
      try {
        const body = { settings: { contextBudget: 8000 } };
        const cardId = cardSelect.value;
        if (cardId) {
          const card = await get(`/api/characters/${cardId}`);
          body.card = card.data;
        }
        if (userText.value.trim()) body.history = [{ role: 'user', content: userText.value.trim() }];
        lastPreview = await post('/api/prompts/preview', body);
        renderPreview(out, lastPreview);
      } catch (err) {
        toastError(err);
      }
    }

    out.append(h('div', { class: 'panel-note' }, '点「组装一次」，下面会列出这轮真正会发出去的每一段。'));
    return panel(
      '组装预览',
      'X 光机的写卡区入口',
      h('div', { class: 'grid-2' }, field('角色卡', cardSelect), field('模拟输入', userText)),
      h('div', { style: { marginTop: '8px' } }, h('button', { class: 'btn primary', onclick: run }, '组装一次')),
      out,
    );
  }

  function renderPreview(out, preview) {
    const drop = new Set();
    const recomputeHost = h('div', {});
    const rows = preview.sections.map((section) =>
      h('div', { class: 'reason-row' },
        h('label', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
          h('input', { type: 'checkbox', onchange: (event) => { if (event.target.checked) drop.add(section.id); else drop.delete(section.id); } }),
          h('span', {}, `${section.title} `, h('span', { class: 'mono panel-note' }, section.id))),
        h('span', { class: 'panel-note' }, `${section.role} · ${section.tokens} tok · ${section.source}`)),
    );

    recomputeHost.append(
      h('div', { class: 'panel-note', style: { marginTop: '8px' } }, `共 ${preview.sections.length} 段，合计 ${preview.tokens.total} token`),
      h('div', { class: 'reason-list' }, rows),
      h('div', { style: { marginTop: '8px', display: 'flex', gap: '8px' } },
        h('button', { class: 'btn', onclick: async () => {
          try {
            const kicked = await post('/api/prompts/preview', { sections: preview.sections, dropSections: [...drop], messages: [] });
            toast(`踢掉后剩 ${kicked.tokens.total} token`);
            showText(kicked);
          } catch (err) { toastError(err); }
        } }, '踢掉勾选的段，重算'),
        h('button', { class: 'btn', onclick: () => showText(preview) }, '看完整文本')),
    );
    out.replaceChildren(recomputeHost);
  }

  function showText(preview) {
    openModal({
      title: '这一轮要发出去的内容',
      width: '760px',
      body: h('pre', { class: 'text-preview' }, preview.text || '（空）'),
      actions: [{ label: '关闭' }],
    });
  }

  function presetPanel(items) {
    const fileInput = h('input', { type: 'file', accept: '.json', multiple: true, style: { display: 'none' }, onchange: async () => {
      try {
        for (const file of fileInput.files) {
          await post('/api/prompts/presets/import', { name: file.name.replace(/\.json$/i, ''), document: JSON.parse(await fileToText(file)) });
        }
        toast('预设已导入');
        await refresh();
      } catch (err) { toastError(err); }
    } });
    return panel(
      '预设库',
      `${items.length} 套`,
      h('div', { class: 'panel-note' }, '导入后要在「对话」页输入框上方的「提示词预设」里选中它，才会真的用于组装。'),
      h('div', { style: { display: 'flex', gap: '8px', marginBottom: '10px' } },
        h('button', { class: 'btn primary', onclick: () => fileInput.click() }, '⬆ 导入酒馆预设'),
        fileInput),
      items.length
        ? table(['名字', '提示数', '来源', '操作'], items.map((preset) => [
            preset.name,
            Array.isArray(preset.data?.prompts) ? preset.data.prompts.length : 0,
            preset.source,
            h('div', { style: { display: 'flex', gap: '6px' } },
              h('button', { class: 'btn small', onclick: () => window.open(`/api/prompts/presets/${preset.id}/export`) }, '导出'),
              h('button', { class: 'btn small danger', onclick: async () => {
                if (!(await confirmDialog({ title: '删除预设', message: `确定删掉「${preset.name}」吗？`, confirmLabel: '删除' }))) return;
                await del(`/api/prompts/presets/${preset.id}`); await refresh();
              } }, '删除')),
          ]))
        : emptyState({ icon: '📦', title: '还没有预设', desc: '导入一份酒馆预设 JSON 就能用它的提示词队列。' }),
    );
  }

  function macroPanel(items) {
    const nameInput = h('input', { type: 'text', placeholder: '宏名（不含花括号）' });
    const valueInput = h('input', { type: 'text', placeholder: '展开成什么' });
    return panel(
      '自定义宏',
      `${items.length} 个`,
      h('div', { class: 'grid-2' }, field('宏名', nameInput), field('值', valueInput)),
      h('div', { style: { marginTop: '8px' } }, h('button', { class: 'btn primary', onclick: async () => {
        try {
          await post('/api/prompts/macros', { name: nameInput.value.trim(), value: valueInput.value });
          toast('已保存');
          await refresh();
        } catch (err) { toastError(err); }
      } }, '添加 / 覆盖')),
      items.length
        ? table(['宏', '值', ''], items.map((item) => [h('span', { class: 'mono' }, `{{${item.name}}}`), item.value, h('button', { class: 'btn small danger', onclick: async () => { await del(`/api/prompts/macros/${encodeURIComponent(item.name)}`); await refresh(); } }, '删除')]))
        : h('div', { class: 'panel-note', style: { marginTop: '10px' } }, '还没有自定义宏'),
    );
  }

  function regexPanel(items) {
    return panel(
      '正则脚本',
      `${items.length} 条`,
      h('div', { style: { marginBottom: '10px' } }, h('button', { class: 'btn primary', onclick: () => editRegex(null) }, '＋ 新建脚本')),
      items.length
        ? table(['名字', '匹配', '替换', '位置', '操作'], items.map((script) => [
            script.scriptName,
            h('span', { class: 'mono' }, script.findRegex),
            h('span', { class: 'mono' }, script.replaceString),
            (script.placement ?? []).map((value) => meta.placements.find((option) => option.value === value)?.label ?? value).join('、') || '—',
            h('div', { style: { display: 'flex', gap: '6px' } },
              h('button', { class: 'btn small', onclick: () => editRegex(script) }, '编辑'),
              h('button', { class: 'btn small danger', onclick: async () => {
                if (!(await confirmDialog({ title: '删除脚本', message: `确定删掉「${script.scriptName}」吗？`, confirmLabel: '删除' }))) return;
                await del(`/api/prompts/regex/${script.id}`); await refresh();
              } }, '删除')),
          ]))
        : emptyState({ icon: '🔧', title: '还没有正则脚本', desc: '发送前改写用户输入，或收到后改写 AI 输出。' }),
    );
  }

  function editRegex(script) {
    const name = h('input', { type: 'text', value: script?.scriptName ?? '' });
    const find = h('input', { type: 'text', class: 'mono', value: script?.findRegex ?? '', placeholder: '/阿狸/g' });
    const replace = h('input', { type: 'text', class: 'mono', value: script?.replaceString ?? '', placeholder: '小狸' });
    const trim = h('input', { type: 'text', value: (script?.trimStrings ?? []).join(',') });
    const minDepth = h('input', { type: 'number', value: script?.minDepth ?? '' });
    const maxDepth = h('input', { type: 'number', value: script?.maxDepth ?? '' });
    const markdownOnly = h('input', { type: 'checkbox', checked: Boolean(script?.markdownOnly) });
    const promptOnly = h('input', { type: 'checkbox', checked: Boolean(script?.promptOnly) });
    const placements = (meta.placements ?? []).map((option) => ({ option, node: h('input', { type: 'checkbox', checked: (script?.placement ?? []).includes(option.value) }) }));
    openModal({
      title: script ? '编辑正则脚本' : '新建正则脚本',
      width: '660px',
      body: h('div', {},
        field('名字', name),
        field('匹配（/pattern/flags）', find),
        field('替换（可用 $1 与 {{match}}）', replace),
        field('先去掉这些片段（逗号分隔）', trim),
        h('div', { class: 'grid-2' }, field('最小深度', minDepth), field('最大深度', maxDepth)),
        h('div', { class: 'chip-row' }, field('只改显示', markdownOnly), field('只改提示词', promptOnly)),
        h('div', { class: 'panel-note', style: { margin: '8px 0 4px' } }, '作用位置'),
        h('div', { class: 'chip-row' }, placements.map((entry) => field(entry.option.label, entry.node)))),
      actions: [
        { label: '取消' },
        { label: '保存', primary: true, onClick: async () => {
          const payload = {
            id: script?.id,
            name: name.value.trim() || '正则脚本',
            findRegex: find.value,
            replaceString: replace.value,
            trimStrings: trim.value.split(',').map((item) => item.trim()).filter(Boolean),
            placement: placements.filter((entry) => entry.node.checked).map((entry) => entry.option.value),
            minDepth: minDepth.value === '' ? null : Number(minDepth.value),
            maxDepth: maxDepth.value === '' ? null : Number(maxDepth.value),
            markdownOnly: markdownOnly.checked,
            promptOnly: promptOnly.checked,
          };
          try {
            if (script) await put(`/api/prompts/regex/${script.id}`, payload);
            else await post('/api/prompts/regex', payload);
            await refresh();
          } catch (err) { toastError(err); return false; }
          return true;
        } },
      ],
    });
  }

  return { el, mount: refresh };
}
