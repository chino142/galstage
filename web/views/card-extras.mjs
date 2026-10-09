/**
 * 卡编辑器的加分项面板（蓝图 1.10）：
 *   剧本大纲、卡内 BGM / 音效清单、角色关系图、一致性锁定。
 *
 * 数据都存进卡数据的 `data.extensions['silver-tavern']`（跟着卡导出走），
 * 读写走 `/api/characters/:id/extras`。
 */

import { h } from '../core/dom.mjs';
import { get, put } from '../core/api.mjs';
import { panel, field, emptyState, loading } from '../ui/components.mjs';
import { toast, toastError } from '../ui/toast.mjs';

const EMPTY = { outline: { logline: '', chapters: [] }, audio: { bgm: [], sfx: [] }, relations: [], locks: [] };

export function createCardExtrasPanel(card) {
  const host = h('div', {});
  const state = { extras: null, audioAssets: [], lockable: [], error: null };

  async function load() {
    host.replaceChildren(loading());
    try {
      const [extras, assets] = await Promise.all([
        get(`/api/characters/${card.id}/extras`),
        get('/api/assets?kind=audio&limit=200').catch(() => ({ items: [] })),
      ]);
      state.extras = extras.extras ?? EMPTY;
      state.lockable = extras.lockableFields ?? [];
      state.audioAssets = assets.items ?? [];
    } catch (err) {
      state.error = err;
      state.extras = EMPTY;
    }
    render();
  }

  async function save(patch, message = '已保存') {
    try {
      const result = await put(`/api/characters/${card.id}/extras`, patch);
      state.extras = result.extras ?? state.extras;
      state.lockable = result.lockableFields ?? state.lockable;
      render();
      toast(message);
    } catch (err) {
      toastError(err);
    }
  }

  function audioOptions(selected = '') {
    return [
      h('option', { value: '' }, state.audioAssets.length ? '选一段音频…' : '（还没有音频素材）'),
      ...state.audioAssets.map((asset) => h('option', { value: asset.id, selected: asset.id === selected }, asset.name ?? asset.id)),
    ];
  }

  function audioName(assetId) {
    return state.audioAssets.find((asset) => asset.id === assetId)?.name ?? assetId;
  }

  function outlineBlock() {
    const outline = state.extras.outline ?? EMPTY.outline;
    const logline = h('input', { type: 'text', placeholder: '一句话故事梗概，比如：雪夜里，书生与狐妖在旧书馆相遇。' });
    logline.value = outline.logline ?? '';
    const rows = [];
    const list = h('div', {});
    const draw = () => {
      list.replaceChildren(
        ...(rows.length
          ? rows.map((row, index) =>
              h(
                'div',
                { style: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '6px' } },
                h('span', { class: 'hint', style: { width: '30px' } }, `#${index + 1}`),
                h('div', { style: { flex: '1' } }, row.title),
                h('div', { style: { flex: '2' } }, row.summary),
                h('button', { class: 'link-btn', onclick: () => { rows.splice(index, 1); draw(); } }, '删'),
              ),
            )
          : [h('div', { class: 'panel-note' }, '还没有章节梗概，点下面加一章。')]),
      );
    };
    for (const chapter of outline.chapters ?? []) {
      rows.push({ title: textInput(chapter.title, '章节名'), summary: textInput(chapter.summary, '这一章发生什么') });
    }
    draw();
    return h(
      'div',
      { style: { marginBottom: '16px' } },
      h('div', { class: 'tile-title' }, '剧本大纲', h('span', { class: 'chip partial' }, `${(outline.chapters ?? []).length} 章`)),
      field('一句话梗概', logline),
      h('div', { class: 'hint', style: { marginTop: '8px' } }, '分章梗概（长线剧情有规划，而不是走一步算一步）'),
      list,
      h('div', { style: { display: 'flex', gap: '8px', marginTop: '6px' } },
        h('button', { class: 'btn', onclick: () => { rows.push({ title: textInput('', '章节名'), summary: textInput('', '这一章发生什么') }); draw(); } }, '＋ 加一章'),
        h('button', {
          class: 'btn primary',
          onclick: () => save({ outline: { logline: logline.value, chapters: rows.map((row) => ({ title: row.title.value, summary: row.summary.value })) } }, '大纲已保存'),
        }, '保存大纲'),
      ),
    );
  }

  function textInput(value, placeholder) {
    const input = h('input', { type: 'text', placeholder });
    input.value = value ?? '';
    return input;
  }

  function relationsBlock() {
    const rows = (state.extras.relations ?? []).map((relation) => ({
      from: textInput(relation.from, '角色 A'),
      to: textInput(relation.to, '角色 B'),
      label: textInput(relation.label, '关系，比如 师徒 / 敌对'),
    }));
    const list = h('div', {});
    const draw = () => {
      list.replaceChildren(
        ...(rows.length
          ? rows.map((row, index) =>
              h(
                'div',
                { style: { display: 'flex', gap: '6px', alignItems: 'center', marginBottom: '6px' } },
                h('div', { style: { flex: '1' } }, row.from),
                h('span', { class: 'hint' }, '—'),
                h('div', { style: { flex: '1' } }, row.to),
                h('div', { style: { flex: '1' } }, row.label),
                h('button', { class: 'link-btn', onclick: () => { rows.splice(index, 1); draw(); } }, '删'),
              ),
            )
          : [h('div', { class: 'panel-note' }, '还没有关系，加一条（也可以先用「创作辅助 → 素材抽取」自动抽）。')]),
      );
    };
    draw();
    // 关系图：节点摆在一个圆环上，边用旋转的细线画（纯 DOM，不用 SVG 命名空间）
    const graph = h('div', { class: 'relations-graph', style: { position: 'relative', width: '100%', maxWidth: '320px', aspectRatio: '1 / 1', margin: '10px 0' } });
    const items = (state.extras.relations ?? []).map((relation) => ({ ...relation }));
    const names = [...new Set(items.flatMap((relation) => [relation.from, relation.to]))].filter(Boolean);
    names.forEach((name, index) => {
      const angle = (index / Math.max(1, names.length)) * Math.PI * 2 - Math.PI / 2;
      const left = 50 + 40 * Math.cos(angle);
      const top = 50 + 40 * Math.sin(angle);
      graph.append(h('div', { class: 'relations-node', style: { position: 'absolute', left: `${left}%`, top: `${top}%`, transform: 'translate(-50%, -50%)' }, title: name }, name));
    });
    const pos = new Map(names.map((name, index) => {
      const angle = (index / Math.max(1, names.length)) * Math.PI * 2 - Math.PI / 2;
      return [name, { x: 50 + 40 * Math.cos(angle), y: 50 + 40 * Math.sin(angle) }];
    }));
    for (const relation of items) {
      const a = pos.get(relation.from);
      const b = pos.get(relation.to);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const length = Math.sqrt(dx * dx + dy * dy);
      const deg = (Math.atan2(dy, dx) * 180) / Math.PI;
      graph.append(h('div', {
        class: 'relations-edge',
        title: relation.label,
        style: { position: 'absolute', left: `${a.x}%`, top: `${a.y}%`, width: `${length}%`, height: '2px', transform: `rotate(${deg}deg)`, transformOrigin: 'left center' },
      }));
    }
    return h(
      'div',
      { style: { marginBottom: '16px' } },
      h('div', { class: 'tile-title' }, '角色关系图', h('span', { class: 'chip partial' }, `${items.length} 条关系`)),
      names.length ? graph : emptyState({ icon: '🕸️', title: '还没有关系', desc: '加一条就有图了。' }),
      list,
      h('div', { style: { display: 'flex', gap: '8px', marginTop: '6px' } },
        h('button', { class: 'btn', onclick: () => { rows.push({ from: textInput('', '角色 A'), to: textInput('', '角色 B'), label: textInput('', '关系') }); draw(); } }, '＋ 加一条'),
        h('button', {
          class: 'btn primary',
          onclick: () => save({ relations: rows.map((row) => ({ from: row.from.value, to: row.to.value, label: row.label.value })) }, '关系已保存'),
        }, '保存关系'),
      ),
    );
  }

  function audioBlock() {
    const audio = state.extras.audio ?? EMPTY.audio;
    const bgmSelect = h('select', {}, ...audioOptions());
    const sfxLabel = h('input', { type: 'text', placeholder: '音效名，比如 开门声' });
    const sfxSelect = h('select', {}, ...audioOptions());
    return h(
      'div',
      { style: { marginBottom: '16px' } },
      h('div', { class: 'tile-title' }, '卡内 BGM / 音效清单', h('span', { class: 'chip partial' }, `${(audio.bgm ?? []).length + (audio.sfx ?? []).length} 条`)),
      h('div', { class: 'panel-note' }, '这张卡自带的音乐清单；演出时可以从这里挑。音频先传到「素材库」。'),
      h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '6px', flexWrap: 'wrap' } },
        h('span', { class: 'hint' }, 'BGM'),
        bgmSelect,
        h('button', { class: 'btn', onclick: () => { if (!bgmSelect.value) return toast('先选一段音频', { tone: 'warn' }); void save({ audio: { ...audio, bgm: [...(audio.bgm ?? []), bgmSelect.value] } }, '已加入 BGM 清单'); } }, '＋ 加 BGM'),
      ),
      (audio.bgm ?? []).length
        ? h('div', { class: 'chip-row', style: { display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '4px' } },
            ...audio.bgm.map((id) => h('span', { class: 'chip small' }, `🎵 ${audioName(id)}`, h('button', { class: 'link-btn', onclick: () => save({ audio: { ...audio, bgm: audio.bgm.filter((item) => item !== id) } }) }, '×'))))
        : null,
      h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '8px', flexWrap: 'wrap' } },
        sfxLabel,
        sfxSelect,
        h('button', { class: 'btn', onclick: () => { if (!sfxSelect.value) return toast('先选一段音频', { tone: 'warn' }); void save({ audio: { ...audio, sfx: [...(audio.sfx ?? []), { assetId: sfxSelect.value, label: sfxLabel.value.trim() || '音效' }] } }, '已加入音效清单'); } }, '＋ 加音效'),
      ),
      (audio.sfx ?? []).length
        ? h('div', { class: 'chip-row', style: { display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '4px' } },
            ...audio.sfx.map((item) => h('span', { class: 'chip small' }, `🔊 ${item.label}`, h('button', { class: 'link-btn', onclick: () => save({ audio: { ...audio, sfx: audio.sfx.filter((entry) => entry.assetId !== item.assetId) } }) }, '×'))))
        : null,
    );
  }

  function locksBlock() {
    const locks = new Set(state.extras.locks ?? []);
    const boxes = state.lockable.map((itemDesc) =>
      h('label', { class: 'chip small', style: { display: 'inline-flex', gap: '4px', cursor: 'pointer' } },
        h('input', { type: 'checkbox', dataset: { lock: itemDesc.id }, checked: locks.has(itemDesc.id) }),
        itemDesc.title,
      ),
    );
    return h(
      'div',
      {},
      h('div', { class: 'tile-title' }, '一致性锁定', h('span', { class: locks.size ? 'chip ready' : 'chip stub' }, `${locks.size} 个钉死`)),
      h('div', { class: 'panel-note' }, '钉住的字段在保存卡（界面 / 写卡助手 / MCP）时会被拒绝修改，改稿时不会被动到。'),
      h('div', { class: 'chip-row', style: { display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '6px' } }, ...boxes),
      h('button', {
        class: 'btn primary',
        style: { marginTop: '8px' },
        onclick: () => {
          const picked = [...host.querySelectorAll?.('input[data-lock]') ?? []].filter((box) => box.checked).map((box) => box.dataset.lock);
          void save({ locks: picked }, '一致性锁定已更新');
        },
      }, '保存锁定'),
    );
  }

  function render() {
    if (state.error) {
      host.replaceChildren(panel('卡内加分项', null, h('div', { class: 'panel-note' }, `读不到卡内加分项：${state.error.message ?? state.error}`)));
      return;
    }
    host.replaceChildren(
      panel('卡内加分项（1.10）', null, outlineBlock(), relationsBlock(), audioBlock(), locksBlock()),
    );
  }

  void load();
  return host;
}
