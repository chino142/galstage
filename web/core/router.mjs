/**
 * 哈希路由。
 * 地址形如 `#/cards` 或 `#/cards/editor`：第一段是模块 id，第二段是可选子视图。
 * 刷新页面不会丢位置，也不需要服务端配合。
 */

export function createHashRouter({ fallback = 'cards', onChange }) {
  function parse() {
    const raw = window.location.hash.replace(/^#\/?/, '').trim();
    const [id, sub] = raw.split('/').filter(Boolean);
    return { id: id || fallback, sub: sub || null };
  }

  function go(id, { sub = null, replace = false } = {}) {
    const target = `#/${id}${sub ? `/${sub}` : ''}`;
    if (window.location.hash === target) {
      onChange(id, sub);
      return;
    }
    if (replace) window.history.replaceState(null, '', target);
    else window.location.hash = target;
  }

  function start() {
    window.addEventListener('hashchange', () => {
      const { id, sub } = parse();
      onChange(id, sub);
    });
    const { id, sub } = parse();
    onChange(id, sub);
  }

  return { start, go, current: parse };
}
