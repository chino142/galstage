/**
 * 工坊：把三份调研里"值得抄"的东西收在一个入口。
 *
 * 九个页签：写卡质检 / 建卡向导 / 世界书 / Markdown 卡 /
 * 临场指令 / 采样器 / 套装 / 分支图 / 模型能力。
 *
 * 判断逻辑全在 core/ 里（能单测），这里只负责取数与显示。
 */

import { h, statusChip } from '../core/dom.mjs';
import { get, post, put, del } from '../core/api.mjs';
import { panel, field, errorBox, loading, emptyState, table } from '../ui/components.mjs';
import { toast, toastError } from '../ui/toast.mjs';
import { confirmDialog } from '../ui/modal.mjs';

const TABS = [
  { id: 'quality', title: '写卡质检' },
  { id: 'wizard', title: '建卡向导' },
  { id: 'worldbook', title: '世界书' },
  { id: 'markdown', title: 'Markdown 卡' },
  { id: 'notes', title: '临场指令' },
  { id: 'samplers', title: '采样器' },
  { id: 'loadouts', title: '套装' },
  { id: 'branches', title: '分支图' },
  { id: 'capabilities', title: '模型能力' },
  { id: 'vision', title: '视觉' },
  { id: 'translate', title: '翻译' },
  { id: 'bookmarks', title: '书签' },
  { id: 'actions', title: '动作序列' },
  { id: 'logit', title: 'Logit Bias' },
  { id: 'handoff', title: '导出与抓料' },
];

const GRADE_LABEL = { publish: '可发布', usable: '可用（带弱项）', revise: '建议再改' };
const NOTE_POSITION_LABEL = { before: '角色定义之前', after: '角色定义之后', atDepth: '指定深度' };

export function createStudioView(module) {
  const el = h('div', { class: 'view' });
  const host = h('div', {});
  const state = {
    tab: 'quality',
    cards: [],
    cardId: '',
    quality: null,
    options: null,
    notation: { text: '', result: null, map: null },
    markdown: { text: '' },
    notes: { characterId: '', chatId: '', data: null },
    samplers: { meta: null, registry: null, current: null, backend: 'llamacpp' },
    loadouts: { meta: null, registry: null },
    branches: { data: null },
    capabilities: null,
  };

  el.append(
    panel(
      module.title,
      null,
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } }, statusChip(module.status), h('span', { class: 'panel-note' }, module.summary ?? '')),
    ),
    host,
  );

  function tabBar() {
    return h(
      'div',
      { style: { display: 'flex', flexWrap: 'wrap', gap: '6px', margin: '8px 0' } },
      ...TABS.map((tab) =>
        h(
          'button',
          {
            class: tab.id === state.tab ? 'btn' : 'link-btn',
            onclick: () => {
              state.tab = tab.id;
              void render();
            },
          },
          tab.title,
        ),
      ),
    );
  }

  function copyable(label, text) {
    return h(
      'div',
      { style: { marginTop: '8px' } },
      h(
        'div',
        { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' } },
        h('strong', {}, label),
        h(
          'button',
          {
            class: 'link-btn',
            onclick: async () => {
              try {
                await navigator.clipboard.writeText(String(text ?? ''));
                toast('已复制');
              } catch {
                toastError(new Error('剪贴板不可用'));
              }
            },
          },
          '复制',
        ),
      ),
      h('pre', { style: { whiteSpace: 'pre-wrap', maxHeight: '300px', overflow: 'auto', background: 'rgba(0,0,0,0.18)', padding: '8px', borderRadius: '6px' } }, String(text ?? '')),
    );
  }

  function cardPicker(onPick) {
    const select = h(
      'select',
      {
        onchange: (event) => {
          state.cardId = event.target.value;
          onPick();
        },
      },
      h('option', { value: '' }, '— 选一张卡 —'),
      ...state.cards.map((card) => h('option', { value: card.id }, card.name ?? card.id)),
    );
    select.value = state.cardId;
    return field('角色卡', select);
  }

  async function ensureCards() {
    if (state.cards.length) return;
    const result = await get('/api/characters?limit=300');
    state.cards = result.items ?? [];
  }

  // ---------------------------------------------------------------- 写卡质检

  async function renderQuality() {
    await ensureCards();
    const report = state.quality;
    const body = [cardPicker(() => void refreshQuality())];
    if (!report) {
      body.push(h('div', { class: 'panel-note' }, '选一张卡，看它离「可发布」还差什么。'));
    } else {
      body.push(
        h(
          'div',
          { style: { display: 'flex', gap: '14px', alignItems: 'baseline', flexWrap: 'wrap', margin: '8px 0' } },
          h('span', { style: { fontSize: '30px', fontWeight: '700' } }, String(report.total)),
          h('span', {}, GRADE_LABEL[report.grade] ?? report.grade),
          h('span', { class: 'panel-note' }, `${report.summary.errors} 个硬伤 / ${report.summary.warns} 个提醒 / ${report.summary.infos} 条建议`),
        ),
        table(['维度', '得分', '满分', '说明'], report.dimensions.map((dim) => [dim.title, String(dim.earned), String(dim.max), dim.detail ?? ''])),
        panel(
          '开场白九项硬检',
          `${report.opening.passed}/${report.opening.total}`,
          h('ul', {}, ...report.opening.items.map((item) => h('li', {}, `${item.ok ? '✅' : '⬜'} ${item.title}${item.ok ? '' : ` — ${item.hint}`}`))),
        ),
        report.flavor.hits.length
          ? panel(
              '句式病灶',
              `${report.flavor.hits.length} 类`,
              h('ul', {}, ...report.flavor.hits.map((hit) => h('li', {}, `${hit.title}：出现 ${hit.count} 次（配额 ${hit.quota}）${hit.samples.length ? `　例：${hit.samples.join(' / ')}` : ''}`))),
            )
          : panel('句式病灶', '没有命中', h('div', { class: 'panel-note' }, '终检法：把简介和开场白读出声，凡是读到某句心里冒出「这句真妙」，十有八九要改平。妙感密度就是 AI 浓度。')),
        panel(
          '作者的话七要素',
          `${report.creatorNotes.passed}/${report.creatorNotes.total}`,
          h('ul', {}, ...report.creatorNotes.items.map((item) => h('li', {}, `${item.ok ? '✅' : '⬜'} ${item.title} — ${item.hint}`))),
          report.creatorNotes.clean ? null : h('div', { class: 'panel-note' }, `出现了产品词：${report.creatorNotes.productWords.join('、')}。作者的话要像社区写手碎碎念。`),
        ),
        report.issues.length
          ? panel('问题清单', `${report.issues.length} 条`, h('ul', {}, ...report.issues.slice(0, 40).map((issue) => h('li', {}, `[${issue.level}] ${issue.message}`))))
          : null,
      );
    }
    return [panel('写卡质检', '七病灶 · 九项硬检 · 八维评分', ...body.filter(Boolean))];
  }

  async function refreshQuality() {
    if (!state.cardId) {
      state.quality = null;
      await render();
      return;
    }
    try {
      state.quality = await get(`/api/studio/quality/${encodeURIComponent(state.cardId)}`);
      await render();
    } catch (err) {
      toastError(err);
    }
  }

  // ---------------------------------------------------------------- 建卡向导

  async function renderWizard() {
    if (!state.options) state.options = await get('/api/studio/wizard/options');
    const opts = state.options;
    const picks = { orientation: '全性向', genre: '都市', purity: '不洁', hooks: ['难攻略'], paradigm: 'event', name: '' };
    const controls = [
      field('角色名', h('input', { class: 'text_pole', placeholder: '例如：沈知夏', oninput: (event) => { picks.name = event.target.value; } })),
    ];
    for (const axis of opts.axes) {
      if (axis.multiple) {
        controls.push(
          field(
            `${axis.title}（最多 ${axis.max}）`,
            h(
              'div',
              { style: { display: 'flex', flexWrap: 'wrap', gap: '6px' } },
              ...axis.options.map((option) =>
                h(
                  'label',
                  { class: 'checkbox_label' },
                  h('input', {
                    type: 'checkbox',
                    checked: picks.hooks.includes(option),
                    onchange: (event) => {
                      const set = new Set(picks.hooks);
                      if (event.target.checked) set.add(option);
                      else set.delete(option);
                      picks.hooks = [...set].slice(0, axis.max);
                    },
                  }),
                  h('span', {}, option),
                ),
              ),
            ),
            '情绪钩子决定爽点承诺，也进标签。',
          ),
        );
      } else {
        const select = h('select', { onchange: (event) => { picks[axis.id] = event.target.value; } }, ...axis.options.map((option) => h('option', { value: option }, option)));
        select.value = picks[axis.id];
        controls.push(field(axis.title + (axis.required ? '（必选）' : ''), select));
      }
    }
    const paradigm = h('select', { onchange: (event) => { picks.paradigm = event.target.value; } }, ...opts.paradigms.map((item) => h('option', { value: item.id }, `${item.title} — ${item.fit}`)));
    controls.push(field('开场白范式', paradigm));

    const preview = h('div', {});
    return [
      panel(
        '建卡向导',
        '四元组 → 标签 + 骨架',
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '10px' } }, ...controls),
        h(
          'button',
          {
            class: 'btn',
            style: { marginTop: '8px' },
            onclick: async () => {
              try {
                const draft = await post('/api/studio/wizard/draft', picks);
                preview.replaceChildren(
                  copyable('标签', draft.tags.join(', ')),
                  copyable('创作定位（只进 frontmatter 注释，别写进作者的话）', draft.plan.positioning),
                  copyable('system_prompt 骨架（含输出节奏四律）', draft.fields.system_prompt),
                  copyable('作者的话模板（七要素）', draft.fields.creator_notes),
                  copyable('开场白骨架', draft.fields.first_mes),
                );
              } catch (err) {
                toastError(err);
              }
            },
          },
          '生成草稿',
        ),
        preview,
      ),
    ];
  }

  // ---------------------------------------------------------------- 世界书

  async function renderWorldbook() {
    const textarea = h('textarea', {
      class: 'text_pole',
      rows: 10,
      placeholder: '### 老板娘 | keys: 酒馆, 打烊 | order: 250\n正文……',
      oninput: (event) => {
        state.notation.text = event.target.value;
      },
    });
    textarea.value = state.notation.text;
    const result = state.notation.result;
    const blocks = [
      panel(
        '世界书一行语法',
        '批量粘贴建条目',
        field('条目文本', textarea, '缺省 keys 的条目会自动当成常开，避免产出永远不触发的死条目'),
        h(
          'div',
          { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '8px' } },
          h(
            'button',
            {
              class: 'btn',
              onclick: async () => {
                try {
                  state.notation.result = await post('/api/studio/worldbook/notation/parse', { text: state.notation.text });
                  await render();
                } catch (err) {
                  toastError(err);
                }
              },
            },
            '解析',
          ),
          h(
            'button',
            {
              class: 'link-btn',
              onclick: async () => {
                try {
                  const books = await get('/api/worldbook');
                  const items = books.items ?? [];
                  if (!items.length) {
                    toast('还没有世界书');
                    return;
                  }
                  const report = await get(`/api/studio/worldbook/${encodeURIComponent(items[0].id)}/map`);
                  state.notation.map = { book: items[0], report };
                  await render();
                } catch (err) {
                  toastError(err);
                }
              },
            },
            '看第一本世界书的递归地图',
          ),
          h(
            'button',
            {
              class: 'link-btn',
              onclick: async () => {
                try {
                  const books = await get('/api/worldbook');
                  const first = (books.items ?? [])[0];
                  if (!first) {
                    toast('还没有世界书');
                    return;
                  }
                  const result = await post(`/api/studio/worldbook/${encodeURIComponent(first.id)}/from-memory`, { limit: 50 });
                  toast(`从记忆导入了 ${result.imported} 条（跳过 ${result.skipped.length} 条）`);
                  await render();
                } catch (err) {
                  toastError(err);
                }
              },
            },
            '把记忆转成世界书条目（导进第一本）',
          ),
        ),
      ),
    ];
    if (result) {
      blocks.push(
        panel(
          '解析结果',
          `${result.entries.length} 条 / ${result.errors.length} 个问题`,
          table(
            ['条目名', 'keys', 'order', '位置', '生成动作'],
            result.entries.map((entry) => [
              entry.comment,
              (entry.keys ?? []).join(', ') || '（常开）',
              String(entry.order),
              String(entry.position),
              (entry.injectionTrigger ?? []).join(', ') || '任意',
            ]),
          ),
          result.errors.length ? h('ul', {}, ...result.errors.map((item) => h('li', {}, `第 ${item.line} 行：${item.message}`))) : null,
        ),
        panel(
          '条目体检',
          `${result.lint.issues.length} 条`,
          result.lint.issues.length
            ? h('ul', {}, ...result.lint.issues.map((item) => h('li', {}, `[${item.level}] ${item.name}：${item.message}`)))
            : h('div', { class: 'panel-note' }, '没有发现问题。'),
        ),
      );
    }
    if (state.notation.map) {
      const { book, report } = state.notation.map;
      const nameOf = (id) => report.nodes.find((node) => node.id === id)?.name ?? id;
      blocks.push(
        panel(
          `递归地图：${book.name ?? book.id}`,
          `${report.nodes.length} 条 / ${report.edges.length} 条边`,
          report.cycles.length
            ? h('div', { class: 'panel-note' }, `发现环：${report.cycles.map((cycle) => cycle.join(' → ')).join('；')}（深链末端建议加 recursion: prevent）`)
            : h('div', { class: 'panel-note' }, '没有环。'),
          h('ul', {}, ...report.edges.slice(0, 60).map((edge) => h('li', {}, `${nameOf(edge.from)} → ${nameOf(edge.to)}`))),
        ),
      );
    }
    return blocks;
  }

  // ---------------------------------------------------------------- Markdown 卡

  async function renderMarkdown() {
    await ensureCards();
    const textarea = h('textarea', {
      class: 'text_pole',
      rows: 12,
      placeholder: '---\nname: 角色名\ntags: [限左, 都市]\n---\n## Description\n……\n## Lorebook\n### 条目 | keys: a, b\n……',
      oninput: (event) => {
        state.markdown.text = event.target.value;
      },
    });
    textarea.value = state.markdown.text;
    const out = h('div', {});
    return [
      panel(
        'Markdown → 卡',
        '角色卡是散文，写成 Markdown 才可 diff、可分工',
        field('Card.md', textarea),
        h(
          'div',
          { style: { display: 'flex', gap: '12px', flexWrap: 'wrap', marginTop: '8px', alignItems: 'flex-end' } },
          h(
            'button',
            {
              class: 'btn',
              onclick: async () => {
                try {
                  const parsed = await post('/api/studio/cards/markdown/parse', { markdown: state.markdown.text });
                  out.replaceChildren(
                    h('div', {}, `识别到字段：${Object.keys(parsed.card).filter((key) => key !== 'extensions').join('、') || '（无）'}`),
                    h('div', {}, `世界书条目：${parsed.lorebook.length} 条；评分 ${parsed.lint.total}`),
                    parsed.unknowns.length ? h('div', { class: 'panel-note' }, `未识别的章节（已原样保留）：${parsed.unknowns.join('、')}`) : null,
                    copyable('转换出的卡 JSON', JSON.stringify(parsed.card, null, 2)),
                  );
                } catch (err) {
                  toastError(err);
                }
              },
            },
            '解析',
          ),
          h(
            'div',
            { style: { minWidth: '220px' } },
            cardPicker(async () => {
              if (!state.cardId) return;
              try {
                const result = await get(`/api/studio/cards/${encodeURIComponent(state.cardId)}/markdown`);
                out.replaceChildren(copyable('导出的 Markdown', result.markdown));
              } catch (err) {
                toastError(err);
              }
            }),
          ),
        ),
        out,
      ),
    ];
  }

  // ---------------------------------------------------------------- 临场指令

  function noteEditor(scope, scopeId, initial) {
    const note = { position: 'before', role: 'system', depth: 4, interval: 1, ...initial };
    const prompt = h('textarea', {
      class: 'text_pole',
      rows: 3,
      placeholder: '例如：这一章写慢一点，多写环境。',
      oninput: (event) => {
        note.prompt = event.target.value;
      },
    });
    prompt.value = note.prompt ?? '';
    const position = h('select', { onchange: (event) => { note.position = event.target.value; } },
      ...Object.entries(NOTE_POSITION_LABEL).map(([value, label]) => h('option', { value }, label)));
    position.value = note.position;
    const role = h('select', { onchange: (event) => { note.role = event.target.value; } }, ...['system', 'user', 'assistant'].map((value) => h('option', { value }, value)));
    role.value = note.role;
    const depth = h('input', { class: 'text_pole', type: 'number', min: '0', value: String(note.depth ?? 4), oninput: (event) => { note.depth = Number(event.target.value); } });
    const interval = h('input', { class: 'text_pole', type: 'number', min: '0', value: String(note.interval ?? 1), oninput: (event) => { note.interval = Number(event.target.value); } });
    return panel(
      `${scope} 层`,
      scopeId || null,
      field('内容', prompt),
      h(
        'div',
        { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '8px' } },
        field('位置', position),
        field('以什么身份', role),
        field('深度', depth),
        field('每 N 条用户输入插一次', interval, '1 = 每轮都插'),
      ),
      h(
        'button',
        {
          class: 'btn',
          style: { marginTop: '6px' },
          onclick: async () => {
            try {
              await put(`/api/studio/notes/${scope}/${encodeURIComponent(scopeId || '-')}`, note);
              toast('已保存');
              await refreshNotes();
            } catch (err) {
              toastError(err);
            }
          },
        },
        '保存这一层',
      ),
    );
  }

  async function renderNotes() {
    const charInput = h('input', { class: 'text_pole', placeholder: '角色卡 id（可选）', oninput: (event) => { state.notes.characterId = event.target.value; } });
    charInput.value = state.notes.characterId;
    const chatInput = h('input', { class: 'text_pole', placeholder: '对话 id（可选）', oninput: (event) => { state.notes.chatId = event.target.value; } });
    chatInput.value = state.notes.chatId;
    const layers = state.notes.data?.layers ?? {};
    return [
      panel(
        '临场指令（作者注）',
        '三层作用域：对话 > 角色 > 默认',
        h(
          'div',
          { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '8px' } },
          field('角色 id', charInput),
          field('对话 id', chatInput),
        ),
        h('button', { class: 'link-btn', style: { marginTop: '6px' }, onclick: () => void refreshNotes() }, '读取三层'),
        state.notes.data ? h('div', { class: 'panel-note' }, `当前生效：${state.notes.data.summary}`) : null,
      ),
      noteEditor('default', '', layers.default ?? {}),
      state.notes.characterId ? noteEditor('character', state.notes.characterId, layers.character ?? {}) : null,
      state.notes.chatId ? noteEditor('chat', state.notes.chatId, layers.chat ?? {}) : null,
    ].filter(Boolean);
  }

  async function refreshNotes() {
    try {
      const query = new URLSearchParams();
      if (state.notes.characterId) query.set('characterId', state.notes.characterId);
      if (state.notes.chatId) query.set('chatId', state.notes.chatId);
      state.notes.data = await get(`/api/studio/notes?${query.toString()}`);
      await render();
    } catch (err) {
      toastError(err);
    }
  }

  // ---------------------------------------------------------------- 采样器

  async function renderSamplers() {
    if (!state.samplers.meta) {
      state.samplers.meta = await get('/api/studio/samplers/meta');
      state.samplers.registry = await get('/api/studio/samplers');
    }
    const meta = state.samplers.meta;
    const backendInfo = meta.backends.find((item) => item.id === state.samplers.backend) ?? meta.backends[0];
    const backendSelect = h(
      'select',
      {
        onchange: (event) => {
          state.samplers.backend = event.target.value;
          state.samplers.current = null;
          void render();
        },
      },
      ...meta.backends.map((item) => h('option', { value: item.id }, item.title)),
    );
    backendSelect.value = backendInfo.id;

    const current = state.samplers.current ?? { backend: backendInfo.id, order: [...(backendInfo.defaultOrder ?? [])], enabled: null };
    state.samplers.current = current;
    const titleOf = (id) => meta.catalog.find((item) => item.id === id)?.title ?? id;

    const move = (index, delta) => {
      const next = [...current.order];
      const target = index + delta;
      if (target < 0 || target >= next.length) return;
      [next[index], next[target]] = [next[target], next[index]];
      current.order = next;
      void render();
    };

    const rows = current.order.map((id, index) => {
      const enabled = (current.enabled ?? current.order).includes(id);
      return h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: '6px', padding: '2px 0', flexWrap: 'wrap' } },
        h('span', { style: { width: '20px', opacity: 0.6 } }, String(index + 1)),
        h('button', { class: 'link-btn', onclick: () => move(index, -1) }, '↑'),
        h('button', { class: 'link-btn', onclick: () => move(index, 1) }, '↓'),
        h(
          'label',
          { class: 'checkbox_label' },
          h('input', {
            type: 'checkbox',
            checked: enabled,
            onchange: (event) => {
              const set = new Set(current.enabled ?? current.order);
              if (event.target.checked) set.add(id);
              else set.delete(id);
              current.enabled = current.order.filter((item) => set.has(item));
              void render();
            },
          }),
          h('span', {}, titleOf(id)),
        ),
        h('span', { class: 'panel-note' }, meta.catalog.find((item) => item.id === id)?.summary ?? ''),
      );
    });

    const diffLine = h('div', { class: 'panel-note' }, '…');
    try {
      const preview = await post('/api/studio/samplers/preview', { backend: current.backend, order: current.order, enabled: current.enabled });
      diffLine.textContent = preview.diff;
    } catch (err) {
      diffLine.textContent = err?.message ?? String(err);
    }

    const registry = state.samplers.registry?.items ?? [];
    return [
      panel(
        '采样器顺序',
        '顺序不同，出来的文风差别很大',
        h(
          'div',
          { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '8px' } },
          field('后端', backendSelect),
          field('相对默认', diffLine),
        ),
        h('div', {}, ...rows),
        h(
          'div',
          { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '8px' } },
          h(
            'button',
            {
              class: 'btn',
              onclick: async () => {
                const name = window.prompt('给这套采样参数起个名字', `我的 ${current.backend} 配方`);
                if (!name) return;
                try {
                  await post('/api/studio/samplers', { name, backend: current.backend, order: current.order, enabled: current.enabled });
                  state.samplers.registry = await get('/api/studio/samplers');
                  toast('已保存');
                  await render();
                } catch (err) {
                  toastError(err);
                }
              },
            },
            '保存为档案',
          ),
          h(
            'button',
            {
              class: 'link-btn',
              onclick: () => {
                current.order = [...(backendInfo.defaultOrder ?? [])];
                current.enabled = null;
                void render();
              },
            },
            '恢复默认顺序',
          ),
        ),
      ),
      panel(
        '已保存的档案',
        `${registry.length} 个`,
        registry.length
          ? table(
              ['名字', '后端', '相对默认', '操作'],
              registry.map((item) => [
                item.name,
                item.backend,
                item.diff ?? '',
                h(
                  'span',
                  {},
                  h(
                    'button',
                    {
                      class: 'link-btn',
                      onclick: async () => {
                        try {
                          const saved = await post(`/api/studio/samplers/${item.id}/action`, { action: 'neutralize' });
                          toast(`已中性化：${saved.diff}`);
                          state.samplers.registry = await get('/api/studio/samplers');
                          await render();
                        } catch (err) {
                          toastError(err);
                        }
                      },
                    },
                    '中性化',
                  ),
                  ' ',
                  h(
                    'button',
                    {
                      class: 'link-btn',
                      onclick: async () => {
                        try {
                          await post(`/api/studio/samplers/${item.id}/action`, { action: 'reset' });
                          state.samplers.registry = await get('/api/studio/samplers');
                          toast('已恢复默认顺序');
                          await render();
                        } catch (err) {
                          toastError(err);
                        }
                      },
                    },
                    '恢复',
                  ),
                  ' ',
                  h(
                    'button',
                    {
                      class: 'link-btn',
                      onclick: async () => {
                        if (!(await confirmDialog({ title: '删除档案', message: `删掉「${item.name}」？` }))) return;
                        try {
                          await del(`/api/studio/samplers/${item.id}`);
                          state.samplers.registry = await get('/api/studio/samplers');
                          await render();
                        } catch (err) {
                          toastError(err);
                        }
                      },
                    },
                    '删',
                  ),
                ),
              ]),
            )
          : emptyState({ icon: '🎛️', title: '还没有档案', desc: '排好顺序之后点「保存为档案」。' }),
      ),
    ];
  }

  // ---------------------------------------------------------------- 套装

  async function renderLoadouts() {
    if (!state.loadouts.meta) {
      state.loadouts.meta = await get('/api/studio/loadouts/meta');
      state.loadouts.registry = await get('/api/studio/loadouts');
    }
    const items = state.loadouts.registry?.items ?? [];
    const parts = state.loadouts.meta.parts;
    const status = h('div', { class: 'panel-note' });
    return [
      panel(
        '套装',
        '打包玩法配置，应用时可以只应用其中一部分',
        h('div', { class: 'panel-note' }, `组成：${parts.map((part) => `${part.title}（${part.summary}）`).join('、')}`),
        h(
          'button',
          {
            class: 'link-btn',
            style: { marginTop: '6px' },
            onclick: async () => {
              const name = window.prompt('给这套玩法起个名字');
              if (!name) return;
              try {
                await post('/api/studio/loadouts', {
                  name,
                  parts: parts.map((part) => part.id),
                  state: { characters: [], persona: null, preset: null, model: null, modules: [], variables: {}, worldbook: [] },
                });
                state.loadouts.registry = await get('/api/studio/loadouts');
                toast('已保存一份空壳，填入真实状态后更完整');
                await render();
              } catch (err) {
                toastError(err);
              }
            },
          },
          '把当前状态存成套装',
        ),
        status,
      ),
      panel(
        '已有套装',
        `${items.length} 个`,
        items.length
          ? h(
              'div',
              {},
              ...items.map((item) =>
                h(
                  'div',
                  { style: { borderTop: '1px solid rgba(128,128,128,0.3)', padding: '8px 0' } },
                  h(
                    'div',
                    { style: { display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' } },
                    h('strong', {}, `${item.favorite ? '★ ' : ''}${item.name}`),
                    h('span', { class: 'panel-note' }, item.summary ?? ''),
                  ),
                  h(
                    'div',
                    { style: { display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '6px', alignItems: 'center' } },
                    ...parts.map((part) =>
                      h(
                        'label',
                        { class: 'checkbox_label' },
                        h('input', { type: 'checkbox', checked: true, 'data-part': part.id }),
                        h('span', {}, part.title),
                      ),
                    ),
                    h(
                      'button',
                      {
                        class: 'btn',
                        onclick: async (event) => {
                          const box = event.target.closest('div');
                          const apply = [...box.querySelectorAll('input[data-part]:checked')].map((input) => input.getAttribute('data-part'));
                          try {
                            const result = await post(`/api/studio/loadouts/${item.id}/apply`, { apply, current: {} });
                            status.textContent = `应用了 ${result.applied.join('、') || '（无）'}${result.skipped.length ? `；这套装里没有：${result.skipped.join('、')}` : ''}`;
                          } catch (err) {
                            toastError(err);
                          }
                        },
                      },
                      '应用勾选的部分',
                    ),
                    h(
                      'button',
                      {
                        class: 'link-btn',
                        onclick: async () => {
                          if (!(await confirmDialog({ title: '删除套装', message: `删掉「${item.name}」？` }))) return;
                          try {
                            await del(`/api/studio/loadouts/${item.id}`);
                            state.loadouts.registry = await get('/api/studio/loadouts');
                            await render();
                          } catch (err) {
                            toastError(err);
                          }
                        },
                      },
                      '删',
                    ),
                  ),
                ),
              ),
            )
          : emptyState({ icon: '🎒', title: '还没有套装' }),
      ),
    ];
  }

  // ---------------------------------------------------------------- 分支图

  async function renderBranches() {
    await ensureCards();
    if (!state.branches.data) {
      return [
        panel(
          '分支图',
          '按内容哈希自动归类，不用手动建分支',
          cardPicker(() => void refreshBranches()),
          h('div', { class: 'panel-note' }, '选一张卡，把它所有对话按「首条消息 + 每条消息内容」自动建成一棵树：前缀相同的聊天自然落进同一分支。'),
        ),
      ];
    }
    const { stats, layout } = state.branches.data;
    const cell = 46;
    const width = Math.max(1, layout.width) * cell;
    const height = Math.max(1, layout.depth + 1) * cell;
    const graph = h(
      'div',
      { style: { position: 'relative', width: `${width}px`, height: `${height}px`, overflow: 'auto', marginTop: '8px' } },
      ...layout.nodes
        .filter((node) => node.id !== 'root')
        .map((node) =>
          h(
            'div',
            {
              title: `${node.label}${node.chats?.length ? `（${node.chats.length} 个对话）` : ''}`,
              style: {
                position: 'absolute',
                left: `${node.x * cell}px`,
                top: `${node.y * cell}px`,
                padding: '2px 6px',
                borderRadius: '6px',
                fontSize: '11px',
                background: node.isBranch ? 'rgba(107,124,255,0.85)' : 'rgba(128,128,128,0.35)',
                color: '#fff',
                whiteSpace: 'nowrap',
              },
            },
            `${node.isLeaf ? '◆' : '●'} ${node.label}`,
          ),
        ),
    );
    return [
      panel(
        '分支图',
        `${stats.chats} 个对话 / ${stats.nodes} 个节点 / ${stats.tips} 个结尾`,
        cardPicker(() => void refreshBranches()),
        h('div', { class: 'panel-note' }, `分叉点 ${stats.forks} 个，最深 ${stats.depth} 层。改掉某条消息的文案就会落到另一个分支——这是内容哈希方案的取舍。`),
        graph,
      ),
    ];
  }

  async function refreshBranches() {
    if (!state.cardId) return;
    try {
      state.branches.data = await get(`/api/studio/branches?characterId=${encodeURIComponent(state.cardId)}`);
      await render();
    } catch (err) {
      toastError(err);
    }
  }

  // ---------------------------------------------------------------- 模型能力

  async function renderCapabilities() {
    if (!state.capabilities) state.capabilities = await get('/api/studio/providers/capabilities');
    const data = state.capabilities;
    return [
      panel(
        '提供方能力位',
        '让界面按「这个模型能做什么」决定显示哪些开关',
        table(
          ['适配器', '能力位'],
          data.adapters.map((adapter) => [adapter.title, (adapter.detail ?? []).map((flag) => flag.title).join('、') || '（无）']),
        ),
        h('div', { class: 'panel-note' }, '有了能力位，参数面板可以按 flag 显隐，而不是按服务商硬编码 if-else——不会再出现「给 Claude 显示 Gemini 的 thinking 档位」。'),
      ),
    ];
  }

  // ---------------------------------------------------------------- 视觉

  async function renderVision() {
    if (!state.visionMeta) state.visionMeta = await get('/api/studio/vision/meta');
    const meta = state.visionMeta;
    const fileInput = h('input', { type: 'file', accept: 'image/*' });
    const out = h('div', {});
    const modeBox = h('div', { class: 'panel-note' }, '…');
    try {
      const mode = await post('/api/studio/vision/mode', {});
      modeBox.textContent = `当前模型${mode.vision ? '能直接看图' : '不能看图'} —— ${mode.reason}`;
    } catch (err) {
      modeBox.textContent = err?.message ?? String(err);
    }
    return [
      panel(
        '视觉',
        '能看图的模型直接发图；不能看的先把图转成文字',
        h('div', { class: 'panel-note' }, `支持格式：${(meta.mimes ?? []).join(' / ')}；单张上限 ${Math.round((meta.maxBytes ?? 8388608) / 1024 / 1024)}MB`),
        h('div', { class: 'panel-note' }, `描述模板：${meta.template ?? ''}`),
        h('div', { class: 'panel-note' }, `看图用的提供方：${meta.captionProviderId || '（没配：去「模型接入」加一个支持视觉的，或去设置里填 id）'}`),
        modeBox,
        field('试一张图', fileInput, '在浏览器里读成 base64，再让看图模型写一段描述'),
        h(
          'button',
          {
            class: 'btn',
            style: { marginTop: '8px' },
            onclick: async () => {
              const file = fileInput.files?.[0];
              if (!file) {
                toast('先选一张图');
                return;
              }
              try {
                const dataUrl = await new Promise((resolve, reject) => {
                  const reader = new FileReader();
                  reader.onload = () => resolve(String(reader.result ?? ''));
                  reader.onerror = () => reject(new Error('读不了这个文件'));
                  reader.readAsDataURL(file);
                });
                const result = await post('/api/studio/vision/caption', {
                  base64: dataUrl.replace(/^data:[^,]*,/, ''),
                  mime: file.type,
                  bytes: file.size,
                  name: file.name,
                  user: '我',
                  char: '角色',
                });
                out.replaceChildren(copyable('描述', result.caption), copyable('塞进对话的样子', result.text));
              } catch (err) {
                toastError(err);
              }
            },
          },
          '转成文字',
        ),
        out,
      ),
    ];
  }

  // ---------------------------------------------------------------- 翻译

  async function renderTranslate() {
    if (!state.translateMeta) state.translateMeta = await get('/api/studio/translate/meta');
    const meta = state.translateMeta;
    const textarea = h('textarea', { class: 'text_pole', rows: 5, placeholder: '粘贴要翻的对话内容……' });
    const targetSelect = h('select', {}, ...meta.targets.map((item) => h('option', { value: item.id }, item.title)));
    targetSelect.value = meta.target ?? 'zh-CN';
    const out = h('div', {});
    return [
      panel(
        '聊天翻译',
        '默认只改显示，不动实际内容',
        h('div', { class: 'panel-note' }, `自动翻译：${meta.auto ? '开' : '关'}；只翻外语：${meta.onlyForeign ? '开' : '关'}；译文进上下文：${meta.intoContext ? '开' : '关'}（都在「设置」里改）`),
        field('目标语言', targetSelect),
        field('原文', textarea),
        h(
          'div',
          { style: { display: 'flex', gap: '8px', marginTop: '8px', flexWrap: 'wrap' } },
          h(
            'button',
            {
              class: 'btn',
              onclick: async () => {
                try {
                  const result = await post('/api/studio/translate', { text: textarea.value, target: targetSelect.value });
                  out.replaceChildren(copyable('译文', result.translation), h('div', { class: 'panel-note' }, `用 ${result.providerId} 翻的`));
                } catch (err) {
                  toastError(err);
                }
              },
            },
            '翻译',
          ),
          h(
            'button',
            {
              class: 'link-btn',
              onclick: async () => {
                try {
                  const result = await post('/api/studio/translate', { text: textarea.value, target: targetSelect.value, promptOnly: true });
                  out.replaceChildren(copyable('提示词（想自己调模型时用）', result.prompt));
                } catch (err) {
                  toastError(err);
                }
              },
            },
            '只看提示词',
          ),
        ),
        out,
      ),
    ];
  }

  // ---------------------------------------------------------------- 书签

  async function renderBookmarks() {
    const list = await get('/api/studio/bookmarks');
    const chatInput = h('input', { class: 'text_pole', placeholder: '留空看全部' });
    const items = list.items ?? [];
    return [
      panel(
        '消息书签',
        `${items.length} 个`,
        h('div', { class: 'panel-note' }, '书签是轻量标记：给某条消息起个名，回头能跳回去。和快照 / 章节那种「重」的东西分开。'),
        field('只看这个对话', chatInput),
        h(
          'button',
          { class: 'link-btn', style: { marginTop: '6px' }, onclick: () => void render() },
          '刷新',
        ),
        items.length
          ? table(
              ['名字', '对话', '消息', '颜色', ''],
              items.map((item) => [
                item.label || '（无标题）',
                item.chatId,
                item.messageId,
                item.color,
                h(
                  'button',
                  {
                    class: 'link-btn',
                    onclick: async () => {
                      try {
                        await del(`/api/studio/bookmarks/${item.id}`);
                        await render();
                      } catch (err) {
                        toastError(err);
                      }
                    },
                  },
                  '删',
                ),
              ]),
            )
          : emptyState({ icon: '🔖', title: '还没有书签', desc: '在对话里点消息上的书签图标就能加。' }),
      ),
    ];
  }

  // ---------------------------------------------------------------- 动作序列

  async function renderActions() {
    const meta = state.actionMeta ?? (state.actionMeta = await get('/api/studio/actions/meta'));
    const list = await get('/api/studio/actions');
    const items = list.items ?? [];
    const nameInput = h('input', { class: 'text_pole', placeholder: '例如：开一局' });
    const stepsInput = h('textarea', {
      class: 'text_pole',
      rows: 5,
      placeholder: '一行一步，格式是「类型 参数」，例如：\nsend 推开木门，走了进去\ncontinue',
    });
    const parseSteps = () =>
      stepsInput.value
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [type, ...rest] = line.split(/\s+/);
          const value = rest.join(' ');
          const spec = (meta.stepTypes ?? []).find((item) => item.id === type);
          if (!spec) throw new Error(`不认识的动作：${type}`);
          const step = { type };
          const first = (spec.fields ?? [])[0];
          if (first && value) step[first] = first === 'ms' ? Number(value) : value;
          return step;
        });

    return [
      panel(
        '动作序列（快速回复）',
        '把一串常用操作存成按钮',
        h('div', { class: 'panel-note' }, `可用动作：${(meta.stepTypes ?? []).map((item) => `${item.id}（${item.title}）`).join('、')}`),
        field('名字', nameInput),
        field('步骤', stepsInput, '第一段是动作类型，后面是参数'),
        h(
          'button',
          {
            class: 'btn',
            style: { marginTop: '8px' },
            onclick: async () => {
              try {
                await post('/api/studio/actions', { name: nameInput.value, steps: parseSteps() });
                toast('已保存');
                await render();
              } catch (err) {
                toastError(err);
              }
            },
          },
          '保存这套动作',
        ),
      ),
      panel(
        '已保存的动作',
        `${items.length} 套`,
        items.length
          ? table(
              ['图标', '名字', '步骤', ''],
              items.map((item) => [
                item.icon ?? '⚡',
                item.name,
                item.description ?? '',
                h(
                  'span',
                  {},
                  h(
                    'button',
                    {
                      class: 'link-btn',
                      onclick: async () => {
                        try {
                          const expanded = await post(`/api/studio/actions/${item.id}/expand`, { variables: {} });
                          toast(`展开后 ${expanded.steps.length} 步：${expanded.steps.map((step) => step.type).join(' → ')}`);
                        } catch (err) {
                          toastError(err);
                        }
                      },
                    },
                    '试展开',
                  ),
                  ' ',
                  h(
                    'button',
                    {
                      class: 'link-btn',
                      onclick: async () => {
                        if (!(await confirmDialog({ title: '删除动作组', message: `删掉「${item.name}」？` }))) return;
                        try {
                          await del(`/api/studio/actions/${item.id}`);
                          await render();
                        } catch (err) {
                          toastError(err);
                        }
                      },
                    },
                    '删',
                  ),
                ),
              ]),
            )
          : emptyState({ icon: '⚡', title: '还没有动作组' }),
      ),
    ];
  }

  // ---------------------------------------------------------------- Logit Bias

  async function renderLogit() {
    const data = await get('/api/studio/logit');
    const rows = [...(data.builtin ?? []), ...(data.items ?? [])];
    return [
      panel(
        'Logit Bias 预设',
        `权重范围 ${data.range?.min} ~ ${data.range?.max}`,
        h('div', { class: 'panel-note' }, '压词表：把烂大街的描写短语或「替你说话」的写法压下去，比在提示词里写禁令更硬。'),
        rows.length
          ? table(
              ['名字', '内容', '说明', ''],
              rows.map((item) => [
                item.name,
                item.description ?? '',
                item.summary ?? '',
                String(item.id ?? '').startsWith('builtin:')
                  ? '内置'
                  : h(
                      'button',
                      {
                        class: 'link-btn',
                        onclick: async () => {
                          try {
                            await del(`/api/studio/logit/${item.id}`);
                            await render();
                          } catch (err) {
                            toastError(err);
                          }
                        },
                      },
                      '删',
                    ),
              ]),
            )
          : emptyState({ icon: '🎚️', title: '没有预设' }),
        h(
          'button',
          {
            class: 'link-btn',
            style: { marginTop: '8px' },
            onclick: async () => {
              try {
                const merged = await post('/api/studio/logit/merge', { ids: rows.map((item) => item.id) });
                toast(`合并后 ${merged.description}`);
              } catch (err) {
                toastError(err);
              }
            },
          },
          '把全部预设合并起来看看',
        ),
      ),
    ];
  }

  // ---------------------------------------------------------------- 导出与抓料

  async function renderHandoff() {
    const chatIdInput = h('input', { class: 'text_pole', placeholder: '要导出的对话 id' });
    const out = h('div', {});
    const urlInput = h('input', { class: 'text_pole', placeholder: 'https://… wiki 页面地址' });
    const fetchOut = h('div', {});
    return [
      panel(
        '导出对话',
        '单文件 HTML，双击就能看',
        field('对话 id', chatIdInput),
        h(
          'div',
          { style: { display: 'flex', gap: '8px', marginTop: '8px', flexWrap: 'wrap' } },
          h(
            'button',
            {
              class: 'btn',
              onclick: async () => {
                try {
                  const result = await post('/api/studio/export/html', { chatId: chatIdInput.value.trim() });
                  out.replaceChildren(h('div', { class: 'panel-note' }, `${result.title} · ${result.count} 条消息`), copyable('HTML（复制后存成 .html）', result.html));
                } catch (err) {
                  toastError(err);
                }
              },
            },
            '导出 HTML',
          ),
          h(
            'button',
            {
              class: 'link-btn',
              onclick: async () => {
                try {
                  const result = await post('/api/studio/export/html', { chatId: chatIdInput.value.trim(), format: 'markdown' });
                  out.replaceChildren(copyable('Markdown', result.markdown));
                } catch (err) {
                  toastError(err);
                }
              },
            },
            '导出 Markdown',
          ),
        ),
        out,
      ),
      panel(
        '从网页抓料',
        '抓回来交给写卡助手生成设定',
        field('网址', urlInput, '只抓不生成；抓完把提示词粘给写卡助手。内网地址默认禁止。'),
        h(
          'button',
          {
            class: 'btn',
            style: { marginTop: '8px' },
            onclick: async () => {
              try {
                const result = await post('/api/studio/source/fetch', { url: urlInput.value.trim() });
                fetchOut.replaceChildren(
                  h('div', {}, `${result.title}${result.truncated ? '（已截断）' : ''} · ${result.chunks.length} 段`),
                  copyable('抓到的文本', result.text),
                  copyable('给写卡助手的提示词', result.prompt),
                );
              } catch (err) {
                toastError(err);
              }
            },
          },
          '抓取',
        ),
        fetchOut,
      ),
    ];
  }

  async function render() {
    const children = [tabBar()];
    try {
      if (state.tab === 'quality') children.push(...(await renderQuality()));
      else if (state.tab === 'wizard') children.push(...(await renderWizard()));
      else if (state.tab === 'worldbook') children.push(...(await renderWorldbook()));
      else if (state.tab === 'markdown') children.push(...(await renderMarkdown()));
      else if (state.tab === 'notes') children.push(...(await renderNotes()));
      else if (state.tab === 'samplers') children.push(...(await renderSamplers()));
      else if (state.tab === 'loadouts') children.push(...(await renderLoadouts()));
      else if (state.tab === 'branches') children.push(...(await renderBranches()));
      else if (state.tab === 'vision') children.push(...(await renderVision()));
      else if (state.tab === 'translate') children.push(...(await renderTranslate()));
      else if (state.tab === 'bookmarks') children.push(...(await renderBookmarks()));
      else if (state.tab === 'actions') children.push(...(await renderActions()));
      else if (state.tab === 'logit') children.push(...(await renderLogit()));
      else if (state.tab === 'handoff') children.push(...(await renderHandoff()));
      else children.push(...(await renderCapabilities()));
    } catch (err) {
      children.push(panel(TABS.find((tab) => tab.id === state.tab)?.title ?? '工坊', null, errorBox(err, { onRetry: () => void render() })));
    }
    host.replaceChildren(...children);
  }

  async function mount() {
    host.replaceChildren(loading());
    await render();
  }

  return { el, mount };
}
