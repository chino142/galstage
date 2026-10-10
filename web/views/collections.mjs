/**
 * 剧本合集页：左边是分组 / 分类树，右边是这个分类里的卡，以及"往这个分类里加卡"。
 *
 * 数据来自 /api/collections（服务见 core/collections/service.mjs）。两级结构：
 * 分组（parentId 为空）→ 分类。一张卡可以同时属于多个分类。
 */

import { h } from '../core/dom.mjs';
import { get, post, put, del } from '../core/api.mjs';
import { panel, loading, errorBox, emptyState } from '../ui/components.mjs';
import { toast, toastError } from '../ui/toast.mjs';

export function createCollectionsView(module) {
  const el = h('div', { class: 'view' });
  const treeHost = h('div', {});
  const detailHost = h('div', {});
  const state = { items: [], selectedId: null, cards: [], allCards: [] };

  const groups = () => state.items.filter((item) => !item.parentId);
  const childrenOf = (id) => state.items.filter((item) => item.parentId === id);
  const byId = (id) => state.items.find((item) => item.id === id) ?? null;

  async function refresh() {
    try {
      const data = await get('/api/collections');
      state.items = data.items ?? [];
      if (state.selectedId && !byId(state.selectedId)) state.selectedId = null;
      renderTree();
      await renderDetail();
    } catch (err) {
      treeHost.replaceChildren(panel('剧本合集', null, errorBox(err, { onRetry: refresh })));
      toastError(err);
    }
  }

  async function createNode(parentId = null) {
    const label = parentId ? '新分类的名字' : '新分组的名字（比如：某个世界观）';
    const name = prompt(label);
    if (!name || !name.trim()) return;
    try {
      const created = await post('/api/collections', { name: name.trim(), parentId });
      if (parentId) state.selectedId = created.id;
      toast(`建好了：${created.name}`);
      await refresh();
    } catch (err) {
      toastError(err);
    }
  }

  async function renameNode(node) {
    const name = prompt('改成什么名字', node.name);
    if (!name || !name.trim()) return;
    try {
      await put(`/api/collections/${node.id}`, { name: name.trim() });
      await refresh();
    } catch (err) {
      toastError(err);
    }
  }

  async function removeNode(node) {
    const kids = childrenOf(node.id).length;
    const extra = kids ? `，连它下面的 ${kids} 个分类一起` : '';
    if (!confirm(`删掉「${node.name}」${extra}？（卡本身不会被删）`)) return;
    try {
      await del(`/api/collections/${node.id}`);
      if (state.selectedId === node.id) state.selectedId = null;
      toast('已删除');
      await refresh();
    } catch (err) {
      toastError(err);
    }
  }

  function row(node, depth) {
    const selected = state.selectedId === node.id;
    const count = node.cardCount ?? 0;
    return h(
      'div',
      {
        class: `chat-item${selected ? ' active' : ''}`,
        style: { marginLeft: depth ? '18px' : '0', cursor: 'pointer' },
        onclick: () => {
          state.selectedId = node.id;
          renderTree();
          void renderDetail();
        },
        oncontextmenu: (event) => {
          event.preventDefault();
          if (confirm(`要删掉「${node.name}」吗？`)) void removeNode(node);
        },
      },
      h('span', {}, depth ? '└ ' : '📁 '),
      h('span', { style: { flex: '1', minWidth: '0' } }, node.name),
      h('span', { class: 'chat-item-sub' }, String(count)),
      h('button', { class: 'btn small', title: '改名', onclick: (event) => { event.stopPropagation(); void renameNode(node); } }, '✎'),
      h('button', { class: 'btn small danger', title: '删除', onclick: (event) => { event.stopPropagation(); void removeNode(node); } }, '✕'),
    );
  }

  async function setCards(characterIds, add) {
    if (!state.selectedId) return;
    try {
      const result = add
        ? await post(`/api/collections/${state.selectedId}/cards`, { characterIds })
        : await post(`/api/collections/${state.selectedId}/cards/remove`, { characterIds });
      state.cards = result.items ?? [];
      await refresh();
    } catch (err) {
      toastError(err);
    }
  }

  function renderTree() {
    const list = h('div', { class: 'chat-list' });
    for (const group of groups()) {
      list.append(row(group, 0));
      for (const child of childrenOf(group.id)) list.append(row(child, 1));
      list.append(
        h('button', { class: 'btn small', style: { margin: '2px 0 8px 18px' }, onclick: () => void createNode(group.id) }, '＋ 加分类'),
      );
    }
    treeHost.replaceChildren(
      panel(
        module.title,
        `${groups().length} 个分组`,
        h('div', { class: 'panel-note' }, '点左边选一个分类；右键或 ✕ 删除；分组下面能加分类。'),
        h('div', { style: { margin: '10px 0' } }, h('button', { class: 'btn primary', onclick: () => void createNode(null) }, '＋ 新建分组')),
        state.items.length ? list : emptyState({ icon: '🗂️', title: '还没有合集', desc: '先建一个分组，比如「某个世界观」。' }),
      ),
    );
  }

  async function ensureAllCards() {
    if (state.allCards.length) return state.allCards;
    const data = await get('/api/characters?limit=500');
    state.allCards = data.items ?? [];
    return state.allCards;
  }

  async function addCardsPrompt() {
    const all = await ensureAllCards();
    const inHere = new Set(state.cards.map((card) => card.id));
    const candidates = all.filter((card) => !inHere.has(card.id));
    if (!candidates.length) {
      toast('所有卡都已经在这个分类里了');
      return;
    }
    const answer = prompt(`加哪张卡？填卡名（或用编号，逗号分隔）\n${candidates.map((card, index) => `${index + 1}. ${card.name}`).join('\n')}`);
    if (!answer) return;
    const picked = answer
      .split(/[,，、\s]+/)
      .map((token) => token.trim())
      .filter(Boolean)
      .flatMap((token) => {
        const index = Number(token);
        if (Number.isInteger(index) && index >= 1 && index <= candidates.length) return [candidates[index - 1].id];
        return candidates.filter((card) => card.name === token).map((card) => card.id);
      });
    if (!picked.length) {
      toast('没认出要加哪张卡', { tone: 'warn' });
      return;
    }
    await setCards(picked, true);
  }

  async function renderDetail() {
    const node = state.selectedId ? byId(state.selectedId) : null;
    if (!node) {
      detailHost.replaceChildren(panel('分类里的卡', null, emptyState({ icon: '👈', title: '先选一个分类', desc: '左边点一个分组下面的分类。' })));
      return;
    }
    try {
      const data = await get(`/api/collections/${node.id}/cards`);
      state.cards = data.items ?? [];
    } catch (err) {
      detailHost.replaceChildren(panel(`《${node.name}》里的卡`, null, errorBox(err, { onRetry: renderDetail })));
      return;
    }
    detailHost.replaceChildren(
      panel(
        `《${node.name}》里的卡`,
        `${state.cards.length} 张`,
        h('div', { style: { marginBottom: '10px' } }, h('button', { class: 'btn primary', onclick: () => void addCardsPrompt() }, '＋ 加卡')),
        state.cards.length
          ? h(
              'div',
              { class: 'card-grid' },
              state.cards.map((card) =>
                h(
                  'div',
                  { class: 'card-grid-item' },
                  h(
                    'div',
                    { class: 'card-grid-cover' },
                    card.avatarAssetId
                      ? h('img', { class: 'card-grid-cover-img', src: `/api/characters/${encodeURIComponent(card.id)}/avatar`, alt: '', loading: 'lazy' })
                      : h('div', { class: 'card-grid-cover-img placeholder' }, h('div', { class: 'card-grid-ph-icon' }, '🃏')),
                  ),
                  h('div', { class: 'card-grid-title', title: card.name }, card.name),
                  h('div', { class: 'card-grid-actions' }, h('button', { class: 'btn small', onclick: () => void setCards([card.id], false) }, '移出')),
                ),
              ),
            )
          : emptyState({ icon: '🎴', title: '这个分类还是空的', desc: '点「＋ 加卡」把卡加进来。' }),
      ),
    );
  }

  async function mount() {
    treeHost.append(loading());
    detailHost.append(panel('分类里的卡', null, emptyState({ icon: '👈', title: '先选一个分类' })));
    await refresh();
  }

  el.append(
    h('div', { class: 'grid-2' }, h('div', {}, treeHost), h('div', {}, detailHost)),
  );
  return { el, mount };
}
