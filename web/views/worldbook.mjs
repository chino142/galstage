/**
 * 世界书：书列表 + 条目编辑 + 试触发面板。
 *
 * 条目用什么字段、四种逻辑怎么选、位置有哪几种，全部从 /api/worldbooks/meta
 * 拿（服务端 core/worldbook/shapes.mjs 定义），界面上不写死。
 */

import { h, statusChip } from '../core/dom.mjs';
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

async function downloadBook(id, shape, name) {
  const res = await fetch(`/api/worldbooks/${id}/export?shape=${shape}`);
  if (!res.ok) throw new Error(`导出失败（${res.status}）`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: `${name}-${shape}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function createWorldbookView(module, ctx) {
  const el = h('div', { class: 'view' });
  const listHost = h('div', {});
  const detailHost = h('div', {});
  const state = { books: [], total: 0, q: '', current: null, entries: [], meta: null };

  const search = h('input', {
    type: 'search',
    placeholder: '搜世界书名字……',
    oninput: (event) => {
      state.q = event.target.value.trim();
      void loadBooks();
    },
  });
  const fileInput = h('input', {
    type: 'file',
    accept: '.json',
    multiple: true,
    style: { display: 'none' },
    onchange: () => importBooks([...fileInput.files]),
  });

  el.append(
    panel(
      module.title,
      null,
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } }, statusChip(module.status), h('span', { class: 'panel-note' }, module.summary)),
      h(
        'div',
        { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', marginTop: '14px' } },
        search,
        h('button', { class: 'btn primary', onclick: () => fileInput.click() }, '⬆ 导入世界书'),
        h('button', { class: 'btn', onclick: () => newBookDialog() }, '＋ 新建世界书'),
      ),
      fileInput,
    ),
    listHost,
    detailHost,
  );

  // ---------------------------------------------------------------- 书

  async function loadMeta() {
    if (!state.meta) state.meta = await get('/api/worldbooks/meta');
    return state.meta;
  }

  async function loadBooks() {
    try {
      const data = await get(`/api/worldbooks?q=${encodeURIComponent(state.q)}`);
      state.books = data.items;
      state.total = data.total;
      renderBooks();
      if (!state.current && state.books.length) await selectBook(state.params?.bookId ?? state.books[0].id);
      else if (state.current) await selectBook(state.current.id);
    } catch (err) {
      listHost.replaceChildren(panel('世界书', null, errorBox(err, { onRetry: () => void loadBooks() })));
    }
  }

  function renderBooks() {
    if (!state.books.length) {
      listHost.replaceChildren(panel('世界书', null, emptyState({ icon: '📚', title: '还没有世界书', desc: '导入一份酒馆世界书 JSON，或者新建一本从零写条目。' })));
      detailHost.replaceChildren();
      return;
    }
    listHost.replaceChildren(
      panel(
        '世界书',
        `共 ${state.total} 本`,
        table(
          ['名字', '形状', '条目', '更新时间', '操作'],
          state.books.map((book) => [
            h('button', { class: `link-btn${state.current?.id === book.id ? ' active' : ''}`, onclick: () => selectBook(book.id) }, book.name),
            book.spec === 'card' ? '卡内嵌' : '酒馆导出',
            book.entryCount ?? 0,
            (book.updatedAt ?? '').slice(0, 19).replace('T', ' '),
            h(
              'div',
              { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
              h('button', { class: 'btn small', onclick: () => downloadBook(book.id, 'tavern', book.name).catch(toastError) }, '导出酒馆'),
              h('button', { class: 'btn small', onclick: () => downloadBook(book.id, 'card', book.name).catch(toastError) }, '导出卡内'),
              h('button', { class: 'btn small danger', onclick: () => removeBook(book) }, '删除'),
            ),
          ]),
        ),
      ),
    );
  }

  function newBookDialog() {
    const nameInput = h('input', { type: 'text', placeholder: '世界书名字' });
    openModal({
      title: '新建世界书',
      body: h('div', {}, field('名字', nameInput)),
      actions: [
        { label: '取消' },
        {
          label: '创建',
          primary: true,
          onClick: async () => {
            const name = nameInput.value.trim();
            if (!name) {
              toast('名字不能空着', { tone: 'warn' });
              return false;
            }
            try {
              const book = await post('/api/worldbooks', { name });
              state.current = book;
              await loadBooks();
            } catch (err) {
              toastError(err);
              return false;
            }
            return true;
          },
        },
      ],
    });
  }

  async function importBooks(files) {
    if (!files.length) return;
    try {
      const payload = [];
      for (const file of files) payload.push({ name: file.name, text: await fileToText(file) });
      const result = await post('/api/worldbooks/import', { files: payload });
      if (result.skipped) toast(`导入 ${result.imported} 本，${result.skipped} 本读不出来`, { tone: 'warn' });
      else toast(`导入成功：${result.imported} 本`);
      for (const err of result.errors ?? []) console.warn('世界书导入失败', err);
      await loadBooks();
    } catch (err) {
      toastError(err);
    } finally {
      fileInput.value = '';
    }
  }

  async function removeBook(book) {
    const ok = await confirmDialog({ title: '删除世界书', message: `确定删掉「${book.name}」吗？`, confirmLabel: '删除' });
    if (!ok) return;
    try {
      await del(`/api/worldbooks/${book.id}`);
      if (state.current?.id === book.id) state.current = null;
      toast('已删除');
      await loadBooks();
    } catch (err) {
      toastError(err);
    }
  }

  // ---------------------------------------------------------------- 条目

  async function selectBook(id) {
    try {
      const [book, entries] = await Promise.all([get(`/api/worldbooks/${id}`), get(`/api/worldbooks/${id}/entries`)]);
      state.current = book;
      state.entries = entries.items;
      renderBooks();
      renderDetail();
    } catch (err) {
      detailHost.replaceChildren(panel('世界书详情', null, errorBox(err)));
    }
  }

  function renderDetail() {
    const book = state.current;
    if (!book) {
      detailHost.replaceChildren();
      return;
    }
    const triggerInput = h('textarea', { rows: 3, placeholder: '把一段话贴进来，看看会激活哪些条目、为什么……' });
    const triggerHost = h('div', { style: { marginTop: '10px' } });

    detailHost.replaceChildren(
      panel(
        book.name,
        null,
        kv([
          ['形状', book.spec === 'card' ? '卡内嵌 character_book' : '酒馆导出 World Info'],
          ['条目', state.entries.length],
          ['更新时间', (book.updatedAt ?? '').slice(0, 19).replace('T', ' ')],
        ]),
        h(
          'div',
          { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '12px' } },
          h('button', { class: 'btn primary', onclick: () => editEntry(null) }, '＋ 新增条目'),
          h('button', { class: 'btn', onclick: () => renameBook() }, '改名'),
        ),
      ),
      panel(
        '条目',
        `${state.entries.length} 条`,
        state.entries.length
          ? table(
              ['备注', '关键词', '触发', '位置/顺序', '状态', '操作'],
              state.entries.map((entry, index) => [
                h('div', {}, h('div', { style: { fontWeight: '600' } }, entry.comment || `条目 ${entry.uid}`), h('div', { class: 'panel-note', style: { fontSize: '12px' } }, (entry.content ?? '').slice(0, 40) || '（空内容）')),
                h('div', {}, (entry.keys ?? []).join(', ') || '—', entry.secondaryKeys?.length ? h('div', { class: 'panel-note' }, `次：${entry.secondaryKeys.join(', ')} · ${state.meta?.logics?.find((l) => l.value === entry.selectiveLogic)?.label ?? ''}`) : null),
                entry.constant ? '常量' : entry.vectorized ? '语义' : '关键词',
                `${state.meta?.positions?.find((p) => p.value === entry.position)?.label ?? entry.position} · ${entry.order}`,
                entry.enabled ? '启用' : '停用',
                h(
                  'div',
                  { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
                  h('button', { class: 'btn small', onclick: () => editEntry(entry, index) }, '编辑'),
                  h('button', { class: 'btn small', onclick: () => toggleEntry(entry, index) }, entry.enabled ? '停用' : '启用'),
                  h('button', { class: 'btn small danger', onclick: () => removeEntry(entry, index) }, '删除'),
                ),
              ]),
            )
          : emptyState({ icon: '📝', title: '这本书还没有条目' }),
      ),
      panel(
        '试触发',
        '输入一段话，看命中谁、为什么',
        triggerInput,
        h('div', { style: { marginTop: '10px' } }, h('button', { class: 'btn primary', onclick: () => runTrigger(triggerInput.value, triggerHost) }, '试试看')),
        triggerHost,
      ),
    );
  }

  async function renameBook() {
    const input = h('input', { type: 'text', value: state.current.name });
    openModal({
      title: '改名字',
      body: field('名字', input),
      actions: [
        { label: '取消' },
        {
          label: '保存',
          primary: true,
          onClick: async () => {
            try {
              await put(`/api/worldbooks/${state.current.id}`, { name: input.value.trim() || state.current.name });
              await loadBooks();
            } catch (err) {
              toastError(err);
              return false;
            }
            return true;
          },
        },
      ],
    });
  }

  async function runTrigger(text, host) {
    if (!text.trim()) {
      toast('先贴一段话', { tone: 'warn' });
      return;
    }
    try {
      const result = await post(`/api/worldbooks/${state.current.id}/test-trigger`, { text });
      host.replaceChildren(
        h('div', { class: 'panel-note', style: { marginTop: '10px' } }, `扫描了 ${result.scanned} 条，激活 ${result.entries.length} 条`),
        result.entries.length
          ? h('div', { class: 'reason-list' }, result.entries.map((entry) => h('div', { class: 'reason-row ok' }, `✅ ${entry.comment || `条目 ${entry.uid}`}`, h('span', { class: 'panel-note' }, String(entry.content).slice(0, 60)))))
          : h('div', { class: 'panel-note' }, '没有条目被激活'),
        result.reasons?.length
          ? h(
              'details',
              { style: { marginTop: '8px' } },
              h('summary', {}, '逐条原因'),
              h('div', { class: 'reason-list' }, result.reasons.map((reason) => h('div', { class: `reason-row${reason.activated ? ' ok' : ''}` }, `${reason.activated ? '✅' : '·'} ${reason.comment || `条目 ${reason.uid}`}`, h('span', { class: 'panel-note' }, reason.detail)))),
            )
          : null,
      );
    } catch (err) {
      toastError(err);
    }
  }

  // ---------------------------------------------------------------- 条目编辑

  function editEntry(entry, index = null) {
    const meta = state.meta ?? { positions: [], logics: [], matchSources: [] };
    const draft = entry ?? { uid: null, keys: [], secondaryKeys: [], content: '', comment: '', enabled: true, constant: false, selective: false, selectiveLogic: 0, order: 100, position: 0, depth: 4, probability: 100, useProbability: true, sticky: 0, cooldown: 0, delay: 0, group: '', groupWeight: 100, groupOverride: false, scanDepth: null, caseSensitive: false, matchWholeWords: null, useGroupScoring: null, ignoreBudget: false, vectorized: false, semanticThreshold: null };

    const comment = h('input', { type: 'text', value: draft.comment ?? '' });
    const keys = h('textarea', { rows: 2, placeholder: '一行一条关键词，也支持 /正则/gi' }, (draft.keys ?? []).join('\n'));
    const secondary = h('textarea', { rows: 2, placeholder: '一行一条次关键词' }, (draft.secondaryKeys ?? []).join('\n'));
    const content = h('textarea', { rows: 5, placeholder: '命中后注入的正文' }, draft.content ?? '');
    const enabled = h('input', { type: 'checkbox', checked: draft.enabled !== false });
    const constant = h('input', { type: 'checkbox', checked: Boolean(draft.constant) });
    const selective = h('input', { type: 'checkbox', checked: Boolean(draft.selective) });
    const logic = h('select', {}, meta.logics.map((option) => h('option', { value: option.value, selected: Number(draft.selectiveLogic) === option.value }, option.label)));
    const order = h('input', { type: 'number', value: draft.order ?? 100 });
    const position = h('select', {}, meta.positions.map((option) => h('option', { value: option.value, selected: Number(draft.position) === option.value }, option.label)));
    const depth = h('input', { type: 'number', value: draft.depth ?? 4 });
    const probability = h('input', { type: 'number', value: draft.probability ?? 100, min: 0, max: 100 });
    const sticky = h('input', { type: 'number', value: draft.sticky ?? 0 });
    const cooldown = h('input', { type: 'number', value: draft.cooldown ?? 0 });
    const delay = h('input', { type: 'number', value: draft.delay ?? 0 });
    const group = h('input', { type: 'text', value: draft.group ?? '' });
    const groupWeight = h('input', { type: 'number', value: draft.groupWeight ?? 100 });
    const groupOverride = h('input', { type: 'checkbox', checked: Boolean(draft.groupOverride) });
    const scanDepth = h('input', { type: 'number', placeholder: '跟随全局', value: draft.scanDepth ?? '' });
    const caseSensitive = h('input', { type: 'checkbox', checked: Boolean(draft.caseSensitive) });
    const wholeWords = h('input', { type: 'checkbox', checked: Boolean(draft.matchWholeWords) });
    const groupScoring = h('input', { type: 'checkbox', checked: Boolean(draft.useGroupScoring) });
    const ignoreBudget = h('input', { type: 'checkbox', checked: Boolean(draft.ignoreBudget) });
    const vectorized = h('input', { type: 'checkbox', checked: Boolean(draft.vectorized) });
    const semanticThreshold = h('input', { type: 'number', step: '0.05', min: 0, max: 1, value: draft.semanticThreshold ?? 0.6 });
    const matchBoxes = meta.matchSources.map((source) => ({ key: source.key, label: source.label, node: h('input', { type: 'checkbox', checked: Boolean(draft[source.key]) }) }));

    const num = (node) => (node.value === '' ? null : Number(node.value));
    openModal({
      title: entry ? `编辑条目 · ${entry.comment || entry.uid}` : '新增条目',
      width: '720px',
      body: h(
        'div',
        {},
        field('备注', comment),
        field('主关键词（一行一条）', keys),
        field('次关键词（一行一条）', secondary),
        field('正文', content),
        h('div', { class: 'grid-2' },
          field('顺序 order', order),
          field('位置', position)),
        h('div', { class: 'grid-2' },
          field('深度（指定深度时用）', depth),
          field('扫描深度（空=跟随全局）', scanDepth)),
        h('div', { class: 'grid-3' },
          field('概率 %', probability),
          field('粘性 sticky', sticky),
          field('冷却 cooldown', cooldown)),
        h('div', { class: 'grid-3' },
          field('延迟 delay', delay),
          field('分组', group),
          field('组内权重', groupWeight)),
        h('div', { class: 'grid-2' },
          field('次关键词逻辑', logic),
          field('语义阈值', semanticThreshold)),
        h('div', { class: 'chip-row', style: { marginBottom: '10px' } },
          field('启用', enabled), field('常量条目', constant), field('启用次关键词', selective),
          field('组内覆盖', groupOverride), field('大小写敏感', caseSensitive), field('整词匹配', wholeWords)),
        h('div', { class: 'chip-row', style: { marginBottom: '10px' } },
          field('组内评分', groupScoring), field('忽略预算', ignoreBudget), field('参与语义触发', vectorized)),
        h('div', { class: 'panel-note', style: { marginBottom: '6px' } }, '额外参与扫描的内容来源'),
        h('div', { class: 'chip-row' }, matchBoxes.map((box) => field(box.label, box.node))),
      ),
      actions: [
        { label: '取消' },
        {
          label: '保存',
          primary: true,
          onClick: async () => {
            const payload = {
              uid: entry?.uid ?? null,
              comment: comment.value,
              keys: keys.value.split('\n').map((line) => line.trim()).filter(Boolean),
              secondaryKeys: secondary.value.split('\n').map((line) => line.trim()).filter(Boolean),
              content: content.value,
              enabled: enabled.checked,
              constant: constant.checked,
              selective: selective.checked,
              selectiveLogic: Number(logic.value),
              order: num(order) ?? 100,
              position: Number(position.value),
              depth: num(depth) ?? 4,
              probability: num(probability) ?? 100,
              useProbability: true,
              sticky: num(sticky) ?? 0,
              cooldown: num(cooldown) ?? 0,
              delay: num(delay) ?? 0,
              group: group.value,
              groupWeight: num(groupWeight) ?? 100,
              groupOverride: groupOverride.checked,
              scanDepth: num(scanDepth),
              caseSensitive: caseSensitive.checked,
              matchWholeWords: wholeWords.checked,
              useGroupScoring: groupScoring.checked,
              ignoreBudget: ignoreBudget.checked,
              vectorized: vectorized.checked,
              semanticThreshold: num(semanticThreshold),
            };
            for (const box of matchBoxes) payload[box.key] = box.node.checked;
            try {
              if (entry && entry.uid !== undefined && entry.uid !== null) await put(`/api/worldbooks/${state.current.id}/entries/${entry.uid}`, payload);
              else await post(`/api/worldbooks/${state.current.id}/entries`, payload);
              await selectBook(state.current.id);
            } catch (err) {
              toastError(err);
              return false;
            }
            return true;
          },
        },
      ],
    });
    void index;
  }

  async function toggleEntry(entry) {
    try {
      await put(`/api/worldbooks/${state.current.id}/entries/${entry.uid}`, { ...entry, enabled: !entry.enabled });
      await selectBook(state.current.id);
    } catch (err) {
      toastError(err);
    }
  }

  async function removeEntry(entry) {
    const ok = await confirmDialog({ title: '删除条目', message: `确定删掉「${entry.comment || entry.uid}」吗？`, confirmLabel: '删除' });
    if (!ok) return;
    try {
      await del(`/api/worldbooks/${state.current.id}/entries/${entry.uid}`);
      toast('已删除');
      await selectBook(state.current.id);
    } catch (err) {
      toastError(err);
    }
  }

  async function mount() {
    try {
      await loadMeta();
    } catch (err) {
      detailHost.replaceChildren(panel('世界书', null, errorBox(err)));
      return;
    }
    state.params = { bookId: ctx.params?.bookId ?? null };
    await loadBooks();
  }

  return { el, mount };
}
