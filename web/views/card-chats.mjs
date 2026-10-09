/**
 * 一张卡 → 多个对话。
 *
 * 这是"作品 → 会话列表 → 新对话"中间那层的界面零件：卡库、卡编辑器、对话页顶栏
 * 三处都用它列同一张卡的对话（继续 / 新建 / 重命名 / 删除 / 导出）。
 *
 * 只认**单聊**：群聊虽然也可能带着 character_id（从某张卡起头拉的），但它有自己的
 * 「群聊」板块，混进来会让人以为"这张卡有 4 个对话"却又切不过去。群聊数量另外提一句。
 */

import { h } from '../core/dom.mjs';
import { get, post, put, del } from '../core/api.mjs';
import { panel, emptyState } from '../ui/components.mjs';
import { openModal, confirmDialog } from '../ui/modal.mjs';
import { toast, toastError } from '../ui/toast.mjs';
import { fetchChats, formatTime } from './playing-common.mjs';

/** 这张卡的单聊对话，按**创建顺序**排好（第 1 个 / 第 2 个 就按这个数）。 */
export async function loadCardChats(characterId) {
  if (!characterId) return { items: [], groups: [] };
  const all = await fetchChats({ characterId });
  const items = all
    .filter((item) => !item.isGroup)
    .sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')));
  const groups = all.filter((item) => item.isGroup);
  return { items, groups };
}

/** 这个对话是这张卡的第几个（从 1 数）；找不到返回 0。 */
export function chatOrdinal(items, chatId) {
  return items.findIndex((item) => item.id === chatId) + 1;
}

export function chatsSummary(items = []) {
  return items.length ? `${items.length} 个对话` : '还没有对话';
}

/**
 * 把对话列表排成"左栏按卡分组"的结构。
 *
 * 返回按**最近活跃**排好的块，两种：
 *   { type: 'group', id, name, items } —— 同一张卡的多个对话收在一起（组内按创建顺序编号）
 *   { type: 'chat', chat }             —— 群聊、或没挂卡的对话，照旧平铺
 * `chats` 本身已经是"最近活跃在前"，这里只在第一次遇到某张卡时把整组吐出来。
 */
export function planChatList(chats = []) {
  const groups = new Map();
  for (const chat of chats) {
    if (chat?.isGroup || !chat?.characterId) continue;
    if (!groups.has(chat.characterId)) {
      groups.set(chat.characterId, { id: chat.characterId, name: chat.characterName || '这张卡', items: [] });
    }
    groups.get(chat.characterId).items.push(chat);
  }
  const blocks = [];
  const emitted = new Set();
  for (const chat of chats) {
    if (chat?.isGroup || !chat?.characterId) {
      blocks.push({ type: 'chat', chat });
      continue;
    }
    if (emitted.has(chat.characterId)) continue;
    emitted.add(chat.characterId);
    const group = groups.get(chat.characterId);
    const items = [...group.items].sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')));
    blocks.push({ type: 'group', id: group.id, name: group.name, items });
  }
  return blocks;
}

/**
 * 卡组下面那一行显示什么标题：
 * 标题本来就是「<卡名>的对话」（默认名）时换成「第 N 个对话」，免得跟卡名重复；
 * 用户自己改过名的就照原样显示。
 */
export function chatRowLabel(chat, { ordinal = 0, multi = false, cardName = '' } = {}) {
  const raw = String(chat?.title ?? '').trim() || '（无标题）';
  const sameName = cardName && raw.replace(/\s+/g, '') === `${String(cardName).replace(/\s+/g, '')}的对话`;
  if (sameName) return multi ? `第 ${ordinal} 个对话` : '对话';
  return multi ? `第 ${ordinal} 个 · ${raw}` : raw;
}

/** 跳到玩卡区的这个对话（路由第二段就是 chatId，对话页 mount 会认）。 */
export function openCardChat(ctx, chatId) {
  if (!chatId) return;
  if (ctx?.navigate) ctx.navigate('chat', chatId);
}

/** 用这张卡开一个新对话，返回建好的对话。 */
export async function createCardChat(card) {
  return post('/api/chats', { characterId: card.id });
}

async function downloadChat(chat) {
  const text = await get(`/api/chats/${chat.id}/export?format=jsonl`);
  const blob = new Blob([typeof text === 'string' ? text : JSON.stringify(text)], { type: 'application/x-ndjson' });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: `${chat.title || 'chat'}.jsonl` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** 单行输入弹窗（textPrompt 是给正文留的 8 行大框，改标题用这个）。 */
function promptText({ title, label = '', value = '', placeholder = '', confirmLabel = '保存' }) {
  return new Promise((resolve) => {
    let result = null;
    const input = h('input', { type: 'text', value, placeholder });
    openModal({
      title,
      body: h('div', {}, label ? h('div', { class: 'hint', style: { marginBottom: '6px' } }, label) : null, input),
      actions: [
        { label: '取消', onClick: () => { result = null; } },
        { label: confirmLabel, primary: true, onClick: () => { result = input.value; } },
      ],
      onClose: () => resolve(result),
    });
    setTimeout(() => input.focus?.(), 30);
  });
}

/**
 * 对话列表本体（不含 panel 壳，编辑器与弹窗共用）。
 *
 * 返回 `{ el, refresh }`；`refresh()` 会重新拉一次这张卡的对话并把列表重画。
 * `onChanged` 在新建 / 重命名 / 删除之后调用，让宿主（卡库、编辑器）跟着刷新计数。
 */
export function cardChatsBody(card, ctx, { onChanged = null, onLeave = null } = {}) {
  const el = h('div', { class: 'card-chats' });
  const listHost = h('div', { class: 'card-chat-list' });
  const footHost = h('div', {});
  let items = [];
  let groups = [];
  const countHost = h('span', { class: 'card-chats-count' }, '');

  // 跳走之前先把自己收起来（弹窗形态还开着的话，人会带着一层遮罩落在对话页上）
  const goChat = (chatId) => {
    onLeave?.();
    openCardChat(ctx, chatId);
  };

  const openNew = async () => {
    try {
      const created = await createCardChat(card);
      toast(`用《${card.name}》开了个新对话`);
      onChanged?.();
      goChat(created.id);
    } catch (err) {
      toastError(err);
    }
  };

  el.append(
    h(
      'div',
      { class: 'card-chats-head' },
      h('button', { class: 'btn primary small', onclick: () => void openNew() }, '▶ 用这张卡开新对话'),
      countHost,
    ),
    listHost,
    footHost,
  );

  function render() {
    countHost.textContent = chatsSummary(items);
    if (!items.length) {
      listHost.replaceChildren(
        emptyState({
          icon: '💬',
          title: '这张卡还没有对话',
          desc: '点上面的「用这张卡开新对话」，写卡区不用切走就能开演。',
        }),
      );
    } else {
      listHost.replaceChildren(
        ...items.map((chat, index) =>
          h(
            'div',
            { class: 'card-chat-row' },
            h(
              'div',
              { class: 'card-chat-main' },
              h('div', { class: 'card-chat-title' }, `第 ${index + 1} 个 · ${chat.title || '（无标题）'}`),
              h(
                'div',
                { class: 'card-chat-sub' },
                `${chat.messageCount ?? 0} 条 · ${formatTime(chat.lastMessageAt ?? chat.updatedAt) || '没聊过'}`,
              ),
            ),
            h(
              'div',
              { class: 'card-chat-actions' },
              h('button', { class: 'btn small primary', onclick: () => goChat(chat.id) }, '继续'),
              h(
                'button',
                {
                  class: 'btn small',
                  onclick: async () => {
                    const value = await promptText({ title: '重命名对话', label: '对话标题', value: chat.title ?? '' });
                    if (value === null) return;
                    const title = value.trim();
                    if (!title) {
                      toast('标题不能空着', { tone: 'warn' });
                      return;
                    }
                    try {
                      await put(`/api/chats/${chat.id}`, { title });
                      await refresh();
                      onChanged?.();
                    } catch (err) {
                      toastError(err);
                    }
                  },
                },
                '重命名',
              ),
              h('button', { class: 'btn small', onclick: () => downloadChat(chat).catch(toastError) }, '导出'),
              h(
                'button',
                {
                  class: 'btn small danger',
                  onclick: async () => {
                    const ok = await confirmDialog({
                      title: '删除对话',
                      message: `确定删掉「${chat.title || '这个对话'}」吗？消息会一起删掉。`,
                      confirmLabel: '删除',
                    });
                    if (!ok) return;
                    try {
                      await del(`/api/chats/${chat.id}`);
                      toast('已删除');
                      await refresh();
                      onChanged?.();
                    } catch (err) {
                      toastError(err);
                    }
                  },
                },
                '删除',
              ),
            ),
          ),
        ),
      );
    }
    footHost.replaceChildren(
      groups.length
        ? h('div', { class: 'hint', style: { marginTop: '8px' } }, `另外还有 ${groups.length} 个群聊把这张卡当成成员之一（在「群聊」页里管）。`)
        : null,
    );
  }

  async function refresh() {
    try {
      const data = await loadCardChats(card.id);
      items = data.items;
      groups = data.groups;
    } catch (err) {
      listHost.replaceChildren(h('div', { class: 'hint' }, `读不到这张卡的对话：${err?.message ?? err}`));
      return;
    }
    render();
  }

  return { el, refresh };
}

/** 卡编辑器里的那块「这张卡的对话」（带 panel 壳）。 */
export function createCardChatsSection(card, ctx, { onChanged = null } = {}) {
  const body = cardChatsBody(card, ctx, { onChanged });
  const el = panel(
    '这张卡的对话',
    null,
    h('div', { class: 'panel-note' }, '一张卡可以开很多个对话；这里能继续旧对话、开新对话，也能改名 / 删除 / 导出。'),
    body.el,
  );
  return { el, refresh: body.refresh };
}

/** 卡库里的「N 个对话」按钮：弹窗看这张卡的全部对话。 */
export function openCardChatsModal(card, ctx, { onChanged = null } = {}) {
  let modal = null;
  const body = cardChatsBody(card, ctx, { onChanged, onLeave: () => modal?.close() });
  void body.refresh();
  modal = openModal({
    title: `《${card.name}》的对话`,
    width: 'min(760px, 94vw)',
    body: body.el,
  });
  return body;
}
