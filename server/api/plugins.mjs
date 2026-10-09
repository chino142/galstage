/**
 * 插件接口：清单查询 + 提供插件自己的浏览器文件（视图 / 样式）。
 *
 * 插件加载在启动时完成（server/plugins.mjs），这里只读 `ctx.app.plugins` 的结果。
 * 视图文件走 `/api/plugins/<名字>/<文件名>`，路径里只允许单层文件名。
 */

import { pluginContentType, readPluginFile } from '../plugins.mjs';
import { PLUGIN_HOOKS } from '../../core/plugins.mjs';

export function register(router) {
  router.get('/api/plugins', (ctx) => {
    const plugins = ctx.app.plugins ?? { loaded: [], errors: [], modules: [], views: [], styles: [] };
    const root = ctx.app.pluginRoot ?? ctx.app.dataDir ?? null;
    return ctx.json(200, {
      items: plugins.loaded ?? [],
      errors: plugins.errors ?? [],
      modules: plugins.modules ?? [],
      hooks: PLUGIN_HOOKS,
      directory: root ? `${root}${root.includes('\\') ? '\\' : '/'}plugins` : null,
    });
  });

  router.get('/api/plugins/:name/:file', (ctx) => {
    // 多用户模式下插件是主机级的（代码放 <主机目录>/plugins），所以优先用 pluginRoot
    const found = readPluginFile(ctx.app.pluginRoot ?? ctx.app.dataDir, ctx.params.name, ctx.params.file);
    if (!found) return ctx.fail(404, 'NOT_FOUND', `没有这个插件文件：${ctx.params.name}/${ctx.params.file}`);
    ctx.res.writeHead(200, { 'Content-Type': pluginContentType(found.file), 'Cache-Control': 'no-cache' });
    ctx.res.end(found.buffer);
    return undefined;
  });
}
