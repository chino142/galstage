/**
 * 向量与检索：四类内容的索引状态、混合检索、重建与清理。
 */

import { h, statusChip } from '../core/dom.mjs';
import { get, post, del } from '../core/api.mjs';
import { panel, table, emptyState, errorBox, field, kv } from '../ui/components.mjs';
import { toast, toastError } from '../ui/toast.mjs';

export function createVectorsView(module, ctx) {
  const el = h('div', { class: 'view' });
  const host = h('div', {});
  const state = { stats: null, collections: [], results: [], query: '', rerank: false, docs: [], backend: null };

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
      const [stats, collections, docs, backend] = await Promise.all([
        get('/api/vectors/stats'),
        get('/api/vectors/collections'),
        get('/api/databank').catch(() => ({ items: [] })),
        get('/api/vectors/backend').catch(() => null),
      ]);
      state.stats = stats;
      state.collections = collections.items;
      state.docs = docs.items ?? [];
      state.backend = backend;
      render();
    } catch (err) {
      host.replaceChildren(panel('向量', null, errorBox(err, { onRetry: () => void refresh() })));
    }
  }

  function render() {
    const stats = state.stats;
    const searchInput = h('input', { type: 'search', placeholder: '搜点什么（关键词 + 向量）……', value: state.query, onkeydown: (event) => { if (event.key === 'Enter') runSearch(searchInput.value); } });
    const rerankToggle = h('input', { type: 'checkbox', checked: state.rerank, onchange: (event) => { state.rerank = event.target.checked; } });
    const docTitle = h('input', { type: 'text', placeholder: '资料标题，比如《世界设定集》' });
    const docBody = h('textarea', { rows: 6, placeholder: '把资料正文粘在这里……（也可以选文件）' });
    const docFiles = h('input', {
      type: 'file',
      multiple: true,
      style: { display: 'none' },
      accept: '.txt,.md,.markdown,.json,.csv,text/plain',
      onchange: async (event) => {
        const files = [...(event.target.files ?? [])];
        if (!files.length) return;
        let ok = 0;
        for (const file of files) {
          try {
            const text = await file.text();
            await post('/api/databank', { title: file.name.replace(/\.[^.]+$/, ''), source: `file:${file.name}`, content: text });
            ok += 1;
          } catch (err) {
            toastError(err);
          }
        }
        event.target.value = '';
        if (ok) toast(`导入 ${ok} 份资料`);
        await refresh();
      },
    });

    host.replaceChildren(
      panel(
        '索引状态',
        null,
        kv([
          ['片段总数', stats.total],
          ['待处理', stats.pending],
          ['集合', stats.collections.length],
          ['检索后端', state.backend?.configured ? `外部：${state.backend.backend}（${state.backend.ok ? '已连通' : state.backend.error ?? '连不上'}）` : '内置（暴力余弦）'],
        ]),
        h('div', { class: 'reason-list', style: { marginTop: '10px' } },
          stats.collections.map((item) => h('div', { class: 'reason-row' },
            h('div', {}, item.title, h('span', { class: 'mono panel-note' }, ` ${item.id}`)),
            h('span', { class: 'panel-note' }, `${item.count} 条`)))),
        h('div', { style: { marginTop: '12px', display: 'flex', gap: '8px', flexWrap: 'wrap' } },
          h('button', { class: 'btn primary', onclick: () => rebuild() }, '重建索引'),
          h('button', { class: 'btn', onclick: () => testEmbedding() }, '测一下嵌入模型'),
          state.backend?.configured
            ? h('button', { class: 'btn', onclick: () => syncBackend() }, '同步到外部向量库')
            : null,
          h('button', { class: 'btn danger', onclick: () => clearIndex() }, '清空全部索引')),
      ),
      panel(
        '混合检索',
        '关键词命中 + 向量相似度融合',
        h(
          'div',
          { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
          searchInput,
          h('button', { class: 'btn primary', onclick: () => runSearch(searchInput.value) }, '检索'),
          h('label', { class: 'switch-row' }, rerankToggle, h('span', {}, '重排')),
          h('span', { class: 'hint' }, '重排会把查询词覆盖率高的片段往上提（召回更多再挑）'),
        ),
        state.results.length
          ? table(['集合', '来源', '内容', '关键词', '向量', '总分', '重排'], state.results.map((item) => [
              item.collection,
              h('span', { class: 'mono' }, item.sourceId),
              item.content.slice(0, 100),
              item.keywordScore.toFixed(2),
              item.vectorScore.toFixed(2),
              item.score.toFixed(2),
              item.rerank ? `${item.rerank.rankBefore} → ${item.rerank.rankAfter}` : '—',
            ]))
          : h('div', { class: 'panel-note', style: { marginTop: '10px' } }, '还没有检索结果'),
      ),
      panel(
        '参考资料',
        `${state.docs.length} 份`,
        h('div', { class: 'panel-note' }, '原文存在本地，向量只是它的副本 —— 随时能重建。导入后每轮对话会按相关度自动召回（设置 → 召回）。'),
        h('div', { style: { marginTop: '10px', display: 'grid', gap: '8px' } },
          field('标题', docTitle),
          field('正文', docBody),
          h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
            h('button', { class: 'btn primary', onclick: () => importDoc(docTitle, docBody) }, '导入这份资料'),
            h('label', { class: 'btn', style: { cursor: 'pointer' } }, '选文件导入…', docFiles),
            h('span', { class: 'hint' }, '支持 .txt / .md / .json / .csv，可多选')),
        ),
        state.docs.length
          ? table(['标题', '字数', '来源', '更新时间', ''], state.docs.map((doc) => [
              doc.title,
              String(doc.charCount ?? ''),
              h('span', { class: 'mono' }, doc.source || '—'),
              (doc.updatedAt ?? '').slice(0, 19).replace('T', ' '),
              h('div', { style: { display: 'flex', gap: '6px' } },
                h('button', { class: 'btn small', onclick: () => reindexDoc(doc.id) }, '重建'),
                h('button', { class: 'btn small danger', onclick: () => removeDoc(doc) }, '删除')),
            ]))
          : h('div', { class: 'panel-note', style: { marginTop: '10px' } }, '还没有参考资料'),
      ),
    );
  }

  async function rebuild() {
    try {
      const result = await post('/api/vectors/reindex', {});
      toast(`重建完成：${result.sources} 个来源 / ${result.chunks} 个片段`);
      await refresh();
    } catch (err) {
      toastError(err);
    }
  }

  async function clearIndex() {
    try {
      await post('/api/vectors/clear', {});
      state.results = [];
      toast('索引已清空');
      await refresh();
    } catch (err) {
      toastError(err);
    }
  }

  async function testEmbedding() {
    try {
      const result = await post('/api/vectors/test-embedding', {});
      toast(`嵌入模型可用：${result.dim} 维`);
    } catch (err) {
      toastError(err);
    }
  }

  async function runSearch(query) {
    state.query = query;
    try {
      const result = await post('/api/vectors/search', { query, topK: 20, rerank: Boolean(state.rerank) });
      state.results = result.items;
      render();
    } catch (err) {
      toastError(err);
    }
  }

  async function importDoc(titleInput, bodyInput) {
    const content = bodyInput.value.trim();
    if (!content) {
      toast('正文不能为空', { tone: 'warn' });
      return;
    }
    try {
      const result = await post('/api/databank', { title: titleInput.value.trim() || '未命名资料', content, source: 'pasted' });
      const chunks = result.index?.chunks ?? 0;
      const embedded = result.index?.embedded ?? 0;
      toast(`已导入：切了 ${chunks} 个片段，嵌入 ${embedded} 个${result.indexError ? `（嵌入失败：${result.indexError}）` : ''}`);
      titleInput.value = '';
      bodyInput.value = '';
      await refresh();
    } catch (err) {
      toastError(err);
    }
  }

  async function reindexDoc(id) {
    try {
      const result = await post(`/api/databank/${encodeURIComponent(id)}/reindex`, {});
      toast(`重建完成：${result.chunks} 个片段（嵌入 ${result.embedded}）`);
      await refresh();
    } catch (err) {
      toastError(err);
    }
  }

  async function removeDoc(doc) {
    try {
      await del(`/api/databank/${encodeURIComponent(doc.id)}`);
      toast(`已删除《${doc.title}》`);
      await refresh();
    } catch (err) {
      toastError(err);
    }
  }

  async function syncBackend() {
    try {
      const result = await post('/api/vectors/sync-backend', {});
      toast(result.skipped ? '没有配置外部向量库' : `已同步 ${result.synced} 个片段`);
      await refresh();
    } catch (err) {
      toastError(err);
    }
  }

  void ctx;
  return { el, mount: refresh };
}
