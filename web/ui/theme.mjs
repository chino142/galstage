/** 把设置里的界面项落到 CSS 变量上。主题切换不需要刷新页面。 */

export function resolveTheme(theme) {
  if (theme === 'light' || theme === 'dark' || theme === 'sepia') return theme;
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function applyTheme(settings = {}) {
  const root = document.documentElement;
  root.dataset.theme = resolveTheme(settings['ui.theme']);
  // 低配模式：关毛玻璃 / 背景滤镜（见 base.css 的 [data-lowfx="on"]）。
  root.dataset.lowfx = settings['ui.lowfx'] ? 'on' : 'off';
  document.body.dataset.density = settings['ui.density'] ?? 'comfortable';

  const accent = settings['ui.accent'];
  if (accent) root.style.setProperty('--st-accent', accent);

  const scale = Number(settings['ui.fontScale'] ?? 1);
  root.style.fontSize = `${(14 * scale).toFixed(2)}px`;
  applyCustomCss(settings['ui.customCss'] ?? '');
}

/**
 * 自定义 CSS：注入到 <head> 末尾的一个固定 style 里。
 * 只做「用户自己给自己写样式」这一种用法，不做任何过滤 —— 它和用户手改 DevTools
 * 的权限一样，都是本机用户自己的界面。写坏了把设置里的内容清空即可恢复。
 */
export function applyCustomCss(css) {
  const id = 'st-custom-css';
  let node = document.getElementById(id);
  const text = String(css ?? '');
  if (!text.trim()) {
    node?.remove();
    return;
  }
  if (!node) {
    node = document.createElement('style');
    node.id = id;
    document.head.append(node);
  }
  node.textContent = text;
}
