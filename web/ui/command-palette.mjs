/**
 * 命令面板（蓝图 3.2「使用体验」）：Ctrl/Cmd+K 打开，搜所有模块 + 几个快捷操作。
 *
 * 模块清单来自服务端的模块地图，所以以后加模块这里自动多一条。
 * 用了一个自建 overlay 而不是 openModal：面板要一边打字一边过滤、还要用方向键选。
 */

import { h } from '../core/dom.mjs';
import { areaTitle, moduleTitle, t } from '../core/i18n.mjs';

const THEME_ORDER = ['system', 'light', 'dark', 'sepia'];

export function nextTheme(theme) {
  const index = THEME_ORDER.indexOf(theme ?? 'system');
  return THEME_ORDER[(index + 1) % THEME_ORDER.length];
}

export function filterCommands(items, query) {
  const words = String(query ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return items.slice(0, 40);
  return items.filter((item) => {
    const haystack = `${item.title} ${item.subtitle ?? ''} ${item.keywords ?? ''}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  }).slice(0, 40);
}

export function createCommandPalette({ appData = {}, onNavigate = null, onCycleTheme = null, onToggleLanguage = null, getTheme = null } = {}) {
  let overlay = null;
  let inputEl = null;
  let listHost = null;
  let items = [];
  let matches = [];
  let cursor = 0;

  function buildItems() {
    const areas = new Map((appData.areas ?? []).map((area) => [area.id, area]));
    const out = [];
    for (const mod of appData.modules ?? []) {
      if (mod.nav === false) continue;
      const area = areas.get(mod.area);
      const areaName = areaTitle(area);
      const title = moduleTitle(mod);
      out.push({
        id: `module:${mod.id}`,
        group: t('palette.modules'),
        title,
        subtitle: `${areaName}${mod.summary ? ` · ${mod.summary}` : ''}`,
        keywords: `${mod.id} ${mod.title ?? ''} ${area?.title ?? ''}`,
        run: () => onNavigate?.(mod.id),
      });
    }
    out.push({
      id: 'action:settings',
      group: t('palette.actions'),
      title: t('palette.openSettings'),
      keywords: 'settings 设置',
      run: () => onNavigate?.('settings'),
    });
    out.push({
      id: 'action:theme',
      group: t('palette.actions'),
      title: t('palette.toggleTheme'),
      subtitle: getTheme ? t(`option.${getTheme()}`, null, getTheme()) : '',
      keywords: 'theme 主题 护眼 sepia',
      run: () => onCycleTheme?.(),
    });
    out.push({
      id: 'action:language',
      group: t('palette.actions'),
      title: t('palette.toggleLanguage'),
      keywords: 'language 语言 english 中文',
      run: () => onToggleLanguage?.(),
    });
    return out;
  }

  function draw() {
    if (!listHost) return;
    if (!matches.length) {
      listHost.replaceChildren(h('div', { class: 'palette-empty' }, t('palette.empty')));
      return;
    }
    listHost.replaceChildren(
      ...matches.map((item, i) =>
        h(
          'button',
          {
            class: `palette-item${i === cursor ? ' active' : ''}`,
            onmousemove: () => setCursor(i),
            onclick: () => execute(item),
          },
          h('span', { class: 'palette-group' }, item.group),
          h('span', { class: 'palette-title' }, item.title),
          item.subtitle ? h('span', { class: 'palette-sub' }, item.subtitle) : null,
        ),
      ),
    );
  }

  function setCursor(next) {
    if (!matches.length) return;
    cursor = (next + matches.length) % matches.length;
    draw();
  }

  function refresh(query) {
    matches = filterCommands(items, query);
    cursor = 0;
    draw();
  }

  function execute(item) {
    const run = item?.run;
    close();
    run?.();
  }

  function close() {
    if (!overlay) return;
    overlay.remove();
    overlay = null;
    inputEl = null;
    listHost = null;
  }

  function open() {
    if (overlay) return;
    items = buildItems();
    matches = filterCommands(items, '');
    cursor = 0;

    inputEl = h('input', {
      class: 'palette-input',
      placeholder: t('palette.placeholder'),
      oninput: (event) => refresh(event.target.value),
      onkeydown: (event) => {
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          setCursor(cursor + 1);
        } else if (event.key === 'ArrowUp') {
          event.preventDefault();
          setCursor(cursor - 1);
        } else if (event.key === 'Enter') {
          event.preventDefault();
          execute(matches[cursor]);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          close();
        }
      },
    });
    listHost = h('div', { class: 'palette-list' });
    const panel = h(
      'div',
      { class: 'palette-panel' },
      h('div', { class: 'palette-head' }, h('span', { class: 'palette-brand' }, t('palette.title')), inputEl),
      listHost,
      h('div', { class: 'palette-hint' }, t('palette.hint')),
    );
    overlay = h('div', { class: 'modal-overlay palette-overlay' }, panel);
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) close();
    });
    document.body.append(overlay);
    // 可能开完马上就关了，回调里要再确认一次 overlay 还在
    requestAnimationFrame(() => overlay?.classList.add('active'));
    draw();
    setTimeout(() => inputEl?.focus(), 20);
  }

  return { open, close, isOpen: () => Boolean(overlay), buildItems, nextTheme: () => nextTheme(getTheme?.()) };
}
