/**
 * 玩卡区 · 场景状态。
 *
 * 属性 / 好感度 / 任务 / 物品 / 地点 / 时间，AI 每轮会输出结构化改动，这里也能手改。
 * 还有骰子与状态快照（玩崩了能倒回来）。
 */

import { h, statusChip } from '../core/dom.mjs';
import { get, post, put, del } from '../core/api.mjs';
import { panel, emptyState, errorBox, loading } from '../ui/components.mjs';
import { toast, toastError } from '../ui/toast.mjs';
import { fetchChats, kvEditor } from './playing-common.mjs';

export function createStateView(module) {
  const el = h('div', { class: 'view' });
  const body = h('div', {});
  let chats = [];
  let chatId = null;
  let snapshot = null;
  let members = [];

  el.append(
    panel(
      module.title,
      null,
      h('div', { class: 'panel-note' }, module.summary),
      h('div', { style: { marginTop: '12px' } }, statusChip(module.status)),
    ),
    body,
  );

  async function refresh(preferred) {
    try {
      chats = await fetchChats();
    } catch (err) {
      body.replaceChildren(panel('场景状态', null, errorBox(err, { onRetry: () => refresh() })));
      return;
    }
    if (!chats.length) {
      body.replaceChildren(panel('场景状态', null, emptyState({ icon: '📊', title: '还没有对话', desc: '先去「对话」建一个，再回来改状态。' })));
      return;
    }
    await select(preferred ?? chatId ?? chats[0].id);
  }

  async function select(id) {
    chatId = id;
    body.replaceChildren(loading());
    try {
      const [state, chat] = await Promise.all([get(`/api/state/${id}`), get(`/api/chats/${id}`)]);
      snapshot = state;
      members = chat?.members ?? [];
    } catch (err) {
      body.replaceChildren(panel('场景状态', null, errorBox(err, { onRetry: () => refresh() })));
      return;
    }
    render();
  }

  async function save(patch) {
    try {
      snapshot = await put(`/api/state/${chatId}`, patch);
      render();
    } catch (err) {
      toastError(err);
    }
  }

  function mapPanel(id, title, summary, key) {
    const value = snapshot.worldState[key] ?? {};
    return panel(
      title,
      summary,
      kvEditor(value, {
        onChange: (action, itemKey, itemValue) => {
          const next = { ...value };
          if (action === 'remove') delete next[itemKey];
          else next[itemKey] = itemValue;
          save({ worldState: { ...snapshot.worldState, [key]: next } });
        },
      }),
    );
  }

  function listPanel(id, title, summary, key, columns) {
    const items = snapshot.worldState[key] ?? [];
    const rows = items.map((item, index) =>
      h(
        'div',
        { class: 'kv-row' },
        ...columns.map((column) => {
          const cell = column(item, index, items);
          return typeof cell === 'string' || typeof cell === 'number' ? h('span', {}, String(cell)) : cell;
        }),
        h(
          'button',
          {
            class: 'link-btn',
            onclick: () => {
              const next = items.filter((_entry, i) => i !== index);
              save({ worldState: { ...snapshot.worldState, [key]: next } });
            },
          },
          '删',
        ),
      ),
    );
    const titleInput = h('input', { placeholder: '名称' });
    const noteInput = h('input', { placeholder: '备注（可空）' });
    rows.push(
      h(
        'div',
        { class: 'kv-row' },
        titleInput,
        noteInput,
        h(
          'button',
          {
            class: 'btn',
            onclick: () => {
              const name = titleInput.value.trim();
              if (!name) return;
              const entry = key === 'items' ? { name, qty: 1, note: noteInput.value } : { title: name, status: 'active', note: noteInput.value };
              save({ worldState: { ...snapshot.worldState, [key]: [...items, entry] } });
            },
          },
          '加',
        ),
      ),
    );
    return panel(title, summary, h('div', { class: 'list-editor' }, rows));
  }

  function questStatus(item, index, items) {
    return h(
      'select',
      {
        onchange: (event) => {
          const next = items.map((entry, i) => (i === index ? { ...entry, status: event.target.value } : entry));
          save({ worldState: { ...snapshot.worldState, quests: next } });
        },
      },
      [
        ['active', '进行中'],
        ['done', '已完成'],
        ['failed', '已失败'],
      ].map(([value, label]) => h('option', { value, selected: (item.status ?? 'active') === value }, label)),
    );
  }

  function render() {
    const picker = h(
      'select',
      { onchange: (event) => select(event.target.value) },
      chats.map((item) => h('option', { value: item.id, selected: item.id === chatId }, `${item.isGroup ? '👥 ' : '💬 '}${item.title}`)),
    );
    const ws = snapshot.worldState;

    const placeInput = h('input', { value: ws.place ?? '', placeholder: '现在在哪' });
    const timeInput = h('input', { value: ws.time ?? '', placeholder: '现在什么时候' });
    const diceInput = h('input', { value: '1d20', placeholder: '2d6+3' });
    const diceResult = h('div', { class: 'panel-note' }, '');

    const varRows = (snapshot.variables ?? []).map((item) =>
      h(
        'div',
        { class: 'kv-row' },
        h('span', { class: 'chip stub' }, item.scope === 'character' ? '角色' : '对话'),
        h('span', { class: 'mono' }, item.key),
        h('span', {}, String(item.value)),
        h(
          'button',
          { class: 'link-btn', onclick: () => save({ deleteVariables: [{ key: item.key, scope: item.scope, characterId: item.characterId }] }) },
          '删',
        ),
      ),
    );
    const varKey = h('input', { placeholder: '键' });
    const varValue = h('input', { placeholder: '值' });
    // 变量的作用域：挂在对话上（所有角色共享）还是挂在某个角色上。
    const varScope = h(
      'select',
      {},
      h('option', { value: 'chat' }, '对话'),
      h('option', { value: 'character' }, '角色'),
    );
    // 角色变量按"角色卡 id"存在 chat_variables.character_id 里（见 core/chat/service.mjs 的变量映射），
    // 所以这里只能列出绑定过角色卡的成员；临时贴卡的成员没有 id，做不了角色变量。
    const cardMembers = members.filter((member) => member.characterId);
    const varCharacter = h(
      'select',
      {},
      cardMembers.length
        ? cardMembers.map((member) => h('option', { value: member.characterId }, member.name || member.card?.name || member.characterId))
        : h('option', { value: '' }, '（没有绑定角色卡的成员）'),
    );
    varCharacter.disabled = true;
    varScope.addEventListener('change', () => {
      varCharacter.disabled = varScope.value !== 'character';
    });
    varRows.push(
      h(
        'div',
        { class: 'kv-row' },
        varKey,
        varValue,
        varScope,
        varCharacter,
        h(
          'button',
          {
            class: 'btn',
            onclick: () => {
              const key = varKey.value.trim();
              if (!key) return;
              if (varScope.value === 'character' && !varCharacter.value) {
                toast('这个对话还没有成员，建不了角色变量', { tone: 'warn' });
                return;
              }
              save({
                variables: [
                  {
                    scope: varScope.value,
                    characterId: varScope.value === 'character' ? varCharacter.value : '',
                    key,
                    value: varValue.value,
                  },
                ],
              });
            },
          },
          '加',
        ),
      ),
    );

    body.replaceChildren(
      panel(
        '选一个对话',
        '状态挂在对话上，与模型无关',
        h('div', { class: 'field' }, h('label', {}, '对话'), picker),
        h(
          'div',
          { class: 'grid' },
          h('div', { class: 'field' }, h('label', {}, '地点'), placeInput),
          h('div', { class: 'field' }, h('label', {}, '时间'), timeInput),
        ),
        h(
          'div',
          { style: { display: 'flex', gap: '8px' } },
          h('button', { class: 'btn primary', onclick: () => save({ worldState: { ...ws, place: placeInput.value, time: timeInput.value } }) }, '保存地点 / 时间'),
          h('button', { class: 'btn', onclick: () => save({ worldState: { ...ws, attributes: {}, affection: {}, quests: [], items: [], place: '', time: '' } }) }, '清空状态'),
        ),
      ),
      h(
        'div',
        { class: 'grid' },
        mapPanel('attributes', '属性', '数值给增量就加减', 'attributes'),
        mapPanel('affection', '好感度', '按角色名记', 'affection'),
      ),
      h(
        'div',
        { class: 'grid' },
        listPanel('quests', '任务', null, 'quests', [(item) => item.title ?? item.name, (item, index, items) => questStatus(item, index, items)]),
        listPanel('items', '物品', null, 'items', [(item) => item.name, (item) => `×${item.qty ?? 1}`]),
      ),
      panel(
        '骰子',
        '结果会作为一条旁白消息写进对话',
        h(
          'div',
          { class: 'kv-row' },
          diceInput,
          h(
            'button',
            {
              class: 'btn',
              onclick: async () => {
                try {
                  const result = await post(`/api/state/${chatId}/roll`, { expr: diceInput.value });
                  diceResult.textContent = result.detail;
                  toast(result.detail);
                } catch (err) {
                  toastError(err);
                }
              },
            },
            '掷',
          ),
        ),
        diceResult,
      ),
      panel('变量', '对话变量（本局）写在宏 {{getvar::键}} 里可用', h('div', { class: 'list-editor' }, varRows)),
      panel(
        '快照',
        '玩崩了能倒回来',
        h(
          'div',
          { style: { display: 'flex', gap: '8px', marginBottom: '10px' } },
          h(
            'button',
            {
              class: 'btn',
              onclick: async () => {
                try {
                  await post(`/api/state/${chatId}/snapshots`, { label: `手动快照 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}` });
                  await select(chatId);
                  toast('快照已保存');
                } catch (err) {
                  toastError(err);
                }
              },
            },
            '＋ 保存快照',
          ),
        ),
        h(
          'div',
          { class: 'list-editor' },
          (snapshot.snapshots ?? []).map((item) =>
            h(
              'div',
              { class: 'kv-row' },
              h('span', {}, item.label),
              h('span', { class: 'hint' }, new Date(item.createdAt).toLocaleString('zh-CN', { hour12: false })),
              h(
                'button',
                {
                  class: 'link-btn',
                  onclick: async () => {
                    try {
                      snapshot = await post(`/api/state/${chatId}/snapshots/${item.id}/restore`, {});
                      render();
                      toast('已回滚');
                    } catch (err) {
                      toastError(err);
                    }
                  },
                },
                '回滚',
              ),
              h(
                'button',
                {
                  class: 'link-btn',
                  onclick: async () => {
                    await del(`/api/state/${chatId}/snapshots/${item.id}`);
                    await select(chatId);
                  },
                },
                '删',
              ),
            ),
          ),
          (snapshot.snapshots ?? []).length ? null : h('div', { class: 'hint' }, '还没有快照。'),
        ),
      ),
    );
  }

  async function mount() {
    await refresh();
  }

  return { el, mount };
}
