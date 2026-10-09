/** 应用外壳：左侧导航 + 顶栏 + 内容区。导航由服务端的模块地图生成。 */

import { h } from '../core/dom.mjs';
import { areaTitle, moduleTitle, statusLabel, t } from '../core/i18n.mjs';
import { openModal } from './modal.mjs';

export function createShell({ appData, onNavigate, onOpenPalette = null, onLayoutChange = null }) {
  const navHost = h('nav', {});
  const titleEl = h('h1', {}, 'Silver Tavern');
  const subEl = h('div', { class: 'topbar-sub' }, '');
  const actionsEl = h('div', { class: 'topbar-actions' });
  const host = h('div', { class: 'view-host' });
  const shellEl = h('div', { class: 'shell' });
  const footerEl = h('div', { class: 'sidebar-footer' });

  const menuBtn = h(
    'button',
    { class: 'btn menu-btn on-dark', title: 'menu', onclick: () => shellEl.classList.toggle('sidebar-open') },
    '☰',
  );
  const paletteBtn = h(
    'button',
    { class: 'btn menu-btn on-dark palette-btn', title: 'Ctrl/Cmd+K', onclick: () => onOpenPalette?.() },
    '⌘K',
  );

  const brandSub = h('div', { class: 'brand-sub' }, `v${appData.version} · 写卡 + 玩卡`);
  const brand = h(
    'div',
    { class: 'brand' },
    h('div', { class: 'brand-mark' }, '酒'),
    h(
      'div',
      {},
      h('div', { class: 'brand-title' }, 'Silver Tavern'),
      brandSub,
    ),
  );

  const sidebar = h(
    'aside',
    { class: 'sidebar' },
    brand,
    navHost,
    footerEl,
  );
  const resizer = h('div', { class: 'nav-resizer', title: '拖动调宽' });
  sidebar.append(resizer);

  const sessionEl = h('div', { class: 'topbar-session' });
  const topbar = h('header', { class: 'topbar' }, menuBtn, paletteBtn, h('div', { class: 'topbar-titles' }, titleEl, subEl), actionsEl, sessionEl);

  shellEl.append(sidebar, h('main', { class: 'main' }, topbar, host));

  /** 布局：auto（宽屏双栏 / 窄屏单栏）、two-column（始终显示侧栏）、single（侧栏收起）。 */
  function clampNavWidth(value) {
    const num = Number(value);
    return Number.isFinite(num) ? Math.max(160, Math.min(420, num)) : 220;
  }

  /** 玩卡区宽度：50 ~ 100（vw 百分比），默认 78。 */
  function clampPlayWidth(value) {
    const num = Number(value);
    return Number.isFinite(num) ? Math.max(50, Math.min(100, num)) : 78;
  }

  function applyLayout(settings = {}) {
    const layout = ['auto', 'two-column', 'single'].includes(settings['ui.layout']) ? settings['ui.layout'] : 'auto';
    shellEl.dataset.layout = layout;
    shellEl.style.setProperty('--st-sidebar', `${clampNavWidth(settings['ui.navWidth'])}px`);
    // 玩卡区宽度：照酒馆那个"聊天宽度"滑条的做法 —— 一个百分比写进 CSS 变量，
    // 玩卡区各页的 .view 用它当 max-width（写卡区仍旧 1080px）。
    shellEl.style.setProperty('--st-play-width', `${clampPlayWidth(settings['ui.playWidth'])}vw`);
  }

  const layoutBtn = h(
    'button',
    {
      class: 'btn',
      style: { marginTop: '8px', width: '100%' },
      onclick: () => {
        const next = shellEl.dataset.layout === 'single' ? 'two-column' : 'single';
        applyLayout({ ...layoutState, 'ui.layout': next });
        onLayoutChange?.({ 'ui.layout': next });
      },
    },
    '⇔ 切换单栏 / 双栏',
  );
  const layoutState = {};

  let resizing = false;
  resizer.addEventListener('pointerdown', (event) => {
    resizing = true;
    resizer.setPointerCapture?.(event.pointerId);
    document.body?.classList?.add('resizing');
  });
  window.addEventListener('pointermove', (event) => {
    if (!resizing) return;
    shellEl.style.setProperty('--st-sidebar', `${clampNavWidth(event.clientX)}px`);
  });
  window.addEventListener('pointerup', (event) => {
    if (!resizing) return;
    resizing = false;
    document.body?.classList?.remove('resizing');
    onLayoutChange?.({ 'ui.navWidth': clampNavWidth(event.clientX) });
  });

  /** 语言切换后文案要重画，所以导航单独抽成一个函数。 */
  function renderNav() {
    brandSub.textContent = `v${appData.version} · ${t('app.tagline')}`;
    footerEl.replaceChildren(h('div', { class: 'hint' }, t('app.footer', { modules: appData.modules.length, areas: appData.areas.length })), layoutBtn);
    navHost.replaceChildren();
    for (const area of appData.areas) {
      // nav === false 的模块是"内部板块"，只在写卡区工作台里当标签用，不单独占导航
      const modules = appData.modules.filter((mod) => mod.area === area.id && mod.nav !== false);
      if (!modules.length) continue;
      navHost.append(
        h(
          'div',
          { class: 'nav-group' },
          h('div', { class: 'nav-group-title' }, areaTitle(area), h('span', { class: 'nav-group-summary' }, area.summary)),
          modules.map((mod) =>
            h(
              'button',
              {
                class: 'nav-item',
                dataset: { module: mod.id },
                title: mod.summary ?? '',
                onclick: () => {
                  onNavigate(mod.id);
                  shellEl.classList.remove('sidebar-open');
                },
              },
              h('span', { class: 'nav-icon' }, mod.web?.icon ?? '•'),
              h('span', { class: 'nav-label' }, moduleTitle(mod)),
              h('span', { class: `dot ${mod.status}`, title: statusLabel(mod.status) }),
            ),
          ),
        ),
      );
    }
  }
  renderNav();

  /** 改口令弹窗。`onChangePassword` 由 app.js 提供，返回 false 表示失败（不关窗）。 */
  function openPasswordDialog(onChangePassword) {
    const current = h('input', { type: 'password', placeholder: '当前口令', autocomplete: 'current-password' });
    const next = h('input', { type: 'password', placeholder: '新口令（至少 8 位）', autocomplete: 'new-password' });
    const again = h('input', { type: 'password', placeholder: '再输一次新口令', autocomplete: 'new-password' });
    const hint = h('div', { class: 'hint' }, '');
    openModal({
      title: '改口令',
      body: h(
        'div',
        {},
        h('div', { class: 'field' }, h('label', {}, '当前口令'), current),
        h('div', { class: 'field' }, h('label', {}, '新口令'), next),
        h('div', { class: 'field' }, h('label', {}, '确认新口令'), again),
        hint,
      ),
      actions: [
        { label: t('btn.cancel') },
        {
          label: t('btn.save'),
          primary: true,
          onClick: async () => {
            if (!next.value || next.value !== again.value) {
              hint.textContent = '两次新口令不一样';
              return false;
            }
            const ok = await onChangePassword(current.value, next.value);
            if (ok === false) return false;
          },
        },
      ],
    });
  }

  return {
    el: shellEl,
    host,
    refresh: renderNav,
    applyLayout,
    setLayoutState(settings) {
      Object.assign(layoutState, settings ?? {});
      applyLayout(layoutState);
    },
    /**
     * 多用户模式下的右上角账号区：名字 + 菜单（主机管理 / 改口令 / 退出登录）。
     * 单机模式传 null 就什么都不显示。
     */
    setSession({ user = null, onLogout = null, onChangePassword = null, onOpenHost = null } = {}) {
      if (!user) {
        sessionEl.replaceChildren();
        return;
      }
      const chip = h(
        'button',
        {
          class: 'btn menu-btn on-dark session-btn',
          title: user.role === 'admin' ? '管理员' : '成员',
          onclick: () =>
            openModal({
              title: `账号：${user.name}`,
              body: h(
                'div',
                {},
                h('div', { class: 'panel-note' }, user.role === 'admin' ? '你是管理员：能开账号、看服务总览，但看不到别人的对话内容。' : '你是成员：只有自己那一份数据。'),
                h('div', { class: 'hint', style: { marginTop: '8px' } }, '数据放在这台机器上你自己的目录里，换设备用这个账号登录就能接着玩。'),
              ),
              actions: [
                onOpenHost && user.role === 'admin' ? { label: '主机管理', onClick: () => onOpenHost() } : null,
                onChangePassword ? { label: '改口令', onClick: () => openPasswordDialog(onChangePassword) } : null,
                onLogout ? { label: '退出登录', primary: true, onClick: () => onLogout() } : null,
              ].filter(Boolean),
            }),
        },
        `${user.role === 'admin' ? '🛡️' : '👤'} ${user.name}`,
      );
      sessionEl.replaceChildren(chip);
    },
    setActive(moduleId) {
      for (const node of navHost.querySelectorAll('.nav-item')) {
        node.classList.toggle('active', node.dataset.module === moduleId);
      }
    },
    setHeader({ title, subtitle, actions = [] }) {
      titleEl.textContent = title ?? '';
      subEl.textContent = subtitle ?? '';
      actionsEl.replaceChildren(...actions);
    },
    setSubtitle(text) {
      subEl.textContent = text ?? '';
    },
  };
}
