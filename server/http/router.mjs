/**
 * 极简路由器。
 *
 * 支持 `/api/characters/:id` 这种占位段。路径段先解码再比较，
 * 这样带中文或空格的 id 也能匹配上。
 * 匹配不到路径时返回 null；路径匹配到但方法不对，返回 methodNotAllowed，
 * 由上层回 405 并带上 Allow 头。
 */

function splitPath(pathname) {
  return pathname.split('/').filter(Boolean).map((seg) => {
    try {
      return decodeURIComponent(seg);
    } catch {
      return seg;
    }
  });
}

export function createRouter() {
  const routes = [];

  function add(method, pattern, handler, meta = {}) {
    const parts = pattern.split('/').filter(Boolean);
    routes.push({
      method: method.toUpperCase(),
      pattern,
      parts,
      handler,
      meta,
      paramNames: parts.filter((p) => p.startsWith(':')).map((p) => p.slice(1)),
    });
    return api;
  }

  function match(method, pathname) {
    const segments = splitPath(pathname);
    const allowed = new Set();
    for (const route of routes) {
      if (route.parts.length !== segments.length) continue;
      const params = {};
      let ok = true;
      for (let i = 0; i < segments.length; i += 1) {
        const part = route.parts[i];
        if (part.startsWith(':')) {
          params[part.slice(1)] = segments[i];
        } else if (part !== segments[i]) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      allowed.add(route.method);
      if (route.method === method || (method === 'HEAD' && route.method === 'GET')) {
        return { route, params };
      }
    }
    if (allowed.size > 0) return { methodNotAllowed: true, allowed: [...allowed] };
    return null;
  }

  const api = {
    get: (pattern, handler, meta) => add('GET', pattern, handler, meta),
    post: (pattern, handler, meta) => add('POST', pattern, handler, meta),
    put: (pattern, handler, meta) => add('PUT', pattern, handler, meta),
    patch: (pattern, handler, meta) => add('PATCH', pattern, handler, meta),
    delete: (pattern, handler, meta) => add('DELETE', pattern, handler, meta),
    match,
    list: () => routes.map(({ method, pattern, meta }) => ({ method, pattern, meta })),
    get size() {
      return routes.length;
    },
  };

  return api;
}
