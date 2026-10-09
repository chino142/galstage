/**
 * 前端的"当前设置"：一个进程内的小状态容器。
 *
 * app.js 启动时灌入 `/api/app` 里的 settings；设置页保存成功后也会更新它。
 * 通知 / 快捷键 / 命令面板都从这里现读 —— 改了设置不用刷新页面就生效。
 */

import { createStore } from './store.mjs';

const store = createStore({ settings: {} });

export function initPrefs(settings = {}) {
  store.set({ settings: { ...settings } });
  return store.get('settings');
}

export function getSettings() {
  return store.get('settings') ?? {};
}

export function getSetting(key, fallback = null) {
  const value = getSettings()[key];
  return value === undefined || value === null ? fallback : value;
}

export function patchSettings(patch = {}) {
  store.set({ settings: { ...getSettings(), ...patch } });
  return getSettings();
}

export function onSettings(listener) {
  return store.subscribe((state, changed) => {
    if (changed.includes('settings')) listener(state.settings);
  });
}
