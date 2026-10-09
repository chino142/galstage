/**
 * 前端入口。
 *
 * 启动流程：拉 /api/app 拿模块地图 → 建外壳 → 起哈希路由 → 挂视图。
 * 导航完全由服务端的模块表驱动：加一个模块，侧边栏自动多一项。
 */

import { h, mount } from './core/dom.mjs';
import { get, post, put } from './core/api.mjs';
import { createHashRouter } from './core/router.mjs';
import { createShell } from './ui/shell.mjs';
import { createAuthScreen } from './ui/auth-screen.mjs';
import { applyTheme } from './ui/theme.mjs';
import { createCommandPalette, nextTheme } from './ui/command-palette.mjs';
import { createShortcutManager } from './core/shortcuts.mjs';
import { getLocale, setLocale, t } from './core/i18n.mjs';
import { getSetting, initPrefs, patchSettings } from './core/prefs.mjs';
import { createView, VIEW_FACTORIES } from './views/index.mjs';
import { toast, toastError } from './ui/toast.mjs';
import { panel, field, errorBox, pendingHint } from './ui/components.mjs';

async function boot() {
  const appRoot = document.getElementById('app');

  // 多用户模式：先看有没有登录。没登录时连 /api/app 都会 401，所以这一句必须在前面。
  let authStatus = { multiUser: false, authenticated: true, setupRequired: false };
  try {
    authStatus = await get('/api/auth/status');
  } catch {
    // 老版本服务没有这个接口 → 当单机模式
  }
  if (authStatus.multiUser && !authStatus.authenticated) {
    appRoot.classList.remove('app-loading');
    const screen = createAuthScreen({
      mode: authStatus.setupRequired ? 'setup' : 'login',
      version: authStatus.version ?? '',
      hostRoot: authStatus.hostRoot ?? null,
      onAuthenticated: () => location.reload(),
    });
    mount(appRoot, screen.el);
    return;
  }

  let appData;
  try {
    appData = await get('/api/app');
  } catch (err) {
    appRoot.classList.remove('app-loading');
    mount(appRoot, h('div', { class: 'view' }, panel('连不上服务', null, errorBox(err, { onRetry: () => location.reload() }))));
    return;
  }

  initPrefs(appData.settings);
  setLocale(getSetting('ui.language', 'zh-CN'));
  applyTheme(appData.settings);

  // 插件能用的界面零件（插件视图模块里可以直接读 window.tavern.ui，或者用 ctx.ui）
  const pluginUi = { h, panel, field, toast, toastError };
  window.tavern = { ui: pluginUi };
  for (const view of appData.plugins?.views ?? []) {
    try {
      const mod = await import(`/api/plugins/${encodeURIComponent(view.plugin)}/${encodeURIComponent(view.file)}`);
      const factory = mod.default ?? mod.createView ?? mod.factory;
      if (typeof factory === 'function') VIEW_FACTORIES[view.key] = factory;
      else console.error(`[plugins] 视图 ${view.plugin}/${view.file} 没有导出工厂函数`);
    } catch (err) {
      console.error(`[plugins] 视图 ${view.plugin}/${view.file} 加载失败`, err);
    }
  }
  for (const style of appData.plugins?.styles ?? []) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `/api/plugins/${encodeURIComponent(style.plugin)}/${encodeURIComponent(style.file)}`;
    document.head.append(link);
  }

  const modules = new Map(appData.modules.map((mod) => [mod.id, mod]));
  const fallback = appData.modules.find((mod) => mod.area === 'writing')?.id ?? appData.modules[0]?.id ?? 'cards';

  /** 设置改了就落库 + 更新前端状态；失败只提示，不改界面。 */
  async function persistSettings(patch) {
    const result = await put('/api/settings', patch);
    patchSettings(result.settings);
    applyTheme(result.settings);
    return result.settings;
  }

  let currentModuleId = fallback;
  let rerender = () => {};

  const palette = createCommandPalette({
    appData,
    onNavigate: (id) => router.go(id),
    getTheme: () => getSetting('ui.theme', 'system'),
    onCycleTheme: async () => {
      try {
        const next = nextTheme(getSetting('ui.theme', 'system'));
        await persistSettings({ 'ui.theme': next });
        toast(`${t('setting.ui.theme.label')}：${t(`option.${next}`, null, next)}`);
      } catch (err) {
        toastError(err);
      }
    },
    onToggleLanguage: async () => {
      try {
        const next = getLocale() === 'en' ? 'zh-CN' : 'en';
        await persistSettings({ 'ui.language': next });
        setLocale(next);
        shell.refresh();
        rerender(); // 当前视图重新挂一遍，按钮与提示也跟着换语言
        toast(next === 'en' ? 'Language: English' : '语言：中文');
      } catch (err) {
        toastError(err);
      }
    },
  });

  const shortcuts = createShortcutManager();
  shortcuts.register('palette', 'Ctrl+K', () => palette.open());
  shortcuts.register('palette-meta', 'Meta+K', () => palette.open());

  const shell = createShell({
    appData,
    onNavigate: (id) => router.go(id),
    onOpenPalette: () => palette.open(),
    // 拖动侧栏 / 切换单栏双栏：把宽度与布局存回设置
    onLayoutChange: (patch) => { void persistSettings(patch).catch((err) => toastError(err)); },
  });
  shell.setLayoutState(appData.settings);
  shell.applyLayout(appData.settings);

  // 会话过期（比如被管理员停用 / 口令改了）：回登录页，别停在一堆报错上
  let unauthorizedHandled = false;
  window.addEventListener?.('tavern:unauthorized', () => {
    if (unauthorizedHandled) return;
    unauthorizedHandled = true;
    location.reload();
  });

  /** 退出登录 / 改口令（只有多用户模式才有 user，单机模式不显示账号区）。 */
  async function logout() {
    try {
      await post('/api/auth/logout', {});
    } catch {
      // 退出失败也刷新，反正会话没了就是没了
    }
    location.reload();
  }
  async function changePassword(currentPassword, newPassword) {
    try {
      await post('/api/auth/password', { currentPassword, newPassword });
      toast('口令已改');
      return true;
    } catch (err) {
      toastError(err);
      return false;
    }
  }
  if (appData.auth?.user) {
    shell.setSession({
      user: appData.auth.user,
      onLogout: logout,
      onChangePassword: changePassword,
      onOpenHost: () => router.go('host'),
    });
  }
  mount(appRoot, shell.el);
  appRoot.classList.remove('app-loading');

  let token = 0;
  // 记一下哪些板块已经进过：CSS 的入场动画只给第一次进的那个板块播（data-enter="first"），
  // 之后来回切换是瞬时的。以前每次挂载都淡入，弱机上就是"内容先白一下"。
  const entered = new Set();

  async function show(id, sub) {
    const module = modules.get(id) ?? modules.get(fallback);
    currentModuleId = module.id;
    const mine = ++token;
    const ctx = {
      appData,
      viewKey: sub,
      views: VIEW_FACTORIES,
      navigate: (nextId, nextSub = null) => router.go(nextId, { sub: nextSub }),
      shortcuts,
      ui: pluginUi,
      // 设置页保存后调：更新前端设置、语言，并重画导航（文案可能变了）
      onSettingsSaved: (settings) => {
        patchSettings(settings);
        applyTheme(settings);
        shell.setLayoutState(settings);
        shell.applyLayout(settings);
        setLocale(getSetting('ui.language', 'zh-CN'));
        shell.refresh();
        rerender();
      },
    };

    shell.setActive(module.id);
    // 让 CSS 知道现在这块是哪个区（玩卡区用更宽的容器）
    document.documentElement.dataset.area = module.area ?? '';
    shell.setHeader({ title: module.title, subtitle: module.summary });
    document.title = `${module.title} · Silver Tavern`;

    const view = createView(module, ctx);
    if (view.el?.dataset && !entered.has(module.id)) {
      entered.add(module.id);
      view.el.dataset.enter = 'first';
    }
    // 视图拉数据的这段时间先垫一句提示：别让内容区空着（视图自己也有提示的话不冲突）
    const pending = pendingHint();
    mount(shell.host, view.el, pending.el);
    try {
      await view.mount?.();
    } catch (err) {
      toastError(err);
    } finally {
      pending.done();
    }
    if (mine !== token) return; // 用户已经切走了，别做多余的事
  }

  const router = createHashRouter({ fallback, onChange: (id, sub) => show(id, sub) });
  rerender = () => show(currentModuleId);
  router.start();

  // ComfyUI 浏览器直连：前端在线时把服务端登记的"待办出图"领走执行。
  // 服务器执行 / 未启用时这个后台泵读一次配置就什么都不做。
  try {
    const { startComfyClientPump } = await import('./ui/comfy-client.mjs');
    startComfyClientPump();
  } catch (err) {
    console.error('[comfy] 浏览器直连后台泵启动失败（不影响其它功能）', err);
  }

  shortcuts.attach(window);
  window.tavern = { appData, shell, router, palette, shortcuts, persistSettings, ui: pluginUi };
}

boot();
