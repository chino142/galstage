/**
 * 登录 / 首次建号界面（多用户模式）。
 *
 * 只有主机模式会用到：没登录就先给这一屏，不加载任何业务数据。
 * 保持纯 DOM，不用其它视图零件 —— 它要能在"什么都还没加载"的时候跑起来。
 */

import { h } from '../core/dom.mjs';
import { post } from '../core/api.mjs';

export function createAuthScreen({ mode = 'login', version = '', hostRoot = null, onAuthenticated = null } = {}) {
  const setup = mode === 'setup';
  const el = h('div', { class: 'auth-screen' });
  const nameInput = h('input', { placeholder: '账号名（小写字母、数字、- 和 _）', autocomplete: 'username', spellcheck: 'false' });
  const passwordInput = h('input', { type: 'password', placeholder: setup ? '设一个口令（至少 8 位）' : '口令', autocomplete: setup ? 'new-password' : 'current-password' });
  const confirmInput = h('input', { type: 'password', placeholder: '再输一次', autocomplete: 'new-password' });
  const errorEl = h('div', { class: 'auth-error' });
  const submitBtn = h('button', { class: 'btn primary auth-submit' }, setup ? '建管理员账号' : '登录');

  let busy = false;

  async function submit() {
    if (busy) return;
    const name = nameInput.value.trim();
    const password = passwordInput.value;
    if (!name) return showError('先填账号名');
    if (!password) return showError('先填口令');
    if (setup && password !== confirmInput.value) return showError('两次口令不一样');

    busy = true;
    submitBtn.disabled = true;
    errorEl.textContent = '';
    try {
      const payload = await post(setup ? '/api/auth/setup' : '/api/auth/login', { name, password });
      onAuthenticated?.(payload);
    } catch (err) {
      showError(err?.message ?? String(err));
    } finally {
      busy = false;
      submitBtn.disabled = false;
    }
  }

  function showError(message) {
    errorEl.textContent = message ?? '';
  }

  for (const input of [nameInput, passwordInput, confirmInput]) {
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        void submit();
      }
    });
  }
  submitBtn.addEventListener('click', () => void submit());

  el.append(
    h(
      'div',
      { class: 'auth-card panel' },
      h('div', { class: 'auth-brand' }, h('span', { class: 'brand-mark' }, '酒'), h('span', {}, 'Silver Tavern')),
      h('div', { class: 'auth-title' }, setup ? '第一步：建管理员账号' : '登录'),
      h(
        'div',
        { class: 'auth-note' },
        setup
          ? '这个账号就是你自己（管理员）。建完之后，你可以在「主机管理」里给朋友们开账号——每个人的对话、角色卡、素材都放在各自的数据目录里，互相看不见。'
          : '用你的账号登录。数据存在这台机器的你的专属目录里，换设备只是换浏览器。',
      ),
      h('div', { class: 'field' }, h('label', {}, '账号'), nameInput),
      h('div', { class: 'field' }, h('label', {}, '口令'), passwordInput),
      setup ? h('div', { class: 'field' }, h('label', {}, '确认口令'), confirmInput) : null,
      errorEl,
      submitBtn,
      h('div', { class: 'auth-foot' }, hostRoot ? `数据目录：${hostRoot}` : '', version ? ` · v${version}` : ''),
    ),
  );

  setTimeout(() => nameInput.focus?.(), 30);
  return { el, submit };
}
