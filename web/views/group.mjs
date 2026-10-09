/**
 * 玩卡区 · 群聊。
 *
 * 一个群聊里放多个角色，选说话策略（自然 / 列表 / 手动 / 混合），调每个角色的
 * 活跃度与静音，看这一轮谁会开口、他用哪个模型；开着自动模式就能挂着看戏。
 */

import { h, statusChip } from '../core/dom.mjs';
import { get, post, put, del } from '../core/api.mjs';
import { panel, emptyState, errorBox, loading } from '../ui/components.mjs';
import { openModal } from '../ui/modal.mjs';
import { toast, toastError } from '../ui/toast.mjs';
import { fetchChats, libraryCardSelect, loadLibraryCards, streamTurn } from './playing-common.mjs';

export function createGroupView(module, ctx) {
  const el = h('div', { class: 'view' });
  const body = h('div', {});
  let groups = [];
  let chat = null;
  let plan = null;
  let autoTimer = null;

  el.append(
    panel(
      module.title,
      null,
      h('div', { class: 'panel-note' }, module.summary),
      h(
        'div',
        { style: { marginTop: '12px', display: 'flex', gap: '8px', alignItems: 'center' } },
        statusChip(module.status),
        h('button', { class: 'btn primary', onclick: () => createGroupDialog() }, '＋ 新建群聊'),
      ),
    ),
    body,
  );

  async function refresh(preferred) {
    try {
      groups = await fetchChats({ group: true });
    } catch (err) {
      body.replaceChildren(panel('群聊', null, errorBox(err, { onRetry: () => refresh() })));
      return;
    }
    const target = preferred ?? chat?.id ?? groups[0]?.id ?? null;
    if (!target) {
      body.replaceChildren(panel('群聊', null, emptyState({ icon: '👥', title: '还没有群聊', desc: '建一个，然后把角色加进去。' })));
      return;
    }
    await select(target);
  }

  async function select(id) {
    body.replaceChildren(loading());
    try {
      chat = await get(`/api/group/${id}`);
      plan = await get(`/api/group/${id}/next`);
    } catch (err) {
      body.replaceChildren(panel('群聊', null, errorBox(err, { onRetry: () => refresh() })));
      return;
    }
    render();
  }

  function strategySelect() {
    return h(
      'select',
      {
        onchange: (event) => saveStrategy({ strategy: event.target.value }),
      },
      (plan?.strategies ?? []).map((item) => h('option', { value: item.id, selected: item.id === chat.groupStrategy, title: item.summary }, `${item.title} —— ${item.summary}`)),
    );
  }

  function modeSelect() {
    return h(
      'select',
      { onchange: (event) => saveStrategy({ mode: event.target.value }) },
      (plan?.modes ?? []).map((item) => h('option', { value: item.id, selected: item.id === chat.groupMode, title: item.summary }, `${item.title} —— ${item.summary}`)),
    );
  }

  async function saveStrategy(patch) {
    try {
      chat = await put(`/api/group/${chat.id}/strategy`, patch);
      plan = await get(`/api/group/${chat.id}/next`);
      render();
    } catch (err) {
      toastError(err);
    }
  }

  function memberRow(member) {
    const slider = h('input', {
      type: 'range',
      min: '0',
      max: '1',
      step: '0.05',
      value: String(member.talkativeness),
      onchange: async (event) => {
        try {
          await put(`/api/group/members/${member.id}`, { talkativeness: Number(event.target.value) });
          await select(chat.id);
        } catch (err) {
          toastError(err);
        }
      },
    });
    return h(
      'div',
      { class: `member-row${member.muted ? ' muted' : ''}` },
      h(
        'div',
        { class: 'member-head' },
        h('strong', {}, member.name),
        member.characterId ? h('span', { class: 'mono' }, member.characterId) : null,
        h('label', { class: 'switch-row' }, h('input', { type: 'checkbox', checked: member.muted, onchange: (event) => toggleMute(member, event.target.checked) }), h('span', {}, '静音')),
        h('button', { class: 'link-btn', onclick: () => speakAs(member) }, '让 TA 说'),
        h('button', { class: 'link-btn', onclick: () => removeMember(member) }, '移除'),
      ),
      h('div', { class: 'member-talk' }, h('span', { class: 'hint' }, `活跃度 ${Number(member.talkativeness).toFixed(2)}`), slider),
      member.card?.description ? h('div', { class: 'hint' }, member.card.description) : null,
    );
  }

  async function toggleMute(member, muted) {
    try {
      await put(`/api/group/members/${member.id}`, { muted });
      await select(chat.id);
    } catch (err) {
      toastError(err);
    }
  }

  async function removeMember(member) {
    try {
      await del(`/api/group/members/${member.id}`);
      await select(chat.id);
    } catch (err) {
      toastError(err);
    }
  }

  async function speakAs(member) {
    try {
      await streamTurn(`/api/chats/${chat.id}/send`, { text: '', memberId: member.id });
      await select(chat.id);
      toast(`${member.name} 说了一句`);
    } catch (err) {
      toastError(err);
    }
  }

  function autoToggle() {
    const box = h('input', { type: 'checkbox', checked: Boolean(autoTimer) });
    box.addEventListener('change', () => {
      if (box.checked) startAuto();
      else stopAuto();
    });
    return h('label', { class: 'switch-row' }, box, h('span', {}, `自动模式（每 ${chat.autoModeDelay ?? 5} 秒让下一个人说话）`));
  }

  function startAuto() {
    stopAuto();
    const delay = Math.max(1, chat.autoModeDelay ?? 5) * 1000;
    autoTimer = setInterval(async () => {
      try {
        const events = await streamTurn(`/api/chats/${chat.id}/send`, { text: '' });
        if (events.some((event) => event.event === 'start')) await select(chat.id);
        else stopAuto();
      } catch (err) {
        stopAuto();
        toastError(err);
      }
    }, delay);
    toast(`自动模式已开，每 ${chat.autoModeDelay ?? 5} 秒一句`);
  }

  function stopAuto() {
    if (autoTimer) clearInterval(autoTimer);
    autoTimer = null;
  }

  function render() {
    const groupPicker = h(
      'select',
      { onchange: (event) => select(event.target.value) },
      groups.map((item) => h('option', { value: item.id, selected: item.id === chat.id }, item.title)),
    );

    const order = (plan?.order ?? []).map((memberId) => chat.members.find((member) => member.id === memberId)?.name).filter(Boolean);

    body.replaceChildren(
      panel(
        '群聊设置',
        `${chat.members.length} 个成员`,
        h('div', { class: 'field' }, h('label', {}, '选择群聊'), groupPicker),
        h('div', { class: 'field' }, h('label', {}, '说话策略'), strategySelect()),
        h('div', { class: 'field' }, h('label', {}, '提示词模式'), modeSelect()),
        h(
          'div',
          { class: 'field' },
          h('label', {}, '自动模式'),
          autoToggle(),
          h('div', { class: 'hint' }, '自动模式会按上面的间隔连续让角色说话，适合挂机看戏。'),
        ),
        h(
          'div',
          { class: 'panel-note' },
          order.length ? `这一轮预计开口：${order.join(' → ')}` : '这一轮没人自动开口（手动策略：由你点名）',
        ),
        plan?.multiModel ? h('div', { class: 'chip ready' }, '多模型协同已生效：每个成员各用各的模型') : null,
      ),
      panel(
        '成员',
        null,
        h('button', { class: 'btn', onclick: () => addMemberDialog() }, '＋ 加成员'),
        h('div', { style: { marginTop: '12px', display: 'grid', gap: '10px' } }, chat.members.map(memberRow)),
        h('div', { class: 'hint', style: { marginTop: '10px' } }, '活跃度是"每次轮到它时开口的概率"（0~1），与酒馆 group-chats.js 的 talkativeness 一致。'),
      ),
      panel(
        '模型分工',
        '记忆挂在对话上，与模型无关',
        h(
          'table',
          { class: 'data' },
          h('thead', {}, h('tr', {}, ['成员', '模型来源', '提供方', '模型'].map((title) => h('th', {}, title)))),
          h(
            'tbody',
            {},
            (plan?.items ?? []).map((item) =>
              h('tr', {}, [
                item.name,
                item.sourceTitle,
                h('span', { class: 'mono' }, item.providerId ?? '未绑定'),
                item.model ?? '（提供方默认）',
              ]),
            ),
          ),
        ),
      ),
    );
    void ctx;
  }

  async function addMemberDialog() {
    const cards = await loadLibraryCards();
    const name = h('input', { placeholder: '角色名' });
    const desc = h('textarea', { rows: 4, placeholder: '角色设定' });
    const talk = h('input', { type: 'number', min: '0', max: '1', step: '0.05', value: '0.5' });
    const pick = libraryCardSelect(cards, {
      onPick: (card) => {
        if (!card) return;
        name.value = card.name;
        desc.value = card.data?.description ?? '';
      },
    });
    openModal({
      title: '加一个成员',
      body: h(
        'div',
        {},
        h('div', { class: 'field' }, h('label', {}, '从卡库选一张'), pick),
        h('div', { class: 'field' }, h('label', {}, '名字'), name),
        h('div', { class: 'field' }, h('label', {}, '设定'), desc),
        h('div', { class: 'field' }, h('label', {}, '活跃度（0~1）'), talk),
      ),
      actions: [
        { label: '取消' },
        {
          label: '加入',
          primary: true,
          onClick: async () => {
            try {
              await post(`/api/group/${chat.id}/members`, pick.value
                ? { characterId: pick.value, talkativeness: Number(talk.value) || 0.5 }
                : { name: name.value.trim() || '新成员', card: { name: name.value.trim() || '新成员', description: desc.value }, talkativeness: Number(talk.value) || 0.5 });
              await select(chat.id);
            } catch (err) {
              toastError(err);
              return false;
            }
          },
        },
      ],
    });
  }

  async function createGroupDialog() {
    const cards = await loadLibraryCards();
    const title = h('input', { placeholder: '群聊名字' });
    const aName = h('input', { placeholder: '角色 A 名字' });
    const aDesc = h('textarea', { rows: 3, placeholder: '角色 A 设定' });
    const bName = h('input', { placeholder: '角色 B 名字' });
    const bDesc = h('textarea', { rows: 3, placeholder: '角色 B 设定' });
    const aPick = libraryCardSelect(cards, { noneLabel: '手动填角色 A', onPick: (card) => { if (card) { aName.value = card.name; aDesc.value = card.data?.description ?? ''; } } });
    const bPick = libraryCardSelect(cards, { noneLabel: '手动填角色 B', onPick: (card) => { if (card) { bName.value = card.name; bDesc.value = card.data?.description ?? ''; } } });
    openModal({
      title: '新建群聊',
      body: h(
        'div',
        {},
        h('div', { class: 'field' }, h('label', {}, '群聊名字'), title),
        h('div', { class: 'grid-2' }, h('div', { class: 'field' }, h('label', {}, '角色 A 来源'), aPick), h('div', { class: 'field' }, h('label', {}, '角色 B 来源'), bPick)),
        h('div', { class: 'field' }, h('label', {}, '角色 A'), aName, aDesc),
        h('div', { class: 'field' }, h('label', {}, '角色 B'), bName, bDesc),
        h('div', { class: 'hint' }, cards.length ? '可以直接从卡库各挑一张；也能手动填。建好之后还能继续加。' : '卡库是空的，手动填两个角色吧；建好之后还能继续加。'),
      ),
      actions: [
        { label: '取消' },
        {
          label: '创建',
          primary: true,
          onClick: async () => {
            try {
              const created = await post('/api/chats', {
                title: title.value.trim() || '新群聊',
                isGroup: true,
                greetings: false,
                groupStrategy: 'natural',
                groupMode: 'append',
                members: [
                  aPick.value
                    ? { characterId: aPick.value }
                    : { name: aName.value.trim() || '角色 A', card: { name: aName.value.trim() || '角色 A', description: aDesc.value } },
                  bPick.value
                    ? { characterId: bPick.value }
                    : { name: bName.value.trim() || '角色 B', card: { name: bName.value.trim() || '角色 B', description: bDesc.value } },
                ],
              });
              await refresh(created.id);
            } catch (err) {
              toastError(err);
              return false;
            }
          },
        },
      ],
    });
  }

  async function mount() {
    await refresh();
  }

  return { el, mount };
}
