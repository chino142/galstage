/** 复用的界面零件。视图只拼这些，不各写各的样式。 */

import { h, statusChip } from '../core/dom.mjs';

export function panel(title, note, ...children) {
  return h(
    'section',
    { class: 'panel' },
    title
      ? h('div', { class: 'panel-head' }, h('h2', {}, title), note ? h('span', { class: 'panel-note' }, note) : null)
      : null,
    ...children,
  );
}

export function tile({ icon, title, desc, status, footer }) {
  return h(
    'div',
    { class: 'tile' },
    h('div', { class: 'tile-title' }, icon ? h('span', {}, icon) : null, title, status ? statusChip(status) : null),
    desc ? h('div', { class: 'tile-desc' }, desc) : null,
    footer ?? null,
  );
}

export function emptyState({ icon = '🌸', title, desc, action = null }) {
  return h(
    'div',
    { class: 'empty' },
    h('span', { class: 'empty-icon' }, icon),
    title ? h('div', { style: { fontWeight: '600', color: 'var(--st-title)' } }, title) : null,
    desc ? h('div', { style: { fontSize: '12.5px' } }, desc) : null,
    action ? h('div', { style: { marginTop: '12px' } }, action) : null,
  );
}

export function planList(items = []) {
  return h('ul', { class: 'plan-list' }, items.map((item) => h('li', {}, item)));
}

export function paths(list = []) {
  if (!list.length) return null;
  return h('div', { class: 'paths' }, list.map((path) => h('span', { class: 'path-pill mono' }, path)));
}

export function kv(pairs) {
  const rows = [];
  for (const [key, value] of pairs) {
    rows.push(h('dt', {}, key));
    rows.push(h('dd', {}, value));
  }
  return h('dl', { class: 'kv' }, rows);
}

export function field(label, control, hint = null) {
  return h(
    'div',
    { class: 'field' },
    label ? h('label', {}, label) : null,
    control,
    hint ? h('div', { class: 'hint' }, hint) : null,
  );
}

export function tabs(items, onChange) {
  let active = items[0]?.id ?? null;
  const buttons = new Map();
  const host = h(
    'div',
    { class: 'tabs' },
    items.map((item) => {
      const button = h(
        'button',
        { class: `tab${item.id === active ? ' active' : ''}`, onclick: () => setActive(item.id) },
        item.title,
      );
      buttons.set(item.id, button);
      return button;
    }),
  );

  function setActive(id) {
    active = id;
    for (const [key, button] of buttons) button.classList.toggle('active', key === id);
    onChange?.(id);
  }

  return { el: host, setActive, get active() { return active; } };
}

export function table(headers, rows) {
  return h(
    'table',
    { class: 'data' },
    h('thead', {}, h('tr', {}, headers.map((header) => h('th', {}, header)))),
    h('tbody', {}, rows.map((row) => h('tr', {}, row.map((cell) => h('td', {}, cell))))),
  );
}

export function loading(text = '读取中…') {
  return h('div', { class: 'empty' }, h('span', { class: 'empty-icon' }, '⏳'), text);
}

/**
 * 视图自己还在拉数据时，垫在内容区的一句提示。
 *
 * 为什么不在视图里直接写死：视图把内容塞进自己那个 host 之前，出去的那一瞬间
 * 内容区是空的 —— 弱机上就是"点一下，右边先白一片"。这里统一垫一句，
 * 而且默认延迟 140ms 才显示：数据回来快的时候它根本不会出现，不会闪。
 *
 * @returns {{el: HTMLElement, done: () => void}} 挂进容器后，视图加载完调用 done()。
 */
export function pendingHint(text = '读取中…', delayMs = 140) {
  const el = h('div', { class: 'view-pending' }, text);
  el.style.visibility = 'hidden';
  const timer = setTimeout(() => { el.style.visibility = ''; }, delayMs);
  return {
    el,
    done() {
      clearTimeout(timer);
      el.remove();
    },
  };
}

export function errorBox(err, { onRetry = null } = {}) {
  return h(
    'div',
    { class: 'empty' },
    h('span', { class: 'empty-icon' }, err?.notImplemented ? '🚧' : '⚠️'),
    h(
      'div',
      { style: { fontWeight: '600', color: 'var(--st-title)' } },
      err?.notImplemented ? '接口已就位，功能还没实现' : '出错了',
    ),
    h('div', { style: { fontSize: '12.5px' } }, err?.message ?? String(err)),
    onRetry ? h('div', { style: { marginTop: '10px' } }, h('button', { class: 'btn', onclick: onRetry }, '重试')) : null,
  );
}
