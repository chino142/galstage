/** 底部轻提示。网络错误与"还没做"都从这里出，风格统一。 */

import { h } from '../core/dom.mjs';

export function toast(message, { tone = 'info', duration = 2600 } = {}) {
  const host = document.getElementById('toast-host');
  if (!host) return null;
  const el = h('div', { class: `toast ${tone}` }, message);
  host.append(el);
  setTimeout(() => {
    el.style.transition = 'opacity .3s ease, transform .3s ease';
    el.style.opacity = '0';
    el.style.transform = 'translateY(8px)';
    setTimeout(() => el.remove(), 320);
  }, duration);
  return el;
}

/** 统一的错误出口：501 用警告色，其它用错误色。 */
export function toastError(err) {
  const message = err?.message ?? String(err);
  if (err?.notImplemented) return toast(message, { tone: 'warn', duration: 3200 });
  return toast(message, { tone: 'error', duration: 4000 });
}
