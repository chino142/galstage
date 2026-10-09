/** 极小的 DOM 构造工具。没有虚拟 DOM，够用就行。 */

export function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }
  append(node, children);
  return node;
}

export function append(node, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function frag(...children) {
  return append(document.createDocumentFragment(), children);
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function mount(host, ...children) {
  clear(host);
  append(host, children);
  return host;
}

export function qs(selector, root = document) {
  return root.querySelector(selector);
}

/** 逐字浮现：把文字拆成 span，每个字延迟 0.03s 出现。 */
export function typewriter(text, { delay = 0.03 } = {}) {
  const box = h('span', { class: 'typewriter' });
  [...String(text ?? '')].forEach((ch, index) => {
    box.append(h('span', { class: 'char', style: { animationDelay: `${(index * delay).toFixed(2)}s` } }, ch));
  });
  return box;
}

export const STATUS_LABEL = {
  planned: '计划中',
  stub: '有接口',
  partial: '部分可用',
  ready: '已完成',
};

export function statusChip(status) {
  return h('span', { class: `chip ${status}` }, STATUS_LABEL[status] ?? status);
}
