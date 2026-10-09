/**
 * 模态框。进场动画照搬参考里的 modalIn（上浮 + 缩放）。
 * 支持 ESC 关闭、点遮罩关闭，打开时锁住背后的滚动。
 */

import { h } from '../core/dom.mjs';

export function openModal({ title, body, actions = [], onClose = null, width = null }) {
  const host = document.getElementById('modal-host');
  if (!host) return null;

  const closeBtn = h('button', { class: 'modal-close', title: '关闭', onclick: () => close() }, '✕');
  const panel = h(
    'div',
    { class: 'modal-panel', role: 'dialog', 'aria-modal': 'true', style: width ? { width } : null },
    h('div', { class: 'modal-head' }, h('h3', {}, title ?? ''), closeBtn),
    body ?? null,
    actions.length
      ? h(
          'div',
          { class: 'modal-actions' },
          actions.map((action) =>
            h(
              'button',
              {
                class: `btn ${action.primary ? 'primary' : ''}`,
                onclick: async () => {
                  const keep = await action.onClick?.();
                  if (keep !== false) close();
                },
              },
              action.label,
            ),
          ),
        )
      : null,
  );

  const overlay = h('div', { class: 'modal-overlay' }, panel);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close();
  });

  const onKey = (event) => {
    if (event.key === 'Escape') close();
  };
  document.addEventListener('keydown', onKey);
  document.body.style.overflow = 'hidden';

  host.append(overlay);
  requestAnimationFrame(() => overlay.classList.add('active'));

  function close() {
    if (!overlay.isConnected) return;
    overlay.classList.remove('active');
    document.removeEventListener('keydown', onKey);
    document.body.style.overflow = '';
    setTimeout(() => overlay.remove(), 340);
    onClose?.();
  }

  return { close, panel, overlay };
}

/** 是 / 否 确认框，返回 Promise<boolean>。 */
export function confirmDialog({ title = '确认', message = '', confirmLabel = '确定', cancelLabel = '取消' } = {}) {
  return new Promise((resolve) => {
    let result = false;
    openModal({
      title,
      body: h('div', { style: { fontSize: '13.5px' } }, message),
      actions: [
        { label: cancelLabel, onClick: () => { result = false; } },
        { label: confirmLabel, primary: true, onClick: () => { result = true; } },
      ],
      onClose: () => resolve(result),
    });
  });
}
