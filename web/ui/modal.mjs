/**
 * 模态框。进场动画照搬参考里的 modalIn（上浮 + 缩放）。
 * 支持 ESC 关闭、点遮罩关闭，打开时锁住背后的滚动。
 *
 * 弹窗是可以叠的（「对话配置」里再弹一个确认框），所以这里维护一个**栈**：
 *   - Esc 只关最上面那层 —— 否则一次 Esc 两层一起没，用户刚填的覆盖项直接丢；
 *   - 滚动锁按栈深度算 —— 内层关掉不该把外层的锁解了；
 *   - 关掉时把焦点还给打开它的那个元素。
 */

import { h } from '../core/dom.mjs';

/** 打开着的弹窗，后进先出。 */
const stack = [];

function syncBodyLock() {
  document.body.style.overflow = stack.length ? 'hidden' : '';
}

export function openModal({ title, body, actions = [], onClose = null, width = null }) {
  const host = document.getElementById('modal-host');
  if (!host) return null;

  // 不写 `instanceof HTMLElement`：精简的 DOM 实现（界面冒烟用的那套）里没有这个全局。
  const active = document.activeElement ?? null;
  const restoreFocus = typeof active?.focus === 'function' ? active : null;
  const entry = { close };

  const closeBtn = h('button', { class: 'modal-close', title: '关闭', onclick: () => close() }, '✕');
  const panel = h(
    'div',
    { class: 'modal-panel', role: 'dialog', 'aria-modal': 'true', tabindex: '-1', style: width ? { width } : null },
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
    if (event.key !== 'Escape') return;
    // 只有栈顶响应 Esc：叠着的内层（比如确认框）关掉之后，外层的表单要还在。
    if (stack[stack.length - 1] !== entry) return;
    event.stopPropagation();
    close();
  };
  document.addEventListener('keydown', onKey);

  host.append(overlay);
  stack.push(entry);
  syncBodyLock();
  // 让键盘用户直接从弹窗里开始：能 Tab 到里面的控件。调用方随后自己 focus 输入框也没关系。
  panel.focus?.();
  requestAnimationFrame(() => overlay.classList.add('active'));

  function close() {
    if (!overlay.isConnected) return;
    overlay.classList.remove('active');
    document.removeEventListener('keydown', onKey);
    const index = stack.indexOf(entry);
    if (index >= 0) stack.splice(index, 1);
    syncBodyLock();
    setTimeout(() => overlay.remove(), 340);
    restoreFocus?.focus?.();
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
