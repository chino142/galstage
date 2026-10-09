/**
 * 玩卡区 · 对话。
 *
 * 左边是对话列表（新建 / 导入 / 搜索），右边是多标签的消息流 + 输入框。
 * 流式输出、重新生成、继续、扮演、编辑 / 删除 / 插入、系统 / 隐藏、token 与花费
 * 都在这一个界面上；群聊也用这个界面，只是每条消息多了说话人的名字。
 */

import { h, statusChip } from '../core/dom.mjs';
import { get, post, put, del } from '../core/api.mjs';
import { panel, field, emptyState, errorBox, loading } from '../ui/components.mjs';
import { openModal, confirmDialog } from '../ui/modal.mjs';
import { openTextOutput } from '../ui/output.mjs';
import { toast, toastError } from '../ui/toast.mjs';
import { matchesCombo } from '../core/shortcuts.mjs';
import { getSetting } from '../core/prefs.mjs';
import { t } from '../core/i18n.mjs';
import { notifyTurnDone } from '../ui/notify.mjs';
import { createCardSandbox } from '../ui/card-sandbox.mjs';
import { openModuleManager } from '../ui/module-manager.mjs';
import {
  assetFileUrl,
  costText,
  emptyChatState,
  fetchChats,
  formatTime,
  hasPendingRuns,
  libraryCardSelect,
  loadLibraryCards,
  messageBubble,
  streamTurn,
  textPrompt,
} from './playing-common.mjs';
import { chatOrdinal, chatRowLabel, loadCardChats, planChatList } from './card-chats.mjs';

export function createChatView(module, ctx) {
  const el = h('div', { class: 'view' });
  const shortcuts = ctx.shortcuts ?? null;
  const tabsHost = h('div', { class: 'chat-tabs' });
  // 顶部那条"这是《某卡》的第 N 个对话"：把对话锚回它那张卡，点数字切同卡的别的对话。
  const cardBarHost = h('div', { class: 'chat-card-bar' });
  const listHost = h('div', { class: 'chat-list' });
  const threadHost = h('div', { class: 'chat-thread' });
  const optionsHost = h('div', { class: 'option-strip' });
  const composerHost = h('div', { class: 'composer' });
  const costHost = h('span', { class: 'panel-note' }, '');
  const cardUiHost = h('div', { class: 'card-ui' });
  // 模块（Mod）挂上的东西：只带 CSS 的走 moduleStyle，带 HTML/JS 的在 moduleHost 里跑沙箱
  const moduleHost = h('div', {});
  const moduleStyle = h('style', {});
  const moduleSandboxes = [];

  // 卡内界面：这张卡的对话里，把卡自带的 HTML/CSS/JS 跑在沙箱里。
  // 自己的卡自动跑；导入的卡要你点一下（策略由服务端按卡的来源 + 信任记录判定）。
  const sandbox = createCardSandbox({ getChatId: () => activeId });

  let chats = [];
  let tabs = [];
  let activeId = null;
  let chat = null;
  let messages = [];
  let busy = false;
  let config = {}; // 模型 / 群聊策略等元数据，按需缓存
  let fullSearchTimer = null;
  let pendingHighlight = null;
  let messageRuns = new Map(); // messageId → 出图记录（进度 / 失败原因）
  let imagePollTimer = null;
  let cardBarToken = 0; // 顶栏是异步拼的，切对话后旧的那次结果直接丢掉
  let configButton = null; // 对话配置按钮（覆盖了几项要就地更新，别整个重画输入框）

  const searchInput = h('input', { placeholder: t('chat.searchChats'), oninput: (event) => refreshList(event.target.value) });
  const fullSearchInput = h('input', {
    placeholder: t('chat.searchAll'),
    oninput: (event) => {
      const value = event.target.value;
      clearTimeout(fullSearchTimer);
      fullSearchTimer = setTimeout(() => searchAll(value), 260);
    },
  });
  const searchResultsHost = h('div', { class: 'search-results' });
  const fileInput = h('input', {
    type: 'file',
    accept: '.jsonl,.json,text/plain,application/json',
    style: { display: 'none' },
    onchange: (event) => importFile(event.target.files?.[0]),
  });

  const headerActions = [
    h('button', { class: 'btn primary', onclick: () => createChatDialog() }, '＋ 新建对话'),
    h('button', { class: 'btn', onclick: () => fileInput.click() }, '⬆ 导入 JSONL'),
  ];

  el.append(
    panel(
      module.title,
      null,
      h('div', { class: 'panel-note' }, module.summary),
      h('div', { style: { marginTop: '12px', display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' } }, headerActions, statusChip(module.status)),
    ),
    h(
      'div',
      { class: 'chat-layout' },
      h(
        'aside',
        { class: 'chat-sidebar' },
        searchInput,
        listHost,
        h('div', { class: 'panel-note' }, '全文搜索（所有对话）'),
        fullSearchInput,
        searchResultsHost,
      ),
      h('section', { class: 'chat-main' }, moduleStyle, tabsHost, cardBarHost, costHost, cardUiHost, moduleHost, threadHost, optionsHost, composerHost),
    ),
    fileInput,
  );

  // ---------------------------------------------------------------- 列表

  async function refreshList(search = searchInput.value) {
    try {
      chats = await fetchChats({ search });
    } catch (err) {
      listHost.replaceChildren(errorBox(err, { onRetry: () => refreshList() }));
      return;
    }
    renderList();
  }

  // 左栏「按卡分组」的收起状态：按卡 id 记，刷新后还在。
  const collapsedCards = new Set();
  try {
    if (typeof localStorage !== 'undefined') {
      for (const id of JSON.parse(localStorage.getItem('st.collapsedChatCards') ?? '[]')) collapsedCards.add(String(id));
    }
  } catch {
    // 没 localStorage / 存的是坏 JSON：当"从没收起过"
  }
  function saveCollapsedCards() {
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem('st.collapsedChatCards', JSON.stringify([...collapsedCards]));
    } catch {
      // 存不了就算了，收起状态本来就不是关键
    }
  }

  /** 一条对话（列表里的最小行）。群聊与"没挂卡"的对话平铺，挂卡的收在卡组里。 */
  function chatItemNode(item, { ordinal = 0, multi = false, cardName = '' } = {}) {
    const badge = item.isGroup ? '👥' : '💬';
    const title = chatRowLabel(item, { ordinal, multi, cardName });
    return h(
      'div',
      {
        class: `chat-item${item.id === activeId ? ' active' : ''}`,
        role: 'button',
        tabindex: '0',
        onclick: () => openChat(item.id),
      },
      h('div', { class: 'chat-item-title' }, `${badge} ${title}`),
      h('div', { class: 'chat-item-sub' }, `${item.messageCount ?? 0} 条 · ${formatTime(item.lastMessageAt ?? item.updatedAt)}`),
      item.lastMessage ? h('div', { class: 'chat-item-preview' }, item.lastMessage) : null,
      h(
        'div',
        { class: 'chat-item-actions' },
        h('button', {
          class: 'link-btn chat-item-del',
          title: '删除这个对话',
          onclick: (event) => {
            event.stopPropagation();
            void removeChat(item);
          },
        }, '✕'),
      ),
    );
  }

  /** 直接用某张卡开一个新对话（卡组表头的 ＋）。 */
  async function newChatForCard(characterId, cardName) {
    try {
      const created = await post('/api/chats', { characterId });
      collapsedCards.delete(characterId);
      saveCollapsedCards();
      toast(`用《${cardName}》开了个新对话`);
      await refreshList();
      await openChat(created.id);
    } catch (err) {
      toastError(err);
    }
  }

  /**
   * 删掉一个对话（左栏每条对话右边的 ✕）。
   * 删的正好是当前打开的那个：顺手关掉它，落到别的对话；一个不剩就回到空状态。
   */
  async function removeChat(item) {
    const ok = await confirmDialog({
      title: '删除对话',
      message: `确定删掉「${item.title || '这个对话'}」吗？里面的消息会一起删掉，删了拿不回来。`,
      confirmLabel: '删除',
    });
    if (!ok) return;
    try {
      await del(`/api/chats/${item.id}`);
      tabs = tabs.filter((tab) => tab.id !== item.id);
      toast('已删除');
      await refreshList();
      if (item.id === activeId) await openChat(chats[0]?.id ?? null);
      else renderTabs();
    } catch (err) {
      toastError(err);
    }
  }

  function renderList() {
    if (!chats.length) {
      listHost.replaceChildren(emptyChatState('还没有对话', h('button', { class: 'btn', onclick: () => createChatDialog() }, '新建一个')));
      return;
    }
    // 同一张卡的多条对话收在一个组里；群聊、没挂卡的对话照旧平铺。具体排法见 planChatList。
    const nodes = planChatList(chats).map((block) => {
      if (block.type === 'chat') return chatItemNode(block.chat);
      const { id, name, items } = block;
      const hasActive = items.some((entry) => entry.id === activeId);
      // 当前对话在这个组里时强制展开，免得"切过来却看不见自己"
      const collapsed = collapsedCards.has(id) && !hasActive;
      const head = h(
        'div',
        {
          class: `chat-group-head${hasActive ? ' active' : ''}`,
          title: '点一下展开 / 收起这张卡的对话',
          onclick: () => {
            if (collapsedCards.has(id)) collapsedCards.delete(id);
            else collapsedCards.add(id);
            saveCollapsedCards();
            renderList();
          },
        },
        h('span', { class: 'chat-group-caret' }, collapsed ? '▸' : '▾'),
        h('span', { class: 'chat-group-name' }, `💬 ${name}`),
        h('span', { class: 'chat-group-count' }, `${items.length} 个对话`),
        h('button', {
          class: 'link-btn chat-group-add',
          title: `用《${name}》开新对话`,
          onclick: (event) => {
            event.stopPropagation();
            void newChatForCard(id, name);
          },
        }, '＋'),
      );
      return h(
        'div',
        { class: 'chat-group' },
        head,
        h(
          'div',
          { class: `chat-group-children${collapsed ? ' collapsed' : ''}` },
          ...items.map((entry, index) => chatItemNode(entry, { ordinal: index + 1, multi: items.length > 1, cardName: name })),
        ),
      );
    });
    listHost.replaceChildren(...nodes);
  }

  function renderTabs() {
    tabsHost.replaceChildren(
      ...tabs.map((tab) =>
        h(
          'div',
          { class: `tab chat-tab${tab.id === activeId ? ' active' : ''}` },
          h('span', { onclick: () => openChat(tab.id) }, tab.title),
          h(
            'button',
            {
              class: 'link-btn',
              title: '关闭标签',
              onclick: (event) => {
                event.stopPropagation();
                tabs = tabs.filter((item) => item.id !== tab.id);
                if (activeId === tab.id) openChat(tabs.at(-1)?.id ?? null);
                else renderTabs();
              },
            },
            '✕',
          ),
        ),
      ),
      h('button', { class: 'link-btn', title: '新建对话', onclick: () => createChatDialog() }, '＋'),
    );
  }

  // ---------------------------------------------------------------- 打开一个对话

  // ---------------------------------------------------------------- 卡内界面（卡自带的 HTML/CSS/JS）
  // 代码存在卡数据里（写卡区 → 卡内前端 → 存到这张卡）；这里只负责把它跑起来。
  // 自动跑还是等你点一下，由服务端按"卡的来源 + 你信不信这段代码"判定（core/frontend/policy.mjs）。

  let cardUiData = null;
  let cardUiCardId = '';
  let cardUiHeightUnsub = null;

  function renderCardUi() {
    const data = cardUiData;
    if (!data?.hasCode) {
      cardUiHeightUnsub?.();
      cardUiHeightUnsub = null;
      cardUiHost.classList.remove('immersive');
      cardUiHost.replaceChildren();
      return;
    }
    const bodyHost = h('div', { class: 'card-ui-body' });
    const status = h('div', { class: 'panel-note' }, data.blocked ? `跑不了：${data.blocked}` : (data.policy.trusted ? '' : '这张卡不是你自己写的：点「运行」才跑。'));

    const run = () => {
      if (!data.render) {
        toast(data.blocked ?? '这段代码过不了沙箱检查', { tone: 'warn' });
        return;
      }
      sandbox.mount(data.render);
      bodyHost.replaceChildren(sandbox.el);
      status.textContent = `已运行 · sandbox="${data.render.sandbox}" · 指纹 ${String(data.codeHash).slice(0, 8)}`;
    };

    const immersiveBtn = h('button', {
      class: 'btn',
      title: '把卡内界面铺满整个屏幕，再点一下退出',
      onclick: () => {
        cardUiHost.classList.toggle('immersive');
        immersiveBtn.textContent = cardUiHost.classList.contains('immersive') ? '退出沉浸' : '沉浸';
      },
    }, '沉浸');

    const buttons = [
      h('button', { class: 'btn primary', onclick: run }, '运行'),
      h('button', { class: 'btn', onclick: () => { sandbox.clear(); bodyHost.replaceChildren(); status.textContent = '已停止。'; } }, '停止'),
      immersiveBtn,
    ];
    if (data.policy.trustedByUser) {
      buttons.push(h('button', {
        class: 'btn',
        onclick: async () => {
          try {
            cardUiData = await del(`/api/characters/${encodeURIComponent(data.cardId)}/frontend/trust`);
            renderCardUi();
            toast('已取消信任');
          } catch (err) {
            toastError(err);
          }
        },
      }, '取消信任'));
    } else if (!data.policy.autoRun) {
      buttons.push(h('button', {
        class: 'btn',
        onclick: async () => {
          try {
            cardUiData = await post(`/api/characters/${encodeURIComponent(data.cardId)}/frontend/trust`, {});
            renderCardUi();
            run();
          } catch (err) {
            toastError(err);
          }
        },
      }, '信任这张卡'));
    }

    // 高度档位：自适应（卡片 ui.resize 报高度）/ 三个固定档；底部还能直接拖。
    const heightRow = h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center', margin: '6px 0' } },
      h('span', { class: 'panel-note' }, '高度：'),
      h('button', { class: 'btn', onclick: () => sandbox.followCardHeight() }, '自适应'),
      ...[260, 400, 640].map((px) => h('button', { class: 'btn', onclick: () => sandbox.setHeight(px) }, `${px}px`)),
      h('span', { class: 'panel-note' }, ''),
    );
    const heightLabel = heightRow.children[heightRow.children.length - 1];
    const renderHeight = (state) => {
      heightLabel.textContent = state.followCard
        ? (state.reportedHeight ? `卡片报的高度 ${Math.round(state.reportedHeight)}px` : '自适应（卡片还没报高度）')
        : `固定 ${Math.round(state.height)}px`;
    };
    renderHeight(sandbox.state());
    cardUiHeightUnsub?.();
    cardUiHeightUnsub = sandbox.onChangeHeight(renderHeight);

    cardUiHost.replaceChildren(
      panel(
        '卡内界面',
        `${data.name} · ${data.policy.title}`,
        h('div', { class: 'panel-note' }, data.policy.reason),
        h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', margin: '8px 0' } }, buttons),
        status,
        heightRow,
        bodyHost,
      ),
    );

    // 自己的卡（或你信任过的）：打开对话直接跑
    if (data.policy.autoRun && data.render) run();
  }

  /**
   * 挂在这个对话上的模块（Mod）。
   *
   * 服务端已经把"这段 CSS 能不能改整页"判完了（自己写的全放开，别人的收进消息区），
   * 这里只管把结果装上：样式塞进 moduleStyle，带 HTML/JS 的模块各自挂一块沙箱 iframe。
   */
  async function refreshModules() {
    for (const sandbox of moduleSandboxes) sandbox.clear();
    moduleSandboxes.length = 0;
    moduleHost.replaceChildren();
    moduleStyle.textContent = '';
    if (!activeId) return;
    try {
      const data = await get(`/api/chats/${activeId}/modules`);
      if (data.css) moduleStyle.textContent = data.css;
      // 模块带的背景图：铺在消息区后面（消息气泡自己有底色，字还是看得清）
      threadHost.style.backgroundImage = data.background ? `url(${assetFileUrl(data.background)})` : '';
      threadHost.style.backgroundSize = 'cover';
      threadHost.style.backgroundPosition = 'center';
      for (const panel of data.panels ?? []) {
        const sandbox = createCardSandbox({ getChatId: () => activeId });
        if (!panel.render) continue;
        sandbox.mount(panel.render);
        moduleSandboxes.push(sandbox);
        moduleHost.append(
          h(
            'div',
            { class: 'panel', style: { marginTop: '10px' } },
            h('div', { class: 'panel-note' }, `模块：${panel.title}${panel.needsTrust ? '（别人的代码：点了信任才会跑）' : ''}`),
            sandbox.el,
          ),
        );
      }
      for (const note of data.notes ?? []) console.info('[模块]', note);
    } catch (err) {
      console.warn('[模块] 读取失败', err);
    }
  }

  async function refreshCardUi(chatItem) {
    const cardId = chatItem?.characterId ?? '';
    if (!cardId) {
      // 群聊 / 临时卡 / 没选对话：不挂卡内界面
      cardUiCardId = '';
      cardUiData = null;
      sandbox.clear();
      cardUiHeightUnsub?.();
      cardUiHeightUnsub = null;
      cardUiHost.classList.remove('immersive');
      cardUiHost.replaceChildren();
      return;
    }
    // 同一张卡、界面还跑着：**别重挂**（重挂等于把卡停掉），交给事件通知就够了
    if (cardId === cardUiCardId && sandbox.mounted) return;
    cardUiCardId = cardId;
    sandbox.clear();
    cardUiHeightUnsub?.();
    cardUiHeightUnsub = null;
    cardUiHost.classList.remove('immersive');
    cardUiHost.replaceChildren();
    cardUiData = null;
    try {
      cardUiData = await get(`/api/characters/${encodeURIComponent(cardId)}/frontend`);
    } catch {
      return; // 卡被删了就安静地不显示
    }
    if (cardUiData?.hasCode) renderCardUi();
  }

  async function openChat(id) {
    if (!id) {
      activeId = null;
      chat = null;
      messages = [];
      messageRuns = new Map();
      cardBarToken += 1;
      sandbox.clear();
      cardUiData = null;
      cardUiHeightUnsub?.();
      cardUiHeightUnsub = null;
      cardUiHost.classList.remove('immersive');
      cardUiHost.replaceChildren();
      cardBarHost.replaceChildren();
      if (imagePollTimer) clearTimeout(imagePollTimer);
      imagePollTimer = null;
      renderTabs();
      renderList();
      threadHost.replaceChildren(emptyChatState());
      composerHost.replaceChildren();
      optionsHost.replaceChildren();
      return;
    }
    activeId = id;
    cardBarToken += 1;
    cardBarHost.replaceChildren();
    renderList();
    threadHost.replaceChildren(loading());
    try {
      chat = await get(`/api/chats/${id}`);
      messages = (await get(`/api/chats/${id}/messages`)).items;
    } catch (err) {
      threadHost.replaceChildren(errorBox(err, { onRetry: () => openChat(id) }));
      return;
    }
    await refreshMessageRuns();
    if (!tabs.some((tab) => tab.id === id)) tabs.push({ id, title: chat.title });
    renderTabs();
    void refreshCardUi(chat);
    void refreshModules();
    renderThread();
    renderComposer();
    renderCost();
    void refreshOptions();
    void refreshCardBar(chat);
    syncHash(id);
    ctx.shell?.setSubtitle?.(`${chat.isGroup ? '群聊' : '单聊'} · ${chat.title}`);
  }

  /**
   * 把地址栏里的 `#/chat/<chatId>` 跟当前打开的对话对齐。
   *
   * 用 replaceState 而不是 navigate：这里只是记账，不该把整个视图重挂一遍
   * （挂一次会把输入框里的草稿、标签页全丢掉）。在别的板块里点开对话时
   * 哈希本来就由 navigate 写好了，这里看到一致就什么都不做。
   */
  function syncHash(id) {
    try {
      const target = `#/chat/${id}`;
      if (window.location.hash === target) return;
      const section = window.location.hash.replace(/^#\/?/, '').split('/')[0];
      if (section !== 'chat') return;
      window.history.replaceState(null, '', target);
    } catch {
      // 没有 history（极端老环境）就算了，不影响用
    }
  }

  /**
   * 对话页顶上那条「这是《某卡》的第 N 个对话」。
   *
   * 一张卡可以开很多个对话 —— 这里把当前对话放回它那张卡的序号里，点旁边的数字
   * 就能切到同一张卡的其他对话。群聊不显示（它有自己的板块和成员概念）。
   */
  async function refreshCardBar(item) {
    const mine = ++cardBarToken;
    cardBarHost.replaceChildren();
    if (!item?.characterId || item.isGroup) return;
    let data;
    try {
      data = await loadCardChats(item.characterId);
    } catch {
      return; // 读不到就安静地不显示，别在对话页顶上挂个报错
    }
    if (mine !== cardBarToken) return;
    const index = chatOrdinal(data.items, item.id);
    if (!index) return;
    // 卡名字以卡库里的当前值为准（卡改过名，对话标题还是老的）
    let cardName = item.members?.[0]?.name ?? '';
    try {
      const card = await get(`/api/characters/${encodeURIComponent(item.characterId)}`);
      cardName = card?.name ?? cardName;
    } catch {
      // 卡被删了就用手上的名字兜底
    }
    if (mine !== cardBarToken) return;
    cardBarHost.replaceChildren(
      h(
        'div',
        { class: 'chat-card-bar-inner' },
        h(
          'div',
          { class: 'chat-card-bar-label' },
          `🃏 这是《${cardName || '这张卡'}》的第 ${index} 个对话`,
          h('span', { class: 'panel-note' }, `共 ${data.items.length} 个`),
        ),
        h(
          'div',
          { class: 'chat-card-bar-switch' },
          data.items.map((sibling, position) =>
            h(
              'button',
              {
                class: `chip-btn${sibling.id === item.id ? ' active' : ''}`,
                title: sibling.title || `第 ${position + 1} 个对话`,
                onclick: () => {
                  if (sibling.id !== activeId) void openChat(sibling.id);
                },
              },
              String(position + 1),
            ),
          ),
          h(
            'button',
            {
              class: 'btn small',
              title: '用同一张卡再开一个对话',
              onclick: () => void newSiblingChat(item.characterId),
            },
            '＋ 新对话',
          ),
        ),
      ),
    );
  }

  /** 在当前这张卡下再开一个对话并切过去。 */
  async function newSiblingChat(characterId) {
    try {
      const created = await post('/api/chats', { characterId });
      await refreshList();
      await openChat(created.id);
      toast('开了一个新对话');
    } catch (err) {
      toastError(err);
    }
  }

  /** 全文搜索：在所有对话里找一段话，点结果直接跳过去并高亮那一条。 */
  async function searchAll(keyword) {
    const query = String(keyword ?? '').trim();
    if (!query) {
      searchResultsHost.replaceChildren();
      return;
    }
    try {
      const data = await get(`/api/search?q=${encodeURIComponent(query)}&limit=30`);
      const items = data.items ?? [];
      searchResultsHost.replaceChildren(
        items.length
          ? h(
              'div',
              {},
              h('div', { class: 'hint' }, `${items.length} 条结果`),
              ...items.map((item) =>
                h(
                  'button',
                  {
                    class: 'search-hit',
                    onclick: async () => {
                      pendingHighlight = item.id;
                      await openChat(item.chatId);
                    },
                  },
                  h('div', { class: 'chat-item-title' }, `${item.name || item.role} · ${item.chatTitle ?? ''}`),
                  h('div', { class: 'chat-item-preview' }, String(item.content).slice(0, 60)),
                ),
              ),
            )
          : h('div', { class: 'hint' }, '没有找到'),
      );
    } catch (err) {
      searchResultsHost.replaceChildren(h('div', { class: 'hint' }, err.message));
    }
  }

  function renderCost() {
    const last = [...messages].reverse().find((message) => message.extra?.usage);
    const lastUsage = last?.extra?.usage;
    if (!lastUsage) {
      costHost.textContent = '';
      return;
    }
    const usage = lastUsage;
    costHost.textContent = `上一轮 ≈ ${usage.promptTokens ?? 0} 输入 / ${usage.completionTokens ?? 0} 输出 token · 花费 ${costText(last?.cost ?? null)}`;
  }

  function renderThread() {
    if (!messages.length) {
      threadHost.replaceChildren(emptyState({ icon: '🪶', title: '空对话', desc: '发第一句话，或者用「扮演」让模型替你开个头。' }));
      ensureImagePoll();
      return;
    }
    threadHost.replaceChildren(
      ...messages.map((message) =>
        messageBubble(message, { onAction: handleAction, runs: messageRuns.get(message.id) ?? [], onRunAction: handleRunAction }),
      ),
    );
    if (pendingHighlight) {
      const target = threadHost.querySelector(`[data-message-id="${pendingHighlight}"]`);
      if (target) {
        target.classList.add('highlight');
        target.scrollIntoView({ block: 'center' });
      }
      pendingHighlight = null;
      return;
    }
    threadHost.scrollTop = threadHost.scrollHeight;
    ensureImagePoll();
  }

  /**
   * 出图是异步的：提交完接口就返回了，图片要几秒后才入库并绑到消息上。
   * 所以有排队 / 进行中的任务时，每隔几秒重拉一次出图记录并重画消息区。
   */
  async function refreshMessageRuns() {
    const next = new Map();
    messageRuns = next;
    if (!activeId) return;
    try {
      const data = await get(`/api/comfy/runs?chatId=${encodeURIComponent(activeId)}&limit=100`);
      for (const run of data.items ?? []) {
        if (!run.messageId) continue;
        const list = next.get(run.messageId) ?? [];
        list.push(run);
        next.set(run.messageId, list);
      }
    } catch {
      // 没配 ComfyUI / 服务连不上时不该影响聊天本身，静默即可
    }
    messageRuns = next;
  }

  function ensureImagePoll() {
    if (el.isConnected === false) return;
    const pending = [...messageRuns.values()].some((runs) => hasPendingRuns(runs));
    if (!pending) {
      if (imagePollTimer) clearTimeout(imagePollTimer);
      imagePollTimer = null;
      return;
    }
    if (imagePollTimer) return;
    imagePollTimer = setTimeout(async () => {
      imagePollTimer = null;
      await refreshMessageRuns();
      if (activeId) renderThread();
      ensureImagePoll();
    }, 2500);
  }

  async function handleRunAction(action, run) {
    if (action !== 'retry' || !activeId) return;
    try {
      // 浏览器直连模式下不能走服务器提交（那会让主机去连用户地址）。
      const config = await get('/api/comfy/config').catch(() => null);
      const settings = config?.settings ?? {};
      if (settings['comfy.executionMode'] === 'client') {
        const { runClientImage } = await import('../ui/comfy-client.mjs');
        toast('已交给你的浏览器重新出图，跑完会自动贴到这条消息上');
        void runClientImage({
          baseUrl: settings['comfy.baseUrl'],
          workflowId: run.workflowId,
          chatId: activeId,
          messageId: run.messageId,
          reason: 'retry',
        })
          .then(async () => {
            await refreshMessageRuns();
            if (activeId) renderThread();
          })
          .catch((err) => toastError(err));
        await refreshMessageRuns();
        renderThread();
        return;
      }
      await post('/api/comfy/run', {
        workflowId: run.workflowId,
        chatId: activeId,
        messageId: run.messageId,
        reason: 'retry',
      });
      toast('重新出图，跑完会自动贴到这条消息上');
      await refreshMessageRuns();
      renderThread();
    } catch (err) {
      toastError(err);
    }
  }

  function appendLive(id, memberName) {
    const bubble = messageBubble({ id, role: 'assistant', name: memberName ?? '角色', content: '' }, { live: true });
    threadHost.append(bubble);
    threadHost.scrollTop = threadHost.scrollHeight;
    const body = bubble.querySelector('.msg-body');
    // 非流式（整段返回）的提供方不会有 delta，先给一句占位，别让气泡空着
    if (body) body.textContent = '生成中…';
    return body;
  }

  function renderComposer() {
    if (!chat) {
      composerHost.replaceChildren();
      return;
    }
    const modelHost = h('div', { class: 'model-switch' });
    const presetHost = h('div', { class: 'preset-switch' });
    const limitHost = h('div', { class: 'limit-switch' });
    const lengthHost = h('div', { class: 'length-switch' });
    const groupHost = h('div', { class: 'group-strip' });
    const input = h('textarea', {
      rows: 3,
      placeholder: t('chat.placeholder'),
      onkeydown: (event) => {
        // 发送键可自定义（设置 → 快捷键 → 发送）；Shift+Enter 永远是换行
        if (matchesCombo(event, getSetting('ui.shortcut.send', 'Enter'))) {
          event.preventDefault();
          send(input.value);
        }
      },
    });
    const sendBtn = h('button', { class: 'btn primary', onclick: () => send(input.value) }, t('btn.send'));
    const impersonateBtn = h('button', { class: 'btn', onclick: () => impersonate(input) }, t('btn.impersonate'));
    const continueBtn = h('button', { class: 'btn', onclick: () => runTurn('continue') }, t('btn.continue'));
    const regenBtn = h('button', { class: 'btn', onclick: () => runTurn('regenerate') }, t('btn.regenerate'));
    const optionsBtn = h('button', { class: 'btn', onclick: () => refreshOptions({ generate: true }) }, t('btn.options'));
    const exportBtn = h('button', { class: 'btn', onclick: () => exportChat() }, t('btn.export'));
    const chapterBtn = h('button', { class: 'btn', onclick: () => makeChapter() }, '📖 变成章节');
    const extractBtn = h('button', { class: 'btn', onclick: () => extractEntities() }, '🧩 抽取素材');
    composerHost.replaceChildren(
      groupHost,
      h('div', { class: 'composer-switches' }, modelHost, presetHost, limitHost, lengthHost),
      input,
      h(
        'div',
        { class: 'composer-actions' },
        sendBtn,
        impersonateBtn,
        continueBtn,
        regenBtn,
        optionsBtn,
        h('button', {
          class: 'btn',
          title: '挂几个模块：总结 / 选项 / 记忆区 / 美化……',
          onclick: () => openModuleManager({ chatId: activeId, onChange: () => refreshModules() }),
        }, '🧩 模块'),
        configButton = h('button', {
          class: 'btn',
          title: '这个对话单独的 提示词 / 前置词 / 后置词：留空就跟着卡片级走',
          onclick: () => void openChatConfig(),
        }, configLabel()),
        chapterBtn,
        extractBtn,
        exportBtn,
      ),
    );
    renderGroupStrip(groupHost);
    renderModelSwitch(modelHost);
    renderPresetSwitch(presetHost);
    renderLimitSwitch(limitHost);
    renderLengthSwitch(lengthHost);
  }

  /**
   * 「最少字数」：写进提示词**最末尾**的一条硬性长度要求。
   *
   * 为什么单独做这个：预设里那些「要写够 1000 字」通常埋在系统提示中间，模型经常当没看见
   * （实测：给了 1000 字要求，它 248 token 就自己收尾了，finish=stop 不是被截断）。
   * 放在对话最末尾的一条，模型基本会照办。空 = 不加这条。
   */
  async function renderLengthSwitch(host) {
    const saved = Number(chat.settings?.minChars ?? 0) || 0;
    const input = h('input', {
      type: 'number',
      min: '0',
      max: '20000',
      step: '100',
      value: saved || '',
      placeholder: '不限',
      style: { width: '104px' },
      title: '本轮正文至少写多少字（不含思考过程 / 小总结 / 行动选项）。会作为对话最末尾的一条要求发出去。',
      onchange: async (event) => {
        const raw = String(event.target.value ?? '').trim();
        const next = raw ? Math.max(0, Math.round(Number(raw) || 0)) : 0;
        try {
          const settings = { ...(chat.settings ?? {}) };
          if (next) settings.minChars = next;
          else delete settings.minChars;
          chat = await put(`/api/chats/${chat.id}`, { settings });
          toast(next ? `这个对话要求正文不少于 ${next} 字` : '去掉字数要求');
          await renderLengthSwitch(host);
        } catch (err) {
          toastError(err);
        }
      },
    });
    const hint = h('span', { class: 'hint' }, saved ? '写在提示词最末尾' : '空 = 不要求');
    host.replaceChildren(h('span', { class: 'hint' }, '最少字数'), input, hint, thinkingTranslateToggle());

    // 上限够不够：中文大约 1 字 ≈ 0.72 token，再给思考 / 总结 / 选项留点余量
    if (saved) {
      const cap = Number(chat.settings?.params?.max_tokens ?? 0) || 0;
      if (cap && cap < saved * 1.2) {
        hint.textContent = `上限 ${cap} 可能不够（约要 ${Math.ceil(saved * 1.2)}）`;
      }
    }
  }

  /** 「思维链自动译中文」：默认关，开了之后每轮生成完自动翻一条。 */
  function thinkingTranslateToggle() {
    const on = chat.settings?.translateReasoning === true;
    const box = h('input', {
      type: 'checkbox',
      checked: on,
      style: { width: '16px', height: '16px' },
      title: '每轮生成完自动把思维链译成中文（会多调一次模型，只改显示，不动原文）',
      onchange: async (event) => {
        try {
          const settings = { ...(chat.settings ?? {}) };
          if (event.target.checked) settings.translateReasoning = true;
          else delete settings.translateReasoning;
          chat = await put(`/api/chats/${chat.id}`, { settings });
          toast(event.target.checked ? '以后思维链自动译成中文' : '不再自动翻译思维链');
        } catch (err) {
          toastError(err);
        }
      },
    });
    const zhBox = h('input', {
      type: 'checkbox',
      checked: chat.settings?.thinkingChinese === true,
      style: { width: '16px', height: '16px' },
      title: '在提示词最末尾加一条"思考过程请用简体中文写"（比事后翻译更省一次模型调用）',
      onchange: async (event) => {
        try {
          const settings = { ...(chat.settings ?? {}) };
          if (event.target.checked) settings.thinkingChinese = true;
          else delete settings.thinkingChinese;
          chat = await put(`/api/chats/${chat.id}`, { settings });
          toast(event.target.checked ? '以后让模型直接用中文思考' : '不再要求思考语言');
        } catch (err) {
          toastError(err);
        }
      },
    });
    return h(
      'span',
      { style: { display: 'inline-flex', gap: '12px', flexWrap: 'wrap' } },
      h('label', { class: 'switch-row', style: { gap: '6px' } }, zhBox, h('span', { class: 'hint' }, '思考用中文')),
      h('label', { class: 'switch-row', style: { gap: '6px' } }, box, h('span', { class: 'hint' }, '思维链自动译中文')),
    );
  }

  /** 把一条消息的思维链译成中文，存进 extra.reasoningZh（只改显示，原文保留）。 */
  async function translateReasoning(message) {
    const text = String(message?.extra?.reasoning ?? '').trim();
    if (!text) return;
    try {
      const result = await post('/api/studio/translate', { text, target: 'zh-CN' });
      const translated = String(result.translation ?? '').trim();
      if (!translated) {
        toast('翻译没返回内容', { tone: 'warn' });
        return;
      }
      await put(`/api/chats/${activeId}/messages/${message.id}`, { extra: { ...(message.extra ?? {}), reasoningZh: translated } });
      await reload();
    } catch (err) {
      toastError(err);
    }
  }

  // ---------------------------------------------------------------- 对话配置（提示词 / 前置词 / 后置词）

  /**
   * 这三样在卡片级也有（写卡区 → 编辑器 → 提示词那一组），对话级可以单独盖住。
   * 规矩：**留空 = 跟随卡片级**；打开「覆盖」之后填的内容（哪怕是空的）就只按对话里这份算。
   * 组装那边认的就是"键在不在"（见 core/prompts/assemble.mjs 第 2 段与 13.5 段）。
   */
  const OVERRIDE_FIELDS = [
    {
      key: 'cardSystemPrompt',
      cardKey: 'system_prompt',
      title: '提示词',
      cardTitle: '卡片级的「系统提示」',
      hint: '就是角色卡里的「系统提示」（写卡区 → 编辑器 → 提示词）。留空 = 用卡片级那份；覆盖后填「{{original}}」能把内置的默认系统提示词嵌进来。',
    },
    {
      key: 'prefixText',
      cardKey: 'prefix_text',
      title: '前置词',
      cardTitle: '卡片级的「前置词」',
      hint: '拼在「最后一条用户消息」的前面，不是单独一条消息 —— 放"这一轮必须遵守"的即时要求最管用。',
    },
    {
      key: 'suffixText',
      cardKey: 'suffix_text',
      title: '后置词',
      cardTitle: '卡片级的「后置词」',
      hint: '拼在「最后一条用户消息」的后面。和前置词一样，贴得离用户发言越近越管用。',
    },
  ];

  /** 这个对话盖住了几样（给按钮上那个角标记数）。 */
  function overrideCount(item = chat) {
    const settings = item?.settings ?? {};
    return OVERRIDE_FIELDS.filter((field) => Object.prototype.hasOwnProperty.call(settings, field.key)).length;
  }

  function configLabel() {
    const count = overrideCount();
    return `⚙ 对话配置${count ? `（覆盖 ${count} 项）` : ''}`;
  }

  /** 角标就地换字：重画整个输入区会把用户还没发出去的草稿弄丢。 */
  function refreshConfigButton() {
    if (configButton) configButton.textContent = configLabel();
  }

  async function openChatConfig() {
    if (!chat) return;

    // 卡片级那份是"建立这个对话时的快照"（成员上存着），不是卡片库里的现在这版 ——
    // 生成时用的也正是它。卡片后来改过的话，下面会提醒，并给一个显式同步的按钮。
    let owner = null;
    let snapshotCard = {};
    let cardName = '';
    const readCards = () => {
      const members = Array.isArray(chat.members) ? chat.members : [];
      owner = members.find((member) => member.characterId && member.characterId === chat.characterId) ?? members[0] ?? null;
      snapshotCard = owner?.card ?? {};
      cardName = liveCard?.name ?? snapshotCard.name ?? '';
    };
    let liveCard = null;
    if (chat.characterId) {
      try {
        liveCard = await get(`/api/characters/${encodeURIComponent(chat.characterId)}`);
      } catch {
        liveCard = null; // 卡被删了就只显示快照
      }
    }
    readCards();

    const body = h('div', { class: 'chat-config' });
    const rowsHost = h('div', { class: 'chat-config' });
    const driftHost = h('div', {});
    const rowRenderers = [];
    body.append(rowsHost, driftHost);

    /** 存一次 settings 并更新手上的 chat（失败就退回原来那份）。 */
    async function saveSettings(mutate) {
      const next = { ...(chat.settings ?? {}) };
      mutate(next);
      chat = await put(`/api/chats/${chat.id}`, { settings: next });
      refreshConfigButton();
    }

    function makeRow(field) {
      const row = h('div', { class: 'chat-config-row' });

      const render = () => {
        const settings = chat.settings ?? {};
        const overridden = Object.prototype.hasOwnProperty.call(settings, field.key);
        const inherited = String(snapshotCard?.[field.cardKey] ?? '');
        const value = overridden ? String(settings[field.key] ?? '') : inherited;

        const status = h('span', { class: `chip small${overridden ? ' ready' : ''}` }, overridden ? '已覆盖（这个对话）' : '继承卡片级');
        const savedNote = h('span', { class: 'hint' }, '');
        const toggle = h('input', {
          type: 'checkbox',
          checked: overridden,
          style: { width: '16px', height: '16px' },
          title: '打开 = 这个对话单独用一份（和卡片级不再联动）；关掉 = 回到跟随卡片级',
        });
        const area = h('textarea', {
          rows: 4,
          disabled: !overridden,
          placeholder: overridden ? '（留空 = 这一样就不要了）' : inherited ? '' : '（卡片级也是空的）',
          onchange: async (event) => {
            if (!Object.prototype.hasOwnProperty.call(chat.settings ?? {}, field.key)) return; // 继承状态下改不了
            try {
              await saveSettings((next) => { next[field.key] = event.target.value; });
              flash(savedNote);
            } catch (err) {
              toastError(err);
              render();
            }
          },
        }, value);

        toggle.addEventListener('change', async () => {
          try {
            if (toggle.checked) {
              // 从"卡片级这份"起步改，比给个空框友好（想清空就自己删掉）
              await saveSettings((next) => { next[field.key] = inherited; });
            } else {
              await saveSettings((next) => { delete next[field.key]; });
            }
            render();
            flash(savedNote);
          } catch (err) {
            toastError(err);
            render();
          }
        });

        row.replaceChildren(
          h(
            'div',
            { class: 'chat-config-head' },
            h('b', {}, field.title),
            status,
            h('span', { class: 'panel-note' }, cardName ? `卡片级：${cardName}` : '这张对话没绑卡库的卡'),
            savedNote,
          ),
          h('div', { class: 'hint' }, field.hint),
          h('div', { class: 'chat-config-edit' }, toggle, h('span', { class: 'hint' }, '覆盖卡片级'), area),
          h(
            'div',
            { class: 'hint' },
            overridden
              ? `现在用的：这个对话里填的 ${String(chat.settings?.[field.key] ?? '').length} 字（卡片级那份 ${inherited.length} 字）`
              : inherited
                ? `现在用的：${field.cardTitle} ${inherited.length} 字${inherited.length > 80 ? ` —— ${inherited.slice(0, 80)}…` : ` —— ${inherited}`}`
                : `${field.cardTitle}是空的，这一样现在不生效`,
          ),
        );
      };

      rowRenderers.push(render);
      render();
      return row;
    }

    rowsHost.append(...OVERRIDE_FIELDS.map(makeRow));

    // 卡片后来改过：说清楚"这个对话还在用旧快照"，并给一个显式同步
    function renderDrift() {
      const drifted = liveCard?.data
        ? OVERRIDE_FIELDS.filter((field) => String(liveCard.data?.[field.cardKey] ?? '') !== String(snapshotCard?.[field.cardKey] ?? ''))
        : [];
      if (!drifted.length) {
        driftHost.replaceChildren();
        return;
      }
      driftHost.replaceChildren(
        h(
          'div',
          { class: 'hint' },
          `卡片库里的《${cardName}》后来改过（${drifted.map((field) => field.title).join('、')}）。这个对话用的是建立时的快照，不会自己跟着变 —— `,
          h(
            'button',
            {
              class: 'link-btn',
              onclick: async () => {
                if (!owner?.id) return;
                const ok = await confirmDialog({
                  title: '同步卡片最新内容',
                  message: `用卡片库里的《${cardName}》现在的这版，覆盖这个对话里存的卡内容\n（简介 / 性格 / 场景 / 提示词 / 前置词 / 后置词都会换成最新的；已经聊过的消息不动）。`,
                  confirmLabel: '同步',
                });
                if (!ok) return;
                try {
                  await put(`/api/group/members/${owner.id}`, { card: liveCard.data });
                  await reload();
                  // reload 会把 chat 换成新的一份（成员上的卡也跟着变了），
                  // 面板上的"继承值"要按新的重画，不能还挂着旧快照。
                  readCards();
                  for (const render of rowRenderers) render();
                  renderDrift();
                  toast('这个对话已经换成卡片的最新内容');
                } catch (err) {
                  toastError(err);
                }
              },
            },
            '同步卡片最新内容',
          ),
        ),
      );
    }
    renderDrift();

    // ---- 历史窗口 / 上下文预算 / 自动总结 ----
    // 这三样以前只有管道默认值，界面上没入口（用户被这个绕住过），现在摊在这里。
    const numberField = (key, { min, max, placeholder }) =>
      h('input', {
        type: 'number',
        min: String(min),
        max: String(max),
        placeholder,
        value: chat.settings?.[key] === undefined ? '' : String(chat.settings[key]),
        style: { width: '120px' },
        onchange: async (event) => {
          const raw = String(event.target.value ?? '').trim();
          try {
            await saveSettings((next) => {
              if (!raw) delete next[key];
              else next[key] = Math.max(min, Math.min(max, Math.round(Number(raw) || min)));
            });
            renderHistory();
          } catch (err) {
            toastError(err);
          }
        },
      });
    const summaryToggle = h('input', {
      type: 'checkbox',
      style: { width: '16px', height: '16px' },
      checked: chat.settings?.autoSummary !== false,
      onchange: async (event) => {
        try {
          await saveSettings((next) => {
            if (event.target.checked) delete next.autoSummary; // 默认就是开
            else next.autoSummary = false;
          });
          renderHistory();
        } catch (err) {
          toastError(err);
        }
      },
    });
    const historyRow = h('div', { class: 'chat-config-row' });

    /** 这一块要重画：改了之后"现在用的是哪一档"得跟着变。 */
    function renderHistory() {
      const windowInput = numberField('historyLimit', { min: 4, max: 400, placeholder: '60（= 30 轮）' });
      const budgetInput = numberField('contextBudget', { min: 0, max: 200000, placeholder: '0 = 不裁' });
      const everyInput = numberField('autoSummaryEvery', { min: 4, max: 200, placeholder: '20' });
      const inherited = (key) => (chat.settings?.[key] === undefined ? '（跟随全局）' : '（这个对话）');
      historyRow.replaceChildren(
        h('div', { class: 'chat-config-head' }, h('b', {}, '历史窗口 / 上下文 / 总结')),
        h(
          'div',
          { class: 'chat-config-edit' },
          h('span', { class: 'hint' }, '历史窗口'),
          windowInput,
          h('span', { class: 'hint' }, `条 ${inherited('historyLimit')}`),
          h('span', { class: 'hint' }, '上下文预算'),
          budgetInput,
          h('span', { class: 'hint' }, `token ${inherited('contextBudget')}`),
        ),
        h(
          'div',
          { class: 'chat-config-edit' },
          h('label', { class: 'switch-row', style: { gap: '6px' } }, summaryToggle, h('span', { class: 'hint' }, '自动总结')),
          h('span', { class: 'hint' }, '积压到'),
          everyInput,
          h('span', { class: 'hint' }, `条就顺手总结一次 ${inherited('autoSummaryEvery')}`),
        ),
        h('div', { class: 'hint' }, '这三样讲的不是一回事，别混：'),
        h('div', { class: 'hint' }, '· 历史窗口 = 每轮带多少条**最近的原文**（你和 AI 各算 1 条，60 条 = 30 轮）'),
        h('div', { class: 'hint' }, '· 上下文预算 = 超过多少 token 就从最老的开始裁（0 = 不按预算裁，只按条数）'),
        h('div', { class: 'hint' }, '· 记忆 / 总结是**另一层**：小总结、大总结、结构化档案，加上相关性召回 —— 跟上面这两条不是一回事'),
        h(
          'div',
          { class: 'hint' },
          '⚠ 总结**不是每轮自动做的**：上面的「自动总结」开着才会在积压够多时顺手续一条；'
          + '关着就完全不动（那时可以走「工具箱 → 定时任务 → 定时总结」当兜底，但它默认没配）。'
          + '所以**没配任何总结、又把历史窗口调小 = 真的丢**，不会自动兜底。',
        ),
      );
    }
    renderHistory();
    body.append(historyRow);

    if (chat.isGroup) {
      driftHost.append(h('div', { class: 'hint' }, '群聊里这三样是整场共用的：覆盖之后每个成员发言都按这一份算。'));
    }

    openModal({
      title: `对话配置 · ${chat.title}`,
      width: 'min(780px, 94vw)',
      body,
      actions: [
        {
          label: '去写卡区改这张卡',
          onClick: () => {
            if (ctx.navigate) ctx.navigate('writing');
          },
        },
        { label: '知道了', primary: true },
      ],
      onClose: () => renderComposer(), // 覆盖了几项要反映到按钮上
    });

    function flash(node) {
      node.textContent = '已保存';
      setTimeout(() => { node.textContent = ''; }, 1600);
    }
  }

  /**
   * 这一轮的「回复上限 max_tokens」。
   *
   * 以前只有「模型接入 → 采样参数」一个入口，改了不知道有没有生效，被截断也没提示。
   * 这里给一个**对话级**的入口：填了就盖过提供方 / 模型绑定里配的值，留空就跟随它们。
   */
  async function renderLimitSwitch(host) {
    const saved = chat.settings?.params?.max_tokens;
    const input = h('input', {
      type: 'number',
      min: '64',
      max: '65536',
      step: '64',
      value: saved ?? '',
      style: { width: '116px' },
      title: '这个对话最多生成多少 token（中文大约 1 token ≈ 1.4 字）。填了就盖过「模型接入」里的值，留空 = 跟随。',
      onchange: async (event) => {
        const raw = String(event.target.value ?? '').trim();
        try {
          const params = { ...(chat.settings?.params ?? {}) };
          if (raw) params.max_tokens = Math.max(1, Math.round(Number(raw) || 0));
          else delete params.max_tokens;
          chat = await put(`/api/chats/${chat.id}`, { settings: { ...(chat.settings ?? {}), params } });
          toast(params.max_tokens ? `这个对话的回复上限改成 ${params.max_tokens}` : '改回跟随「模型接入」');
          await renderLimitSwitch(host);
        } catch (err) {
          toastError(err);
        }
      },
    });
    const hint = h('span', { class: 'hint' }, saved ? '这个对话专用' : '跟随模型接入…');
    host.replaceChildren(h('span', { class: 'hint' }, '回复上限'), input, hint);

    // 兜底值（提供方 / 绑定里配的）异步查一下，填进 placeholder —— 让人看见"现在到底是多少"
    try {
      const [providerData, bindings] = await Promise.all([get('/api/providers'), get('/api/models/bindings?kind=chat')]);
      const list = bindings.items ?? [];
      const binding =
        list.find((item) => item.scope === 'chat' && item.targetId === chat.id) ??
        list.find((item) => item.scope === 'character' && item.targetId === chat.characterId) ??
        list.find((item) => item.scope === 'default');
      const provider = (providerData.items ?? []).find((item) => item.id === binding?.providerId);
      const fallback = binding?.params?.max_tokens ?? provider?.params?.max_tokens ?? null;
      input.placeholder = fallback ? String(fallback) : '模型默认';
      hint.textContent = saved ? '这个对话专用' : fallback ? `现在用 ${binding?.params?.max_tokens ? '模型绑定' : '提供方'}的 ${fallback}` : '现在用模型默认值';
    } catch {
      // 查不到就只留输入框
    }
  }

  /** 群聊才有的一条：在场成员 + 谁开口 + 加成员（其余功能仍在「玩卡区 → 群聊」）。 */
  async function renderGroupStrip(host) {
    if (!chat?.isGroup) {
      host.replaceChildren();
      return;
    }
    const members = chat.members ?? [];
    let strategies = [];
    try {
      strategies = (await get('/api/group/strategies')).items ?? [];
    } catch {
      // 拿不到就只显示成员
    }
    const current = chat.groupStrategy ?? 'natural';
    const select = h(
      'select',
      {
        title: '这一轮谁开口',
        onchange: async (event) => {
          try {
            chat = await put(`/api/group/${chat.id}/strategy`, { strategy: event.target.value });
            toast(`群聊策略改成「${strategies.find((item) => item.id === event.target.value)?.title ?? event.target.value}」`);
          } catch (err) {
            toastError(err);
            event.target.value = current;
          }
        },
      },
      strategies.map((item) => h('option', { value: item.id, selected: item.id === current }, `${item.title}（${item.summary}）`)),
    );
    host.replaceChildren(
      h('span', { class: 'hint' }, `群聊 ${members.filter((member) => !member.muted).length}/${members.length} 人在场：${members.map((member) => `${member.name}${member.muted ? '（静音）' : ''}`).join('、') || '（还没有成员）'}`),
      strategies.length ? h('span', { class: 'hint' }, '谁开口') : null,
      strategies.length ? select : null,
      h('button', { class: 'btn small', onclick: () => addMemberDialog() }, '＋ 加成员'),
      h('span', { class: 'hint' }, '静音 / 手动点名 / 自动模式在「玩卡区 → 群聊」页'),
    );
  }

  async function addMemberDialog() {
    const cards = await loadLibraryCards();
    if (!cards.length) {
      toast('卡库是空的：先去写卡区导入一张卡');
      return;
    }
    const pick = libraryCardSelect(cards);
    openModal({
      title: '加成员',
      body: h('div', { class: 'field' }, h('label', {}, '从卡库选一张'), pick, h('div', { class: 'hint' }, '同一个角色可以加多次（例如同一张卡的两个时期）。')),
      actions: [
        { label: '取消' },
        {
          label: '加进来',
          primary: true,
          onClick: async () => {
            if (!pick.value) {
              toast('先选一张卡', { tone: 'warn' });
              return false;
            }
            try {
              await post(`/api/group/${chat.id}/members`, { characterId: pick.value });
              await openChat(chat.id);
              toast('成员加好了');
            } catch (err) {
              toastError(err);
              return false;
            }
          },
        },
      ],
    });
  }

  /**
   * 提示词预设：挂上之后这个对话每一轮都用那套预设组装提示词。
   * 换 / 取消只影响之后的轮次，已经生成的内容不动。
   * 预设从「写卡区 → 提示词 → 预设库」导入（酒馆的预设 JSON 直接能用）。
   */
  async function renderPresetSwitch(host) {
    let items = [];
    try {
      items = (await get('/api/prompts/presets')).items ?? [];
    } catch {
      host.replaceChildren();
      return;
    }
    if (!items.length) {
      host.replaceChildren(h('span', { class: 'hint' }, '提示词预设：还没导入过（写卡区 → 提示词 → 预设库）'));
      return;
    }
    const current = chat.settings?.presetId ?? '';
    const mode = chat.settings?.presetParams ?? 'common';
    const select = h(
      'select',
      {
        title: '挂上预设后，这个对话每轮都按它的队列与位置标记组装提示词；留空 = 内置组装',
        onchange: async (event) => {
          const value = event.target.value;
          try {
            const settings = { ...(chat.settings ?? {}) };
            if (value) settings.presetId = value;
            else delete settings.presetId;
            chat = await put(`/api/chats/${chat.id}`, { settings });
            toast(value ? `这个对话改用它组装提示词：${items.find((item) => item.id === value)?.name ?? value}` : '改回内置组装');
            await renderPresetSwitch(host); // 挂上 / 撤掉预设时，"预设自带参数"那一档跟着出现 / 消失
          } catch (err) {
            toastError(err);
            event.target.value = current;
          }
        },
      },
      h('option', { value: '' }, '内置组装（不用预设）'),
      ...items.map((item) => h('option', { value: item.id, selected: item.id === current }, item.name)),
    );
    const nodes = [h('span', { class: 'hint' }, '提示词预设'), select];
    if (current) {
      const modeSelect = h(
        'select',
        {
          title: '预设顶层的采样参数要不要跟着用；这里只影响之后的轮次',
          onchange: async (event) => {
            const value = event.target.value;
            try {
              chat = await put(`/api/chats/${chat.id}`, { settings: { ...(chat.settings ?? {}), presetParams: value } });
              toast(`预设的采样参数：${value === 'off' ? '不用' : value === 'all' ? '全部都用' : '用常用那几个'}`);
            } catch (err) {
              toastError(err);
              event.target.value = mode;
            }
          },
        },
        h('option', { value: 'common', selected: mode === 'common' }, '参数：常用几个'),
        h('option', { value: 'all', selected: mode === 'all' }, '参数：全部（含本地推理专用）'),
        h('option', { value: 'off', selected: mode === 'off' }, '参数：不用预设的'),
      );
      nodes.push(h('span', { class: 'hint' }, '预设自带参数'), modeSelect);
    }
    host.replaceChildren(...nodes);
  }

  /**
   * 多模型热切换：给这个对话绑一个模型（scope = chat），不重开对话、不丢上下文。
   * 记忆与历史挂在对话上，模型只是执行者 —— 换模型不会丢记忆。
   */
  async function renderModelSwitch(host) {
    try {
      const [providerData, bindings] = await Promise.all([get('/api/providers'), get('/api/models/bindings?kind=chat')]);
      const providers = (providerData.items ?? []).filter((item) => item.kind === 'chat' && item.enabled);
      const chatBinding = (bindings.items ?? []).find((item) => item.scope === 'chat' && item.targetId === chat.id);
      if (!providers.length) {
        host.replaceChildren(h('span', { class: 'hint' }, '还没有可用的聊天模型：去「模型接入」加一个。'));
        return;
      }
      const select = h(
        'select',
        {
          title: '换一个模型接着聊，历史与世界书都不变',
          onchange: async (event) => {
            try {
              if (!event.target.value) {
                if (chatBinding) await del(`/api/models/bindings/${chatBinding.id}`);
                toast('已改回跟随角色 / 全局默认');
              } else {
                await put('/api/models/bindings', { scope: 'chat', targetId: chat.id, providerId: event.target.value, kind: 'chat' });
                toast('这个对话的模型已切换，接着聊就行');
              }
            } catch (err) {
              toastError(err);
            }
          },
        },
        [
          h('option', { value: '', selected: !chatBinding }, '跟随绑定（角色 / 全局默认）'),
          ...providers.map((provider) =>
            h('option', { value: provider.id, selected: provider.id === chatBinding?.providerId }, `只用这个对话：${provider.label}`),
          ),
        ],
      );
      host.replaceChildren(h('span', { class: 'panel-note' }, '模型：'), select);
    } catch {
      host.replaceChildren();
    }
  }

  // ---------------------------------------------------------------- 生成

  async function send(text) {
    const trimmed = String(text ?? '').trim();
    if (!trimmed || busy || !activeId) return;
    await runTurn('send', { text: trimmed });
    const input = composerHost.querySelector('textarea');
    if (input) input.value = '';
  }

  async function runTurn(kind, body = {}) {
    if (busy || !activeId) return;
    busy = true;
    const path = kind === 'send' ? `/api/chats/${activeId}/send` : `/api/chats/${activeId}/${kind}`;
    let live = null;
    let buffer = '';
    let lastText = '';
    let notified = false;
    let newMessageId = null;
    try {
      await streamTurn(path, body, {
        onEvent: (event, data) => {
          if (event === 'start') {
            live = appendLive(data.messageId, data.name);
            buffer = '';
            if (data.sourceTitle) ctx.shell?.setSubtitle?.(`${chat.isGroup ? '群聊' : '单聊'} · ${chat.title} · ${data.name} 用 ${data.sourceTitle}`);
          } else if (event === 'delta') {
            buffer += data.text ?? '';
            lastText = buffer;
            if (live) {
              live.textContent = buffer;
              threadHost.scrollTop = threadHost.scrollHeight;
            }
          } else if (event === 'thinking') {
            // 思维链先到、正文还没开始：先提示"思考中"，正文一到就被覆盖
            if (live && !buffer) live.textContent = '思考中…';
          } else if (event === 'tool_start') {
            // 工具调用开始：模型在往工具里写参数，这时还没有正文可以显示。
            if (live) live.textContent = `正在调用工具：${data.name ?? '…'}`;
          } else if (event === 'error') {
            toastError(new Error(data.message ?? '生成失败'));
          } else if (event === 'done' && data.text) {
            lastText = data.text;
            newMessageId = data.messageId ?? newMessageId;
          } else if (event === 'done' && data.pending) {
            toast('手动模式：在群聊页点一个成员，或者用「成员 > 让 TA 说」', { tone: 'warn' });
          }
          if (event === 'done' && !data.pending && !notified) {
            notified = true;
            notifyTurnDone({ title: chat?.title ?? 'Silver Tavern', body: String(lastText ?? '').slice(0, 90) });
          }
        },
      });
    } catch (err) {
      toastError(err);
    } finally {
      busy = false;
    }
    await reload();
    // 一轮结束：告诉卡内界面"回合变了"，卡的 UI 才能重新读变量 / 消息（Tavern.onTurn）
    sandbox.notify('turn', { kind, text: String(lastText ?? '').slice(0, 200) });
    // 开了「思维链自动译中文」：这轮新消息带思维链就顺手翻一条（只改显示，不动原文）
    if (chat?.settings?.translateReasoning && newMessageId) {
      const fresh = messages.find((message) => message.id === newMessageId);
      if (fresh?.extra?.reasoning && !fresh.extra.reasoningZh) await translateReasoning(fresh);
    }
  }

  /** 生成 / 改动之后重拉列表（条数与预览）再重画消息区。 */
  async function reload() {
    if (!activeId) return;
    await refreshList();
    await openChat(activeId);
  }

  /** 再来一版：把新生成的回复追加成这条消息的候选（swipes），不删旧的那版。 */
  async function runSwipe(message) {
    if (busy || !activeId) return;
    busy = true;
    const live = appendLive(message.id, message.name);
    let buffer = '';
    let notified = false;
    try {
      await streamTurn(
        `/api/chats/${activeId}/swipe`,
        { messageId: message.id },
        {
          onEvent: (event, data) => {
            if (event === 'delta') {
              buffer += data.text ?? '';
              if (live) {
                live.textContent = buffer;
                threadHost.scrollTop = threadHost.scrollHeight;
              }
            } else if (event === 'error') {
              toastError(new Error(data.message ?? '生成失败'));
            } else if (event === 'swipe' && !notified) {
              notified = true;
              toast(`已经有 ${data.swipes?.length ?? 0} 个候选版本，用 ◀ ▶ 翻`);
              notifyTurnDone({ title: chat?.title ?? 'Silver Tavern', body: String(buffer ?? '').slice(0, 90) });
            }
          },
        },
      );
    } catch (err) {
      toastError(err);
    } finally {
      busy = false;
    }
    await reload();
  }

  // ---------------------------------------------------------------- 创作辅助（蓝图 3.2）

  /** 把整段对话润色成小说章节：模型走写卡助手的技能机制，结果可复制 / 导出。 */
  async function makeChapter() {
    if (!activeId) return;
    const styles = ['轻小说', '温馨日常', '冷峻悬疑', '古风', '幽默'];
    const styleSelect = h('select', {}, styles.map((style) => h('option', { value: style }, style)));
    const titleInput = h('input', { placeholder: '留空让模型起一个' });
    openModal({
      title: '变成小说章节',
      body: h(
        'div',
        {},
        field('文风', styleSelect),
        field('章节标题', titleInput),
        h('div', { class: 'hint' }, '会把当前对话的正文润色、分段、排版成可以直接读的小说；对话里的信息与人物的口吻都保留。'),
      ),
      actions: [
        { label: t('btn.cancel') },
        {
          label: '开始',
          primary: true,
          onClick: async () => {
            try {
              const result = await post('/api/creative/chat-to-chapter', {
                chatId: activeId,
                style: styleSelect.value,
                title: titleInput.value.trim(),
              });
              openTextOutput({
                title: result.title || '小说章节',
                text: result.text,
                filename: `${result.title || chat?.title || 'chapter'}.md`,
                meta: h('div', { class: 'output-meta' }, `来自 ${result.sourceMessages} 条消息${result.target?.sourceTitle ? ` · 模型：${result.target.sourceTitle}` : ''}`),
              });
            } catch (err) {
              toastError(err);
              return false; // 失败时保留弹窗，方便改完再试
            }
          },
        },
      ],
    });
  }

  /** 从对话里提炼人物 / 地点 / 物品，存成世界书条目。 */
  async function extractEntities() {
    if (!activeId) return;
    try {
      const result = await post('/api/creative/extract-entities', { chatId: activeId });
      const lines = (result.entries ?? []).map((entry) => `## ${entry.comment}\n关键词：${(entry.keys ?? []).join('、')}\n${entry.content}`);
      const saved = result.savedWorldbook;
      openTextOutput({
        title: '抽取到的素材',
        text: lines.join('\n\n') || '（这次没抽到东西）',
        filename: 'entities.md',
        meta: h(
          'div',
          { class: 'output-meta' },
          `人物 ${result.counts?.characters ?? 0} · 地点 ${result.counts?.places ?? 0} · 物品 ${result.counts?.items ?? 0}` +
            (saved ? ` · 已存进世界书《${saved.name}》（${saved.added} 条）` : ''),
        ),
      });
      toast(saved ? `素材已存进《${saved.name}》` : '抽取完成');
    } catch (err) {
      toastError(err);
    }
  }

  async function impersonate(input) {
    if (busy || !activeId) return;
    busy = true;
    try {
      const result = await post(`/api/chats/${activeId}/impersonate`, {});
      input.value = result.text ?? '';
      input.focus();
      toast('草稿已填进输入框，改完再发', { tone: 'info' });
    } catch (err) {
      toastError(err);
    } finally {
      busy = false;
    }
  }

  // ---------------------------------------------------------------- 消息操作

  async function handleAction(action, message) {
    if (!activeId) return;
    try {
      if (action === 'copy') {
        await navigator.clipboard?.writeText(message.content ?? '');
        toast('已复制');
      } else if (action === 'translate-thinking') {
        await translateReasoning(message);
        return; // translateReasoning 自己会 reload
      } else if (action === 'edit') {
        // 思维链默认折在消息里；点编辑的时候也给一份（只读），不然改完就看不到了
        const thinkingText = String(message.extra?.reasoning ?? '').trim();
        const thinkingZh = String(message.extra?.reasoningZh ?? '').trim();
        const value = await textPrompt({
          title: '编辑这条消息',
          value: message.content,
          extra: thinkingText
            ? h(
                'details',
                { class: 'msg-thinking', style: { marginTop: '10px' } },
                h('summary', {}, `这条的思考过程（${thinkingText.length} 字，只读；不进上下文${thinkingZh ? ' · 有中文译文' : ''}）`),
                thinkingZh ? h('div', { class: 'msg-thinking-zh' }, thinkingZh) : null,
                h('div', { style: { whiteSpace: 'pre-wrap', opacity: '0.75', marginTop: '4px', maxHeight: '260px', overflow: 'auto' } }, thinkingText),
              )
            : null,
        });
        if (value !== null) await put(`/api/chats/${activeId}/messages/${message.id}`, { content: value });
      } else if (action === 'insert') {
        const value = await textPrompt({ title: '在这条之后插入一条', label: '插入的内容（会当成用户消息）' });
        if (value !== null) await post(`/api/chats/${activeId}/messages`, { afterMessageId: message.id, role: 'user', content: value });
      } else if (action === 'delete') {
        await del(`/api/chats/${activeId}/messages/${message.id}`);
      } else if (action === 'system') {
        await put(`/api/chats/${activeId}/messages/${message.id}`, { isSystem: !message.isSystem });
      } else if (action === 'hide') {
        await put(`/api/chats/${activeId}/messages/${message.id}`, { hidden: !message.hidden });
      } else if (action === 'bookmark') {
        const label = await textPrompt({ title: '给这条消息打个书签', label: '名字', value: '', placeholder: '例如：名场面' });
        if (label === null || label === undefined) return;
        await post('/api/studio/bookmarks', { chatId: activeId, messageId: message.id, label: String(label) });
        toast('已加书签（在「工坊 → 书签」里能看全部）');
        return;
      } else if (action === 'swipe-prev' || action === 'swipe-next') {
        await put(`/api/chats/${activeId}/messages/${message.id}/swipe`, { delta: action === 'swipe-prev' ? -1 : 1 });
      } else if (action === 'new-swipe') {
        await runSwipe(message);
        return;
      } else if (action === 'regenerate' || action === 'continue') {
        await runTurn(action, action === 'regenerate' ? { messageId: message.id } : {});
        return;
      }
      await reload();
    } catch (err) {
      toastError(err);
    }
  }

  // ---------------------------------------------------------------- 行动选项

  async function refreshOptions({ generate = false } = {}) {
    if (!activeId) return;
    try {
      const data = generate
        ? await post(`/api/narration/${activeId}/options`, { count: 4 })
        : await get(`/api/narration/${activeId}/latest`);
      const items = data.items ?? data.options ?? [];
      if (!items.length) {
        optionsHost.replaceChildren();
        return;
      }
      optionsHost.replaceChildren(
        h('span', { class: 'panel-note' }, '候选行动：'),
        ...items.map((option) => h('button', { class: 'btn option-btn', onclick: () => send(option.text) }, option.text)),
      );
    } catch {
      optionsHost.replaceChildren();
    }
  }

  // ---------------------------------------------------------------- 新建 / 导入 / 导出

  async function createChatDialog() {
    const cards = await loadLibraryCards();
    const make = (label, placeholder, value = '') => h('input', { placeholder, value });
    const title = make('标题', '例如：雨夜的酒馆');
    const name = make('角色名', '例如：阿狸');
    const cardDesc = h('textarea', { rows: 4, placeholder: '角色设定（简介 / 性格 / 场景都可以写这里）' });
    const greeting = h('textarea', { rows: 3, placeholder: '开场白（可留空）' });
    const userName = make('我的名字', 'User');
    const groupMode = h('input', { type: 'checkbox' });
    const pick = libraryCardSelect(cards, {
      onPick: (card) => {
        if (!card) return;
        name.value = card.name;
        cardDesc.value = card.data?.description ?? '';
        greeting.value = card.data?.first_mes ?? '';
        if (!title.value.trim()) title.value = `${card.name} 的对话`;
      },
    });
    // 多选 = 直接开一场多人的（≥2 张就走群聊）。选中的卡各自带自己的开场白。
    const multi = h(
      'select',
      { multiple: true, size: '6', style: { minWidth: '220px' } },
      cards.map((card) => h('option', { value: card.id }, card.favorite ? `★ ${card.name}` : card.name)),
    );
    const pickedMembers = () => (multi.selectedOptions ? [...multi.selectedOptions].map((option) => option.value) : []);

    openModal({
      title: '新建对话',
      body: h(
        'div',
        {},
        h('div', { class: 'field' }, h('label', {}, '从卡库选一张'), pick),
        h(
          'div',
          { class: 'field' },
          h('label', {}, '或者多选几张（选 2 张以上 = 直接建群聊）'),
          multi,
          h('div', { class: 'hint' }, '按住 Ctrl / Shift 点选。多选时下面"角色名 / 设定 / 开场白"不生效 —— 每张卡用自己卡里的内容。'),
        ),
        h('div', { class: 'field' }, h('label', {}, '标题'), title),
        h('div', { class: 'field' }, h('label', {}, '角色名'), name),
        h('div', { class: 'field' }, h('label', {}, '角色设定'), cardDesc),
        h('div', { class: 'field' }, h('label', {}, '开场白'), greeting),
        h('div', { class: 'field' }, h('label', {}, '我的名字'), userName),
        h('label', { class: 'switch-row' }, groupMode, h('span', {}, '建一个群聊（建好后也能在输入框上方「＋ 加成员」）')),
        h('div', { class: 'hint' }, cards.length
          ? '选卡库里的卡会连简介与开场白一起带进来（开场白会变成第一条消息）；不选就手动填一张临时卡。'
          : '卡库还是空的：先去写卡区导入一张卡，或者在这里手动填一张临时卡开演。'),
      ),
      actions: [
        { label: '取消' },
        {
          label: '创建',
          primary: true,
          onClick: async () => {
            try {
              const base = {
                title: title.value.trim(),
                persona: { name: userName.value.trim() || 'User' },
                isGroup: groupMode.checked,
                greetings: true,
              };
              const chosen = pickedMembers();
              const created = await post('/api/chats', chosen.length >= 2
                ? { ...base, isGroup: true, members: chosen.map((characterId) => ({ characterId })) }
                : pick.value
                  ? { ...base, characterId: pick.value }
                  : { ...base, character: { name: name.value.trim() || '角色', description: cardDesc.value, first_mes: greeting.value } });
              await refreshList();
              await openChat(created.id);
              toast(chosen.length >= 2 ? `群聊建好了（${chosen.length} 人）` : '对话建好了');
            } catch (err) {
              toastError(err);
              return false;
            }
          },
        },
      ],
    });
  }

  async function importFile(file) {
    if (!file) return;
    try {
      const text = await file.text();
      const created = await post('/api/chats/import', { text });
      await refreshList();
      await openChat(created.id);
      toast(`导入了 ${created.messageCount} 条消息`);
    } catch (err) {
      toastError(err);
    }
  }

  async function exportChat() {
    if (!activeId) return;
    try {
      const text = await get(`/api/chats/${activeId}/export?format=jsonl`);
      const blob = new Blob([typeof text === 'string' ? text : JSON.stringify(text)], { type: 'application/x-ndjson' });
      const url = URL.createObjectURL(blob);
      const a = h('a', { href: url, download: `${chat?.title ?? 'chat'}.jsonl` });
      document.body.append(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      toastError(err);
    }
  }

  async function mount() {
    registerShortcuts();
    await refreshList();
    // 从别的地方跳过来时：`#/chat/<id>` 是"打开这个对话"，
    // 叙事控制的「跳到这条」给的是 `chatId:messageId`（多一段要高亮的消息 id）。
    const raw = String(ctx?.viewKey ?? '');
    const [targetChatId, targetMessageId] = raw.includes(':') ? raw.split(':') : [raw || null, null];
    if (targetChatId && chats.some((item) => item.id === targetChatId)) {
      if (targetMessageId) pendingHighlight = targetMessageId; // renderThread 会滚过去并高亮
      await openChat(targetChatId);
      return;
    }
    if (chats.length) await openChat(chats[0].id);
    else openChat(null);
  }

  /** 切到列表里的下一个对话（设置里的"切换角色"快捷键）。 */
  function cycleChat() {
    if (!chats.length) return;
    const index = chats.findIndex((item) => item.id === activeId);
    const next = chats[(index + 1) % chats.length] ?? chats[0];
    if (next && next.id !== activeId) openChat(next.id);
  }

  /**
   * 把设置里的快捷键接到这张视图上。视图被换掉之后（el 不再挂在文档里）
   * 处理器直接放行，免得在别的页面上按到聊天快捷键。
   */
  function registerShortcuts() {
    if (!shortcuts) return;
    const bind = (action, handler) => {
      const combo = getSetting(`ui.shortcut.${action}`, '');
      shortcuts.register(`chat.${action}`, combo, (event) => {
        if (el.isConnected === false || !activeId || busy) return false;
        handler(event);
        return true;
      });
    };
    bind('continue', () => runTurn('continue'));
    bind('regenerate', () => runTurn('regenerate'));
    bind('switchCharacter', () => cycleChat());
    bind('search', () => searchInput.focus?.());
  }

  return { el, mount };
}
