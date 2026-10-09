/**
 * 写卡区工作台 —— 写卡区只有一个入口，跟一张卡有关的板块全摊在同一页上。
 *
 * 顶上一级只有两个：「角色卡」和「写卡助手」，不再有二级标签。
 * 选「角色卡」，卡库 / 编辑器 / 世界书 / 提示词 / X 光机 / 记忆 / 向量 /
 * 卡内前端从前往后排在同一条竖线上，写卡、导卡要用的东西滚一滚就都在，
 * 不用在标签之间来回跳（每块自己带标题，这里不加壳）。「写卡助手」同理，
 * 助手与技能、MCP 工具也在同一页里。
 *
 * 每个板块头上有一条折叠栏（点一下收起 / 展开），默认只把几个不常翻的
 * （X 光机、向量、卡内前端）收起来；折过哪些存在设置 ui.writingFolds 里，
 * 关掉再开还是那个样子。
 * 每个板块的视图都是现成的，这里只负责摞起来与生命周期。
 */

import { h, mount, statusChip } from '../core/dom.mjs';
import { panel, pendingHint } from '../ui/components.mjs';
import { getSetting, patchSettings } from '../core/prefs.mjs';
import { put } from '../core/api.mjs';

const GROUPS = [
  {
    id: 'card',
    title: '角色卡',
    sections: [
      { id: 'cards', title: '角色卡', moduleId: 'cards', view: 'cards' },
      { id: 'editor', title: '编辑器', moduleId: 'cards', view: 'cards:editor' },
      { id: 'worldbook', title: '世界书', moduleId: 'worldbook' },
      { id: 'prompts', title: '提示词', moduleId: 'prompts' },
      { id: 'xray', title: '提示词 X 光机', moduleId: 'prompt-xray', folded: true },
      { id: 'memory', title: '记忆', moduleId: 'memory' },
      { id: 'vectors', title: '数据库与向量化', moduleId: 'vectors', folded: true },
      { id: 'frontend', title: '卡内前端与全局外观', moduleId: 'card-frontend', folded: true },
    ],
  },
  {
    id: 'agent',
    title: '写卡助手',
    sections: [
      { id: 'agent', title: '写卡助手', moduleId: 'agent', view: 'agent' },
      { id: 'mcp', title: 'MCP 服务器', moduleId: 'mcp', view: 'mcp' },
    ],
  },
];

/** 折叠状态：板块 id → 是否收起。改完立刻写回设置，重启还在。 */
const FOLD_STATE = new Map();
const FOLD_KEY = 'ui.writingFolds';
let foldsSeeded = false;

/** 从设置里把上次的折叠状态读出来（坏数据当作没存过）。 */
function seedFolds() {
  if (foldsSeeded) return;
  foldsSeeded = true;
  let stored;
  try {
    stored = JSON.parse(getSetting(FOLD_KEY, '{}') || '{}');
  } catch {
    return;
  }
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return;
  for (const [id, value] of Object.entries(stored)) FOLD_STATE.set(id, Boolean(value));
}

/** 写回设置。存不上只当这次会话里折着（不打扰用户）。 */
function saveFolds() {
  const payload = JSON.stringify(Object.fromEntries(FOLD_STATE));
  patchSettings({ [FOLD_KEY]: payload });
  put('/api/settings', { [FOLD_KEY]: payload }).catch(() => {});
}

export function createWritingView(module, ctx) {
  seedFolds();
  const el = h('div', { class: 'view' });
  const body = h('div', { class: 'work-stack' });
  const moduleById = new Map(ctx.appData.modules.map((item) => [item.id, item]));

  // 扁平索引：板块 id → { section, group }。老写法 openTab('editor', { cardId }) 照样能用。
  const index = new Map();
  for (const group of GROUPS) for (const section of group.sections) index.set(section.id, { section, group });

  const groupButtons = new Map();
  let activeGroupId = GROUPS[0].id;
  let renderedGroupId = null;
  let wrappers = new Map();
  let contents = new Map();

  const groupBar = h('div', { class: 'tabs' });
  for (const group of GROUPS) {
    const button = h('button', { class: 'tab', onclick: () => void selectGroup(group.id) }, group.title);
    groupButtons.set(group.id, button);
    groupBar.append(button);
  }

  function renderBar() {
    for (const [id, button] of groupButtons) button.classList.toggle('active', id === activeGroupId);
  }

  const isFolded = (section) => (FOLD_STATE.has(section.id) ? FOLD_STATE.get(section.id) : section.folded === true);

  function setFolded(section, wrapper, value) {
    const next = value === undefined ? !isFolded(section) : Boolean(value);
    FOLD_STATE.set(section.id, next);
    wrapper.dataset.folded = String(next);
    saveFolds();
  }

  function childCtx(params) {
    return { ...ctx, writeBoard: true, params: params ?? {}, openTab: (id, nextParams) => openTab(id, nextParams) };
  }

  /** 把一个板块的视图挂进它那格。params 用来把选中的卡 id 带过去。 */
  async function mountSection(section, host, params) {
    const target = moduleById.get(section.moduleId);
    const key = section.view ?? target?.web?.view;
    const factory = key ? ctx.views[key] : null;
    if (!target || !factory) {
      host.replaceChildren(h('div', { class: 'empty panel' }, `${section.title}：这个板块还没有界面`));
      return null;
    }
    const view = factory(target, childCtx(params));
    // 板块自己拉数据的空档垫一句提示，别让这块先白一下
    const pending = pendingHint();
    mount(host, view.el, pending.el);
    try {
      await view.mount?.();
    } catch (err) {
      host.append(h('div', { class: 'panel-note' }, `${section.title}加载失败：${err.message}`));
    } finally {
      pending.done();
    }
    return view;
  }

  /** 摆一页：这一组的所有板块从上往下摞起来，同时开始加载。 */
  async function renderGroup(groupId) {
    const group = GROUPS.find((item) => item.id === groupId);
    if (!group) return;
    renderedGroupId = group.id;
    wrappers = new Map();
    contents = new Map();
    body.replaceChildren();
    await Promise.all(
      group.sections.map((section) => {
        const content = h('div', { class: 'work-section-body' });
        const wrapper = h(
          'section',
          { class: 'work-section', dataset: { section: section.id, folded: String(isFolded(section)) } },
          h(
            'button',
            { class: 'work-fold', type: 'button', onclick: () => setFolded(section, wrapper) },
            h('span', { class: 'work-fold-caret' }, '▾'),
            h('span', { class: 'work-fold-title' }, section.title),
          ),
          content,
        );
        wrappers.set(section.id, wrapper);
        contents.set(section.id, content);
        body.append(wrapper);
        return mountSection(section, content, {});
      }),
    );
  }

  async function selectGroup(groupId) {
    if (groupId === activeGroupId && renderedGroupId === groupId) return;
    activeGroupId = groupId;
    renderBar();
    await renderGroup(groupId);
  }

  /**
   * 子视图把工作台领到某个板块（例如卡库里点「编辑」→ 带卡 id 重挂编辑器），
   * 顺便滚过去，不然东西在下面用户看不见。
   */
  async function openTab(sectionId, params = {}) {
    const found = index.get(sectionId);
    if (!found) return;
    if (found.group.id !== activeGroupId || renderedGroupId !== found.group.id) {
      activeGroupId = found.group.id;
      renderBar();
      await renderGroup(found.group.id);
    }
    const wrapper = wrappers.get(sectionId);
    const content = contents.get(sectionId);
    if (!wrapper || !content) return;
    if (isFolded(found.section)) setFolded(found.section, wrapper, false); // 要滚过去给人看，先展开
    await mountSection(found.section, content, params);
    wrapper.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  }

  el.append(
    panel(
      module.title,
      null,
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } }, statusChip(module.status), h('span', { class: 'panel-note' }, module.summary)),
      h('div', { style: { marginTop: '14px' } }, groupBar),
    ),
    body,
  );
  renderBar();

  return { el, mount: () => selectGroup(activeGroupId) };
}
